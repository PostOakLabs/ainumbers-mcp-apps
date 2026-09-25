// test-error-envelope.mjs — local, deterministic proof of the additive `request_id` envelope
// (ERROR-REGISTRY-REQUEST-ID-SPEC §3, row AICONTRACT-PART-B-1).
//
// Drives the REAL worker.mjs default export over worker.fetch (same harness as
// test-malformed-body-fastfail.mjs: lightweight local ASSETS stub backed by the committed ./data
// directory — no network egress, no live endpoint) and asserts, per spec §3:
//   1. PROTOCOL-LEVEL — a JSON-RPC error body carries `error.request_id` (a fresh uuid per
//      request), while `id` still echoes the request id / null (correlation ≠ reply addressing).
//   2. ADDITIVE-ONLY — every pre-envelope member is untouched: codes, messages, `data` shapes.
//      (The equality gates — gate-hash-ijson, gate-mcp-era, smoke-mcp — stay the authority; this
//      test pins the NEW member's presence + freshness.)
//   3. TOOL-LEVEL — the structured ijson refusal carries `structuredContent.error.request_id`
//      while `content[].text` stays BYTE-IDENTICAL to the pre-envelope shape (no request_id in
//      the text: the additive member exists only in structuredContent).
//   4. FRESHNESS — two different requests produce two different request_ids.
//
// Run: node scripts/test-error-envelope.mjs

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const DATA_DIR = join(ROOT, 'data');

function assetsFetch(url) {
  const u = new URL(url);
  const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '');
  const filePath = join(DATA_DIR, rel);
  if (!existsSync(filePath)) return new Response('Not Found', { status: 404 });
  return new Response(readFileSync(filePath), { status: 200 });
}

const env = {
  ASSETS: { fetch: async (url) => assetsFetch(typeof url === 'string' ? url : url.url) },
};
const worker = (await import('../worker.mjs')).default;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function post(body, headers = {}) {
  const req = new Request('https://mcp.ainumbers.co/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream', ...headers },
    body,
  });
  const res = await worker.fetch(req, env, { waitUntil: () => {}, passThroughOnException: () => {} });
  return { status: res.status, text: await res.text() };
}
const jsonBody = (obj, headers = {}) => post(JSON.stringify(obj), headers);

let failed = 0;
const check = (ok, label, note) => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${note ? ' — ' + note : ''}`);
  if (!ok) failed++;
};

// ── 1. Protocol-level: unparseable JSON → fast 400/-32700 with error.request_id ───────────────
console.log('▶ protocol-level error: malformed JSON body → 400/-32700 + error.request_id');
const p1 = await post('not-json-at-all{{{');
const b1 = JSON.parse(p1.text);
check(p1.status === 400, 'HTTP 400', `got ${p1.status}`);
check(b1.error?.code === -32700, 'error.code === -32700', `got ${b1.error?.code}`);
check(b1.error?.message === 'Parse error: request body is not valid JSON', 'message byte-identical');
check(b1.id === null, 'id still echoes null (reply addressing)');
check(typeof b1.error?.request_id === 'string' && UUID_RE.test(b1.error.request_id), 'error.request_id is a fresh uuid', String(b1.error?.request_id).slice(0, 18) + '…');

// ── 2. Protocol-level: unknown tool → 200/-32602 "Tool not found: …" with request_id ─────────
console.log('▶ protocol-level error: unknown tool → 200/-32602 + error.request_id (fresh per request)');
const p2 = await jsonBody({ jsonrpc: '2.0', id: 'rpc-2', method: 'tools/call', params: { name: 'definitely_not_a_tool_xyz', arguments: {} } });
const b2 = JSON.parse(p2.text);
check(p2.status === 200, 'HTTP 200 (dispatch-layer refusal)', `got ${p2.status}`);
check(b2.error?.code === -32602, 'error.code === -32602');
check(b2.error?.message === 'Tool not found: definitely_not_a_tool_xyz', 'message byte-identical ("Tool not found: " prefix preserved)');
check(b2.id === 'rpc-2', 'id echoes body.id exactly');
check(typeof b2.error?.request_id === 'string' && UUID_RE.test(b2.error.request_id), 'error.request_id present', String(b2.error?.request_id).slice(0, 18) + '…');
check(b2.error.request_id !== b1.error.request_id, 'request_id is FRESH per request (differs from case 1)');

// ── 3. Tool-level: structured ijson refusal carries request_id in structuredContent ONLY ─────
// Local harness note: a bare tools/call through worker.fetch reaches the SDK's Node transport
// shim (@hono/node-server), which answers an empty text/plain 400 on this b699960 tree BEFORE this
// row (measured identically on a pristine b699960 worktree) — the live tools/call surface is the
// post-deploy smoke's to prove. The TOOL-LAYER builder itself is reached here the same way
// gate-hash-ijson.mjs reaches it: buildServer + InMemoryTransport, initialize first, real
// tools/call — the exact code path the deployed worker runs, with requestId threaded (spec §5.2).
console.log('▶ tool-level error: non-I-JSON input → structuredContent.error.request_id, content[].text byte-identical');
{
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const { buildServer } = await import('../worker.mjs');
  const { PILOT } = await import('../pilot.mjs');
  const get = (p) => readFileSync(join(DATA_DIR, p), 'utf8');
  const glue = (await import('../worker.mjs')).widgetGlue(get('ext-apps-inline.js'));
  const manifests = {}, widgets = {};
  for (const slug of PILOT) {
    manifests[slug] = JSON.parse(get('manifests/' + slug + '.manifest.json'));
    widgets[slug] = (await import('../worker.mjs')).stripCspMeta(get('tools/' + slug + '.html')) + glue;
  }
  const data = {
    manifests, widgets,
    catalog: JSON.parse(get('mcp/catalog.json')),
    chaingraph: JSON.parse(get('chaingraph/chaingraph.json')),
    searchIndex: JSON.parse(get('search-index.json')),
    chainFixtures: JSON.parse(get('chain-fixtures.json')),
  };
  const requestId = crypto.randomUUID();
  const server = buildServer(data, { requestId });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  await clientT.start();
  const pending = new Map();
  clientT.onmessage = (msg) => { if (msg && msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); } };
  let nextId = 1;
  const rpc = (method, params) => new Promise((res) => { const id = nextId++; pending.set(id, res); clientT.send({ jsonrpc: '2.0', id, method, params }); });
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test-error-envelope', version: '1' } });
  await clientT.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const r = (await rpc('tools/call', { name: 'verify_execution_hash', arguments: { policy_parameters: { n: 9007199254740993 }, output_payload: { ok: true } } })).result;
  const err = r?.structuredContent?.error;
  check(r?.isError === true, 'result flagged isError');
  check(err?.code === -32602 && err?.data?.reason === 'ijson_violation', 'code -32602 + reason "ijson_violation" unchanged');
  check(err?.request_id === requestId, 'structuredContent.error.request_id === the request\u2019s minted id', String(err?.request_id).slice(0, 18) + '…');
  const text = r?.content?.[0]?.text ?? '';
  check(!text.includes('request_id'), 'content[].text carries NO request_id (byte-identical doctrine)', `text len ${text.length}`);
  const parsedText = JSON.parse(text);
  check(parsedText.error?.request_id === undefined && parsedText.error?.code === -32602 && parsedText.error?.data?.reason === 'ijson_violation', 'text parses to the exact pre-envelope shape');
  await clientT.close();
  await server.close();
}

// ── 4. Envelope is additive: the data-carrying protocol error keeps its data shape ────────────
console.log('▶ additivity: unsupported modern protocol version → -32022 + data{supported,requested} + request_id');
const p4 = await jsonBody(
  { jsonrpc: '2.0', id: 3, method: 'tools/list' },
  { 'Mcp-Protocol-Version': '1999-01-01' },
);
const b4 = JSON.parse(p4.text);
check(b4.error?.code === -32022, 'error.code === -32022', `got ${b4.error?.code}`);
check(Array.isArray(b4.error?.data?.supported) && b4.error?.data?.requested === '1999-01-01', 'data{supported, requested} shape unchanged');
check(UUID_RE.test(String(b4.error?.request_id)), 'error.request_id present on a data-carrying error');

console.log('');
if (failed) {
  console.error(`✗ test-error-envelope: ${failed} check(s) failed — the additive request_id envelope is broken.`);
  process.exit(1);
}
console.log('✅ test-error-envelope: request_id present in protocol-level AND tool-level error responses, fresh per request, additive-only (codes/messages/data shapes and content[].text untouched).');
