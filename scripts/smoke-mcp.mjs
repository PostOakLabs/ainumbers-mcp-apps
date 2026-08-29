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

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const URL = process.argv[2] || process.env.MCP_SMOKE_URL || 'https://mcp.ainumbers.co/mcp';
const RETRIES = Number(process.env.MCP_SMOKE_RETRIES ?? 6);
const DELAY = Number(process.env.MCP_SMOKE_DELAY_MS ?? 4000);
const TIMEOUT = Number(process.env.MCP_SMOKE_TIMEOUT_MS ?? 15000);
const PROTO = '2025-06-18';
const ACCEPT = 'application/json, text/event-stream';

// SEP-2243 routing headers. Every smoke request SENDS them, so a green smoke actually
// proves the header path end to end (and that the Cloudflare WAF forwards them).
// Mcp-Name applies only to the methods that carry a name/uri in params.
function sep2243Headers(method, params) {
  const h = { 'mcp-method': method };
  const name = (method === 'tools/call' || method === 'prompts/get') ? params?.name
             : (method === 'resources/read') ? params?.uri
             : undefined;
  if (name !== undefined) h['mcp-name'] = String(name);
  return h;
}

// POST a JSON-RPC request and STREAM the response, resolving on the first object whose id matches.
// Returns { result, error }. Throws on timeout/HTTP error/no-match-before-end.
async function call(method, params, id) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), TIMEOUT);
  let res;
  try {
    res = await fetch(URL, {
      method: 'POST', signal: controller.signal,
      headers: {
        'content-type': 'application/json', accept: ACCEPT, 'mcp-protocol-version': PROTO,
        ...sep2243Headers(method, params),
      },
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

// MCP-TOOLSLIST-PAGINATION-1: tools/list is paginated — walk the cursor to exhaustion and return
// every name. `call()` returns { result } whose `nextCursor` (when present) is echoed as
// params.cursor. A small delay between pages keeps an 12-page walk clear of the per-IP
// MCP_RATE_LIMITER window (30 req/min) that the rest of the smoke shares.
async function listAllToolNames(idBase) {
  const names = [];
  let cursor;
  for (let page = 1, id = idBase; page <= 100; page++, id++) {
    const { result, error } = await call('tools/list', cursor ? { cursor } : {}, id);
    if (error) throw new Error(`tools/list page ${page} error ${error.code}: ${error.message}`);
    const pageNames = (result?.tools ?? []).map((t) => t.name);
    if (!pageNames.length) throw new Error(`tools/list page ${page} returned no tools`);
    names.push(...pageNames);
    cursor = result?.nextCursor;
    if (!cursor) return { names, pages: page };
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('tools/list cursor walk did not terminate within 100 pages');
}

// §M1.6 dual-version window: the 2026-07-28 RC drops the mandatory `initialize` handshake. Prove
// the worker answers tools/list (and a real tools/call) WITHOUT ever calling initialize first —
// the RC path — on top of the current initialize()-first path proven below.
async function rcNoInitializePath() {
  const list = await call('tools/list', {}, 101);
  if (list.error) throw new Error(`RC-path tools/list error ${list.error.code}: ${list.error.message}`);
  const names = (list.result?.tools ?? []).map((t) => t.name);
  if (!names.includes('find_tool')) throw new Error('RC-path tools/list missing lean-core tool find_tool');
  const out = await call('tools/call', { name: 'find_tool', arguments: { query: 'reserve' } }, 102);
  if (out.error) throw new Error(`RC-path tools/call error ${out.error.code}: ${out.error.message}`);
  if (out.result?.isError) throw new Error('RC-path find_tool isError: ' + JSON.stringify(out.result.content).slice(0, 200));
  return { tools: names.length };
}

// §M1.2 named toolsets: ?toolset=reserve must expand the advertised (non-deferred) set beyond the
// 9-name lean core with reserve-domain tools, generator-emitted (data/mcp/toolsets.json).
async function toolsetProfile() {
  const profileUrl = URL + (URL.includes('?') ? '&' : '?') + 'toolset=reserve';
  const res = await fetch(profileUrl, {
    method: 'POST', headers: { 'content-type': 'application/json', accept: ACCEPT, 'mcp-protocol-version': PROTO },
    body: JSON.stringify({ jsonrpc: '2.0', id: 201, method: 'tools/list', params: {} }),
  });
  if (res.status !== 200) throw new Error(`?toolset=reserve tools/list HTTP ${res.status}`);
  const text = await res.text();
  const line = text.split('\n').find((l) => l.startsWith('data:'));
  const obj = JSON.parse((line || text).replace(/^data:\s*/, ''));
  const tools = obj.result?.tools ?? [];
  const nonDeferred = tools.filter((t) => !t.defaultConfig?.defer_loading).length;
  if (nonDeferred <= 9) throw new Error(`?toolset=reserve did not expand the advertised set (${nonDeferred} non-deferred, expected >9)`);
  return { nonDeferred };
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

// MCPVER-ECHO-FIX-1: an unsupported/bogus protocolVersion must NOT be echoed back — the server
// must respond with a version it actually implements (PROTO), never claim support it lacks.
async function versionNegotiationHonesty() {
  const bogus = '9999-01-01-not-a-real-version';
  const { result, error } = await call('initialize', {
    protocolVersion: bogus, capabilities: {}, clientInfo: { name: 'ci-smoke-negotiation', version: '1' },
  }, 4);
  if (error) throw new Error(`version-negotiation initialize JSON-RPC error ${error.code}: ${error.message}`);
  const got = result && result.protocolVersion;
  if (got === bogus) throw new Error(`server echoed unsupported protocolVersion "${bogus}" verbatim — version-negotiation regression`);
  if (!got) throw new Error('version-negotiation initialize returned no protocolVersion');
  return { requested: bogus, negotiated: got };
}

// SEP-2243 (MCP-728 §T1). Two assertions, and BOTH matter:
//   (a) a header/body MISMATCH is rejected with HTTP 400 + JSON-RPC -32020 (HeaderMismatch).
//       ⛔ Not -32602 (that is §T2's unknown-tool condition) and not -32001 (renumbered by
//       modelcontextprotocol#2907).
//   (b) a request sending NO SEP-2243 headers still works — the dual-support window. This is
//       the outage guard: it fails loudly if validation ever starts rejecting on ABSENCE.
async function sep2243HeaderValidation() {
  // (a) Mcp-Method says prompts/get, the body says tools/list.
  const bad = await fetch(URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json', accept: ACCEPT, 'mcp-protocol-version': PROTO,
      'mcp-method': 'prompts/get',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 301, method: 'tools/list', params: {} }),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  const badText = await bad.text();
  if (bad.status !== 400) {
    throw new Error(`SEP-2243 mismatch returned HTTP ${bad.status}, expected 400: ${badText.slice(0, 200)}`);
  }
  let badObj;
  try { badObj = JSON.parse(badText); } catch { throw new Error(`SEP-2243 mismatch body is not JSON: ${badText.slice(0, 200)}`); }
  if (badObj?.error?.code !== -32020) {
    throw new Error(`SEP-2243 mismatch returned code ${badObj?.error?.code}, expected -32020 (HeaderMismatch)`);
  }

  // (b) Legacy client: no SEP-2243 headers at all must still answer 200 and list tools.
  const legacy = await fetch(URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: ACCEPT },
    body: JSON.stringify({ jsonrpc: '2.0', id: 302, method: 'tools/list', params: {} }),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  const legacyText = await legacy.text();
  if (legacy.status !== 200) {
    throw new Error(`legacy (no SEP-2243 headers) tools/list returned HTTP ${legacy.status} — dual-support broken: ${legacyText.slice(0, 200)}`);
  }
  const legacyLine = legacyText.split('\n').find((l) => l.startsWith('data:'));
  const legacyObj = JSON.parse((legacyLine || legacyText).replace(/^data:\s*/, ''));
  const legacyTools = legacyObj.result?.tools?.length ?? 0;
  if (!legacyTools) throw new Error('legacy (no SEP-2243 headers) tools/list returned no tools — dual-support broken');
  return { code: badObj.error.code, legacyTools };
}

// MCP-728 §T2: a genuinely unknown mcp_name is a JSON-RPC PROTOCOL error, -32602, NOT a
// tool-result with isError:true, and NOT -32002 (an older/wrong code this WU corrects).
// MCP-500 §M1.1 regression, same call: a tool that is REGISTERED but not in the lean-core
// advertised set (defer_loading:true) must still resolve — it must NOT false-reject as
// "unknown" just because tools/list hid it behind the deferred-loading hint.
async function unknownToolErrorCode() {
  const bogus = 'definitely_not_a_real_tool_' + Date.now();
  const { result, error } = await call('tools/call', { name: bogus, arguments: {} }, 401);
  if (!error) throw new Error(`unknown tool "${bogus}" returned no JSON-RPC error (got result: ${JSON.stringify(result).slice(0, 200)}) — MCP-728 T2 requires a protocol-level error, not a tool result`);
  if (error.code !== -32602) throw new Error(`unknown tool "${bogus}" returned code ${error.code}, expected -32602`);
  if (error.code === -32002) throw new Error('unknown tool returned the retired -32002 code — MCP-728 T2 regression');

  const list = await call('tools/list', {}, 402);
  if (list.error) throw new Error(`tools/list error ${list.error.code}: ${list.error.message}`);
  const deferred = (list.result?.tools ?? []).find((t) => t.defaultConfig?.defer_loading === true);
  if (!deferred) return { unknownCode: error.code, deferredChecked: false };
  const out = await call('tools/call', { name: deferred.name, arguments: {} }, 403);
  if (out.error?.code === -32602) throw new Error(`M1.1 regression: registered-but-deferred tool "${deferred.name}" was rejected as unknown (-32602)`);
  return { unknownCode: error.code, deferredChecked: true, deferredTool: deferred.name };
}

// MCP728-T2B: an unsupported MODERN protocol-version assertion (MCP-Protocol-Version header)
// must be rejected with the FINAL spec's -32022 + HTTP 400 + structured error.data.supported/
// error.data.requested, with the request id preserved — never the SDK's generic -32000 nor a
// dropped id. Checked on BOTH regimes that used to diverge (MCP728-Q3-CONFIRM-1): the O(1)
// static fast path (initialize) and the full SDK-transport path (an unrecognized method, the
// exact server/discover repro that surfaced the bug).
async function protocolVersionRejection() {
  // ⚠ WAS '2026-07-28'. MCP728-CONFORM-FIX-2 makes that a SUPPORTED version, so keeping it here
  // would assert the worker rejects the revision it now implements — the smoke would fail the
  // deploy for doing the right thing. The rejection rule itself is unchanged; only the probe
  // version moved to one that is genuinely unsupported.
  const bad = '1900-01-01';
  const post = (id, method, params) => fetch(URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: ACCEPT, 'mcp-protocol-version': bad },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  const assertRejected = async (res, id, label) => {
    const text = await res.text();
    if (res.status !== 400) throw new Error(`${label} w/ unsupported version header returned HTTP ${res.status}, expected 400: ${text.slice(0, 200)}`);
    let obj;
    try { obj = JSON.parse(text); } catch { throw new Error(`${label} w/ unsupported version header body is not JSON: ${text.slice(0, 200)}`); }
    if (obj?.error?.code !== -32022) throw new Error(`${label} w/ unsupported version header returned code ${obj?.error?.code}, expected -32022 (MCP728-T2B regression)`);
    if (obj?.id !== id) throw new Error(`${label} w/ unsupported version header lost request id (got ${obj?.id}, expected ${id})`);
    if (!Array.isArray(obj?.error?.data?.supported) || !obj.error.data.supported.length) throw new Error(`${label} w/ unsupported version header missing error.data.supported array`);
    if (obj?.error?.data?.requested !== bad) throw new Error(`${label} w/ unsupported version header missing/wrong error.data.requested`);
    return obj;
  };
  const initObj = await assertRejected(
    await post(501, 'initialize', { protocolVersion: PROTO, capabilities: {}, clientInfo: { name: 'ci-smoke-ver', version: '1' } }),
    501, 'initialize (static fast path)',
  );
  await assertRejected(
    await post(502, 'tools/call', { name: 'list_ainumbers_tools', arguments: {} }),
    502, 'tools/call (SDK path)',
  );
  return { code: initObj.error.code };
}

// MCP728-CONFORM-FIX-2 — the 2026-07-28 rules that only a LIVE endpoint can prove.
// scripts/gate-mcp-era.mjs asserts every pre-dispatch rule offline in CI; the checks below are the
// ones that ride the SDK transport path, which fetch-to-node cannot drive under plain Node. Each
// modern-era assertion is PAIRED with a legacy control, because a fix that strands old clients is
// the outage this whole discipline exists to prevent.
async function era2026Conformance() {
  const MODERN = '2026-07-28';
  const modernMeta = {
    'io.modelcontextprotocol/protocolVersion': MODERN,
    'io.modelcontextprotocol/clientCapabilities': {},
  };
  const post = (headers, body) => fetch(URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: ACCEPT, ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  const readJson = async (res) => {
    const text = await res.text();
    if (text.startsWith('event:')) {
      const line = text.split('\n').find((l) => l.startsWith('data: '));
      if (line) return JSON.parse(line.slice(6));
    }
    try { return JSON.parse(text); } catch { throw new Error('non-JSON body: ' + text.slice(0, 200)); }
  };

  // (1) server/discover — a modern client learns versions + capabilities here, not from initialize.
  const disc = await post(
    { 'mcp-protocol-version': MODERN, 'mcp-method': 'server/discover' },
    { jsonrpc: '2.0', id: 601, method: 'server/discover', params: { _meta: modernMeta } },
  );
  if (disc.status !== 200) throw new Error(`server/discover returned HTTP ${disc.status}, expected 200`);
  const discObj = await readJson(disc);
  const r = discObj?.result;
  if (!r) throw new Error(`server/discover error ${discObj?.error?.code}: ${discObj?.error?.message}`);
  if (r.resultType !== 'complete') throw new Error(`server/discover resultType is "${r.resultType}", expected "complete"`);
  if (!Array.isArray(r.supportedVersions) || !r.supportedVersions.includes(MODERN)) {
    throw new Error('server/discover supportedVersions does not include ' + MODERN);
  }
  // SEP-1865 must be reachable WITHOUT the legacy initialize handshake.
  if (!r.capabilities?.extensions?.['io.modelcontextprotocol/ui']) {
    throw new Error('server/discover does not advertise the MCP Apps (SEP-1865) ui extension');
  }

  // (2) resultType on tools/list — "The result MUST include a resultType field."
  const tl = await post(
    { 'mcp-protocol-version': MODERN, 'mcp-method': 'tools/list' },
    { jsonrpc: '2.0', id: 602, method: 'tools/list', params: { _meta: modernMeta } },
  );
  const tlObj = await readJson(tl);
  if (tlObj?.result?.resultType !== 'complete') throw new Error(`tools/list resultType is "${tlObj?.result?.resultType}", expected "complete"`);
  const toolCount = tlObj.result.tools?.length ?? 0;
  if (toolCount === 0) throw new Error('tools/list returned no tools');

  // (3) unknown RPC method → 404 + -32601 (modern era only).
  const unk = await post(
    { 'mcp-protocol-version': MODERN, 'mcp-method': 'no/such/method' },
    { jsonrpc: '2.0', id: 603, method: 'no/such/method', params: { _meta: modernMeta } },
  );
  const unkObj = await readJson(unk);
  if (unk.status !== 404) throw new Error(`modern unknown method returned HTTP ${unk.status}, expected 404`);
  if (unkObj?.error?.code !== -32601) throw new Error(`modern unknown method returned code ${unkObj?.error?.code}, expected -32601`);

  // (3b) LEGACY CONTROL for the same shape — an old client must still get 200, never a 404.
  const unkLegacy = await post({}, { jsonrpc: '2.0', id: 604, method: 'no/such/method', params: {} });
  if (unkLegacy.status !== 200) throw new Error(`LEGACY unknown method returned HTTP ${unkLegacy.status}, expected 200 — legacy clients are being stranded`);

  // (4) DELETE → 405, and Allow must stop advertising the verb SEP-2567 removed.
  const del = await fetch(URL, { method: 'DELETE', signal: AbortSignal.timeout(TIMEOUT) });
  if (del.status !== 405) throw new Error(`DELETE returned HTTP ${del.status}, expected 405`);
  if (/DELETE/.test(del.headers.get('allow') ?? '')) throw new Error(`DELETE still advertised in Allow: ${del.headers.get('allow')}`);

  // (5) LEGACY CONTROL — a bare, header-less, _meta-less request still works.
  const bare = await post({}, { jsonrpc: '2.0', id: 605, method: 'tools/list', params: {} });
  if (bare.status !== 200) throw new Error(`LEGACY bare tools/list returned HTTP ${bare.status}, expected 200`);

  return { tools: toolCount, supported: r.supportedVersions.length };
}

// MCP-TOOLSLIST-PAGINATION-1 — the compatibility duty this row ships with, asserted LIVE:
//   (a) a NO-CURSOR tools/list returns a valid page one (resultType complete, tools non-empty,
//       nextCursor present, body comfortably under the ~200KB size that breaks thin clients);
//   (b) a cursor walk to exhaustion yields EXACTLY the full tool set — count and name-set derived
//       INDEPENDENTLY from the committed static template (SO #34: the gate recomputes its expected
//       value from the primary source, it does not trust the endpoint under test);
//   (c) every page stays under the budget;
//   (d) an invalid cursor is refused -32602 (spec Invalid params), never served page one.
async function paginationConformance() {
  const readPage = async (params, id) => {
    const res = await fetch(URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: ACCEPT, 'mcp-protocol-version': PROTO },
      body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/list', params }),
      signal: AbortSignal.timeout(TIMEOUT),
    });
    const text = await res.text();
    if (res.status !== 200) throw new Error(`tools/list (params ${JSON.stringify(params)}) HTTP ${res.status}: ${text.slice(0, 200)}`);
    const line = text.split('\n').find((l) => l.startsWith('data: '));
    return { bytes: text.length, obj: JSON.parse((line || text).replace(/^data:\s*/, '')) };
  };

  // (a) + (c) page one, no cursor
  const p1 = await readPage({}, 700);
  if (p1.obj?.result?.resultType !== 'complete') throw new Error(`page one resultType is "${p1.obj?.result?.resultType}", expected "complete"`);
  const p1Names = (p1.obj.result.tools ?? []).map((t) => t.name);
  if (!p1Names.length) throw new Error('page one returned no tools');
  if (typeof p1.obj.result.nextCursor !== 'string') throw new Error('page one carries no nextCursor — pagination regressed to a single 1.74MB reply');
  if (p1.bytes >= 200 * 1024) throw new Error(`page one body is ${p1.bytes}B — at/above the ~200KB thin-client ceiling`);

  // (b) independent expectation from the committed template
  const tplPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'mcp', 'static', 'tools-list.sse.txt');
  const tplLine = readFileSync(tplPath, 'utf8').split('\n').find((l) => l.startsWith('data: '));
  const tplTools = JSON.parse(tplLine.slice(6).replace('__OCG_ID__', '12345')).result.tools.map((t) => t.name);
  const tplSet = new Set(tplTools);

  const walked = [...p1Names];
  const pageBytes = [p1.bytes];
  let cursor = p1.obj.result.nextCursor;
  for (let page = 2, id = 701; cursor; page++, id++) {
    const p = await readPage({ cursor }, id);
    if (p.obj?.result?.resultType !== 'complete') throw new Error(`page ${page} resultType is "${p.obj?.result?.resultType}", expected "complete"`);
    if (p.bytes >= 200 * 1024) throw new Error(`page ${page} body is ${p.bytes}B — at/above the ~200KB thin-client ceiling`);
    walked.push(...(p.obj.result.tools ?? []).map((t) => t.name));
    pageBytes.push(p.bytes);
    cursor = p.obj.result.nextCursor;
    if (page > 100) throw new Error('cursor walk did not terminate within 100 pages');
    await new Promise((r) => setTimeout(r, 250));
  }
  const walkSet = new Set(walked);
  if (walked.length !== walkSet.size) throw new Error(`cursor walk returned ${walked.length} names with duplicates (${walkSet.size} unique)`);
  if (walked.length !== tplTools.length) throw new Error(`cursor walk yielded ${walked.length} tools, but the committed template carries ${tplTools.length}`);
  for (const n of tplTools) if (!walkSet.has(n)) throw new Error(`cursor walk is missing tool "${n}" (template carries it)`);
  if (walkSet.size !== tplSet.size) throw new Error(`cursor walk advertises a tool the committed template does not carry (${walkSet.size} vs ${tplSet.size} unique)`);

  // (d) invalid cursor → -32602
  const bad = await fetch(URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: ACCEPT, 'mcp-protocol-version': PROTO },
    body: JSON.stringify({ jsonrpc: '2.0', id: 790, method: 'tools/list', params: { cursor: 'v1.999999999' } }),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  const badObj = JSON.parse(await bad.text());
  if (badObj?.error?.code !== -32602) throw new Error(`invalid cursor returned ${badObj?.error ? badObj.error.code : 'a result'}, expected -32602`);

  return { pages: pageBytes.length, total: walked.length, maxPageBytes: Math.max(...pageBytes), pageOneBytes: p1.bytes, pageOneTools: p1Names.length };
}

async function exportRoundTrip() {
  // 1) Discovery — export_artifact must be registered. (Stateless: standalone request is fine.)
  //    Cursor-aware: the full set is behind the pagination walk, not any single page.
  const { names, pages } = await listAllToolNames(800);
  if (!names.includes('export_artifact')) throw new Error(`export_artifact not in tools/list (${names.length} tools over ${pages} pages)`);

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

      const vn = await versionNegotiationHonesty();
      console.log(`✓ version-negotiation honesty OK — requested "${vn.requested}" got server version "${vn.negotiated}" (not echoed)`);

      const sep = await sep2243HeaderValidation();
      console.log(`✓ SEP-2243 headers OK — mismatch rejected with HTTP 400 / ${sep.code} (HeaderMismatch); header-less legacy request still lists ${sep.legacyTools} tools`);

      const ut = await unknownToolErrorCode();
      console.log(`✓ MCP-728 T2 unknown-tool code OK — ${ut.unknownCode}` + (ut.deferredChecked ? `; deferred-but-real tool "${ut.deferredTool}" still resolves (§M1.1)` : ' (no deferred tool found to check §M1.1)'));

      const pv = await protocolVersionRejection();
      console.log(`✓ MCP728-T2B protocol-version rejection OK — HTTP 400 / ${pv.code} + data.supported/data.requested + id preserved, on both the static fast path and the SDK path`);

      const era = await era2026Conformance();
      console.log(`✓ 2026-07-28 era OK — server/discover (${era.supported} versions, SEP-1865 ui advertised), resultType on ${era.tools} tools, unknown method 404/-32601 modern + 200 legacy, DELETE 405`);

      const pg = await paginationConformance();
      console.log(`✓ MCP-TOOLSLIST-PAGINATION-1 OK — no-cursor page 1 valid (${pg.pageOneTools} tools, ${pg.pageOneBytes}B); cursor walk to exhaustion: ${pg.total} tools over ${pg.pages} pages (max page ${pg.maxPageBytes}B), full set matches the committed template; invalid cursor -32602`);

      if (process.env.MCP_SMOKE_SKIP_EXPORT === '1') {
        console.log('  (export_artifact round-trip skipped via MCP_SMOKE_SKIP_EXPORT=1)');
        process.exitCode = 0; return;
      }
      const x = await exportRoundTrip();
      console.log(`✓ export_artifact round-trip OK — xlsx blob ${x.bytes}B (PK zip), hash carried, ${x.tools} tools listed`);

      const rc = await rcNoInitializePath();
      console.log(`✓ §M1.6 RC path (no initialize) OK — tools/list + tools/call answered directly, ${rc.tools} tools listed`);

      const ts = await toolsetProfile();
      console.log(`✓ §M1.2 named toolset OK — ?toolset=reserve advertises ${ts.nonDeferred} non-deferred tools (lean core + reserve profile)`);

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
