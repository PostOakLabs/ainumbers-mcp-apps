// Post-deploy smoke test for the live MCP endpoint.
// (1) Real MCP `initialize` handshake — asserts a JSON-RPC result with serverInfo. Catches a
//     RUNTIME tool-registration throw in buildServer() (e.g. duplicate mcp_name) that 500s the
//     /mcp handshake while the rest of the worker serves (the 2026-06-19 outage class).
// (2) `export_artifact` (OCG §13): asserts it is in tools/list, then a real round-trip —
//     tools/call export_artifact { artifact, format:"xlsx" } must return an xlsx blob (PK zip)
//     with the source execution_hash carried in metadata. Proves the export tool actually runs.
//     Skip with MCP_SMOKE_SKIP_EXPORT=1.
//
// Transport note: the worker is STATELESS streamable-HTTP (new transport per request, no session)
// and answers as SSE. We therefore STREAM each response and resolve on the first JSON-RPC message
// matching our id, then abort — never block on res.text() waiting for a stream that may stay open.
// Every request has a hard timeout so the smoke can't hang.
//
// Usage:  node scripts/smoke-mcp.mjs [url]
//   url default: https://mcp.ainumbers.co/mcp (or env MCP_SMOKE_URL)
//   env: MCP_SMOKE_RETRIES (6), MCP_SMOKE_DELAY_MS (4000), MCP_SMOKE_TIMEOUT_MS (15000), MCP_SMOKE_SKIP_EXPORT.
// Exit 0 = healthy; exit 1 = broken (fails the deploy job → roll back in Cloudflare).

const URL = process.argv[2] || process.env.MCP_SMOKE_URL || 'https://mcp.ainumbers.co/mcp';
const RETRIES = Number(process.env.MCP_SMOKE_RETRIES ?? 6);
const DELAY = Number(process.env.MCP_SMOKE_DELAY_MS ?? 4000);
const TIMEOUT = Number(process.env.MCP_SMOKE_TIMEOUT_MS ?? 15000);
const PROTO = '2025-06-18';
const ACCEPT = 'application/json, text/event-stream';

// POST a JSON-RPC request and STREAM the response, resolving on the first object whose id matches.
// Returns { result, error }. Throws on timeout/HTTP error/no-match-before-end.
async function call(method, params, id) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), TIMEOUT);
  let res;
  try {
    res = await fetch(URL, {
      method: 'POST', signal: controller.signal,
      headers: { 'content-type': 'application/json', accept: ACCEPT, 'mcp-protocol-version': PROTO },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    });
  } catch (e) {
    clearTimeout(timer);
    throw new Error(`fetch failed/timed out on ${method}: ${e.message}`);
  }
  if (res.status !== 200) {
    let t = ''; try { t = await res.text(); } catch { /* ignore */ }
    clearTimeout(timer);
    throw new Error(`HTTP ${res.status} on ${method}: ${t.slice(0, 300)}`);
  }

  // Scan accumulated text for a JSON-RPC object with our id (plain JSON or SSE data: lines).
  const find = (buf) => {
    const whole = buf.trim();
    if (whole.startsWith('{')) { try { const o = JSON.parse(whole); if (o.id === id) return o; } catch { /* partial */ } }
    for (const line of buf.split('\n')) {
      if (line.startsWith('data:')) { try { const o = JSON.parse(line.slice(5).trim()); if (o.id === id) return o; } catch { /* partial */ } }
    }
    return null;
  };

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (value) buf += decoder.decode(value, { stream: true });
      const hit = find(buf);
      if (hit) { controller.abort(); clearTimeout(timer); return { result: hit.result, error: hit.error }; }
      if (done) break;
    }
  } catch (e) {
    const hit = find(buf);
    if (hit) { clearTimeout(timer); return { result: hit.result, error: hit.error }; }
    clearTimeout(timer);
    throw new Error(`stream read failed on ${method}: ${e.message}`);
  }
  clearTimeout(timer);
  throw new Error(`no JSON-RPC response for ${method} (id ${id}) before stream end. Got: ${buf.slice(0, 200)}`);
}

async function initialize() {
  const { result, error } = await call('initialize', {
    protocolVersion: PROTO, capabilities: {}, clientInfo: { name: 'ci-smoke', version: '1' },
  }, 1);
  if (error) throw new Error(`initialize JSON-RPC error ${error.code}: ${error.message}`);
  const info = result && result.serverInfo;
  if (!info || !info.name) throw new Error('unexpected initialize result');
  return info;
}

async function exportRoundTrip() {
  // 1) Discovery — export_artifact must be registered. (Stateless: standalone request is fine.)
  const list = await call('tools/list', {}, 2);
  if (list.error) throw new Error(`tools/list error ${list.error.code}: ${list.error.message}`);
  const names = (list.result?.tools ?? []).map((t) => t.name);
  if (!names.includes('export_artifact')) throw new Error(`export_artifact not in tools/list (${names.length} tools)`);

  // 2) Round-trip — minimal v0.4 artifact in, xlsx blob out.
  const execution_hash = 'sha256:smoke0000000000000000000000000000000000000000000000000000000000';
  const artifact = {
    chaingraph_version: '0.4.0', tool_id: 'ci-smoke', mandate_type: 'treasury_mandate', compute_mode: 'server',
    execution_hash, chain: { parent_hashes: [], parent_tool_ids: [], chain_depth: 0 },
    policy_parameters: { smoke: true }, output_payload: { verdict: 'OK', value: 42 }, compliance_flags: [],
  };
  const out = await call('tools/call', { name: 'export_artifact', arguments: { artifact, format: 'xlsx' } }, 3);
  if (out.error) throw new Error(`tools/call error ${out.error.code}: ${out.error.message}`);
  const r = out.result;
  if (r?.isError) throw new Error('export_artifact isError: ' + JSON.stringify(r.content).slice(0, 300));
  const sc = r?.structuredContent;
  if (!sc?.bytes_base64) throw new Error('export_artifact returned no bytes_base64: ' + JSON.stringify(r).slice(0, 300));
  const bytes = Buffer.from(sc.bytes_base64, 'base64');
  if (!(bytes[0] === 0x50 && bytes[1] === 0x4b)) throw new Error('export_artifact xlsx is not a ZIP (no PK magic)');
  if (sc.metadata?.execution_hash !== execution_hash) throw new Error('export_artifact metadata execution_hash mismatch');
  return { tools: names.length, bytes: bytes.length };
}

(async () => {
  let lastErr;
  for (let i = 1; i <= RETRIES; i++) {
    try {
      const info = await initialize();
      console.log(`✓ /mcp initialize OK — ${info.name} v${info.version} (${URL})`);
      if (process.env.MCP_SMOKE_SKIP_EXPORT === '1') {
        console.log('  (export_artifact round-trip skipped via MCP_SMOKE_SKIP_EXPORT=1)');
        process.exitCode = 0; return;
      }
      const x = await exportRoundTrip();
      console.log(`✓ export_artifact round-trip OK — xlsx blob ${x.bytes}B (PK zip), hash carried, ${x.tools} tools listed`);
      process.exitCode = 0; return;
    } catch (e) {
      lastErr = e;
      console.error(`  attempt ${i}/${RETRIES} failed: ${e.message}`);
      if (i < RETRIES) await new Promise((r) => setTimeout(r, DELAY));
    }
  }
  console.error(`\n✗ /mcp smoke test FAILED after ${RETRIES} attempts: ${lastErr && lastErr.message}`);
  console.error('  Either the MCP handshake is broken (tool-registration throw in buildServer()) or the');
  console.error('  export_artifact round-trip failed. Roll back in Cloudflare → ainumbers-mcp → Deployments.');
  process.exit(1);
})();
