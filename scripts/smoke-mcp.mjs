// Post-deploy smoke test for the live MCP endpoint.
// Performs a real MCP `initialize` handshake against the deployed worker and asserts
// a valid JSON-RPC result with serverInfo. This catches the ONE class of failure the
// build/bundle dry-run cannot: a RUNTIME tool-registration throw in buildServer()
// (e.g. a duplicate mcp_name / pilot-vs-node collision) that 500s the /mcp handshake
// while the rest of the worker still serves. That outage shipped twice through a green
// CI (2026-06-19) because "bundle compiles" and "/mcp initializes" are different things.
//
// Usage:  node scripts/smoke-mcp.mjs [url]
//   url default: https://mcp.ainumbers.co/mcp  (or env MCP_SMOKE_URL)
//   env: MCP_SMOKE_RETRIES (default 6), MCP_SMOKE_DELAY_MS (default 4000) — for edge propagation.
// Exit 0 = handshake OK; exit 1 = broken (fails the deploy job → alert; roll back in Cloudflare).

const URL = process.argv[2] || process.env.MCP_SMOKE_URL || 'https://mcp.ainumbers.co/mcp';
const RETRIES = Number(process.env.MCP_SMOKE_RETRIES ?? 6);
const DELAY = Number(process.env.MCP_SMOKE_DELAY_MS ?? 4000);

// streamable-http may answer as SSE ("event: message\ndata: {json}") or plain JSON.
function parseRpc(text) {
  const t = text.trim();
  if (t.startsWith('{')) return JSON.parse(t);
  const line = t.split('\n').find((l) => l.startsWith('data:'));
  if (!line) throw new Error('no JSON-RPC payload in response: ' + t.slice(0, 200));
  return JSON.parse(line.slice(5).trim());
}

async function attempt() {
  const res = await fetch(URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'ci-smoke', version: '1' } },
    }),
  });
  const text = await res.text();
  if (res.status !== 200) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  const rpc = parseRpc(text);
  if (rpc.error) throw new Error(`JSON-RPC error ${rpc.error.code}: ${rpc.error.message}`);
  const info = rpc.result && rpc.result.serverInfo;
  if (!info || !info.name) throw new Error(`unexpected initialize result: ${text.slice(0, 300)}`);
  return info;
}

(async () => {
  let lastErr;
  for (let i = 1; i <= RETRIES; i++) {
    try {
      const info = await attempt();
      console.log(`✓ /mcp initialize OK — ${info.name} v${info.version} (${URL})`);
      process.exit(0);
    } catch (e) {
      lastErr = e;
      console.error(`  attempt ${i}/${RETRIES} failed: ${e.message}`);
      if (i < RETRIES) await new Promise((r) => setTimeout(r, DELAY));
    }
  }
  console.error(`\n✗ /mcp smoke test FAILED after ${RETRIES} attempts: ${lastErr && lastErr.message}`);
  console.error('  The worker deployed but the MCP handshake is broken — almost certainly a tool-registration');
  console.error('  throw in buildServer() (e.g. a duplicate mcp_name). Roll back in Cloudflare → ainumbers-mcp → Deployments.');
  process.exit(1);
})();
