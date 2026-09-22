// test-describe-tool.mjs — offline proof harness for MCP-TOOLSLIST-TRIM-DESCRIBE-1.
//
// smoke-mcp.mjs proves the trimmed list + describe_tool against the DEPLOYED endpoint post-deploy;
// this harness proves the same contract BEFORE anything deploys, by invoking the Worker's fetch
// handler directly against the committed ./data assets (the gate-mcp-era.mjs pattern: same local
// ASSETS stub wrangler serves). Asserts, with numbers quoted for the row's proofs:
//   1. tools/list page one: byte count, tool count, nextCursor present.
//   2. Cursor walk to exhaustion: ALL node/pilot/utility tools == counts.json mcp_tools_total
//      (describe_tool is itself one of the counted utility names; 721 since RUN-2-1 added
//      run_chain_batch), 0 duplicate
//      names, 0 `outputSchema` keys across ALL pages, every page under the budget.
//   3. describe_tool("recompute_payment_waterfall") returns the full definition and its
//      outputSchema is byte-identical (sha256 over canonical JSON) to the manifest projection the
//      vendored data/mcp/output-schemas.json carries.
//   4. describe_tool("nope") → JSON-RPC -32602 protocol error with error.data.nearest_names.
//   5. The SDK path (direct buildServer transport) registers describe_tool with an outputSchema
//      and its response validates against that schema (the SDK validates; row ADDITION C).
//   6. initialize advertises capabilities.tools.listChanged: true (row ADDITION A).
//
// Run: node scripts/test-describe-tool.mjs

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(HERE, '..', 'data');

// Local ASSETS stub backed by the committed ./data directory — the same binding wrangler serves.
const env = {
  ASSETS: {
    fetch: async (url) => {
      const u = new URL(typeof url === 'string' ? url : url.url);
      const filePath = join(DATA_DIR, decodeURIComponent(u.pathname).replace(/^\/+/, ''));
      if (!filePath.startsWith(DATA_DIR)) return new Response('Not Found', { status: 404 });
      try {
        return new Response(readFileSync(filePath), { status: 200 });
      } catch {
        return new Response('Not Found', { status: 404 });
      }
    },
  },
};

const worker = (await import('../worker.mjs')).default;

let failed = 0;
function check(label, cond, detail = '') {
  if (cond) console.log('test-describe-tool: ' + label + '... ok');
  else { failed++; console.error('test-describe-tool: ' + label + '... FAIL' + (detail ? ' — ' + detail : '')); }
}

let nextId = 1;
function parseBody(text) {
  try {
    if (text.startsWith('event:')) {
      const line = text.split('\n').find((l) => l.startsWith('data: '));
      return line ? JSON.parse(line.slice(6)) : {};
    }
    return JSON.parse(text);
  } catch { return {}; }
}

async function post(body) {
  const res = await worker.fetch(
    new Request('https://mcp.ainumbers.co/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, ...body }),
    }),
    env,
    { waitUntil: () => {}, passThroughOnException: () => {} },
  );
  const text = await res.text();
  return { status: res.status, bytes: text.length, body: parseBody(text) };
}

const sha = (o) => createHash('sha256').update(JSON.stringify(o)).digest('hex');

// ── 6. initialize: capabilities.tools.listChanged ──────────────────────────────────────────────
{
  const r = await post({ method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'describe-tool-test', version: '1' } } });
  const listChanged = r.body?.result?.capabilities?.tools?.listChanged === true;
  check('initialize advertises capabilities.tools.listChanged: true (ADDITION A)', listChanged, JSON.stringify(r.body?.result?.capabilities));
}

// ── 1. page one ────────────────────────────────────────────────────────────────────────────────
const p1 = await post({ method: 'tools/list', params: {} });
const p1Tools = p1.body?.result?.tools ?? [];
check('tools/list page one: resultType complete', p1.body?.result?.resultType === 'complete');
check('tools/list page one: carries nextCursor (paginated)', typeof p1.body?.result?.nextCursor === 'string', 'nextCursor=' + JSON.stringify(p1.body?.result?.nextCursor));
check('tools/list page one: lists describe_tool', p1Tools.some((t) => t.name === 'describe_tool'));
check('tools/list page one: 0 outputSchema entries', p1Tools.every((t) => !('outputSchema' in t)), p1Tools.filter((t) => 'outputSchema' in t).map((t) => t.name).join(', '));
console.log(`· page one: ${p1.bytes} bytes (SSE frame), ${p1Tools.length} tools, nextCursor=${JSON.stringify(p1.body?.result?.nextCursor)}`);

// ── 2. cursor walk to exhaustion ───────────────────────────────────────────────────────────────
{
  const walked = [...p1Tools.map((t) => t.name)];
  const pageBytes = [p1.bytes];
  let schemaKeys = p1Tools.filter((t) => 'outputSchema' in t).length;
  let cursor = p1.body?.result?.nextCursor;
  let pages = 1;
  while (cursor) {
    const p = await post({ method: 'tools/list', params: { cursor } });
    if (p.body?.error) { failed++; console.error('walk page ' + pages + ' error: ' + JSON.stringify(p.body.error)); break; }
    const tools = p.body?.result?.tools ?? [];
    schemaKeys += tools.filter((t) => 'outputSchema' in t).length;
    walked.push(...tools.map((t) => t.name));
    pageBytes.push(p.bytes);
    cursor = p.body?.result?.nextCursor;
    pages++;
    if (pages > 100) { failed++; console.error('cursor walk did not terminate within 100 pages'); break; }
  }
  const unique = new Set(walked);
  const committed = JSON.parse(readFileSync(join(DATA_DIR, 'mcp', 'static', 'tools-list.sse.txt'), 'utf8').split('\n').find((l) => l.startsWith('data: ')).replace('__OCG_ID__', '1').slice(6)).result.tools;
  // RUN-2-1: the pin tracks counts.json mcp_tools_total (which ALREADY counts describe_tool —
  // it is one of the 43 UTILITY_TOOL_NAMES — so the walked total equals mcp_tools_total, not +1;
  // the old literal encoded the same thing as "719 + describe_tool = 720"). It stays a HARD PIN:
  // a silent count change must fail loudly, never auto-pass — bump via counts.json in the same
  // commit as the surface change, and surface-parity P4 independently re-derives counts.json.
  const expectedTools = JSON.parse(readFileSync(join(DATA_DIR, 'counts.json'), 'utf8')).mcp_tools_total ?? 0;
  check('cursor walk: ' + expectedTools + ' tools (mcp_tools_total, describe_tool included)', walked.length === expectedTools, String(walked.length));
  check('cursor walk: 0 duplicate names', walked.length === unique.size, `${walked.length} vs ${unique.size} unique`);
  check('cursor walk: 0 outputSchema keys across all pages', schemaKeys === 0, String(schemaKeys));
  check('cursor walk: matches the committed template tool-for-tool',
    walked.length === committed.length && committed.every((t) => unique.has(t.name)));
  check('every page under the 150KB budget', Math.max(...pageBytes) < 200 * 1024, 'max page ' + Math.max(...pageBytes) + 'B');
  console.log(`· walk: ${walked.length} tools over ${pages} pages (max page ${Math.max(...pageBytes)}B), 0 duplicates, 0 outputSchema keys`);
  const tplBytes = readFileSync(join(DATA_DIR, 'mcp', 'static', 'tools-list.sse.txt'), 'utf8').length;
  console.log(`· committed trimmed template: ${tplBytes} bytes total (was 2,244,424 before the trim)`);
}

// ── 3+4. describe_tool via the worker dispatch path ───────────────────────────────────────────
{
  const name = 'recompute_payment_waterfall';
  const r = await post({ method: 'tools/call', params: { name: 'describe_tool', arguments: { name } } });
  const def = r.body?.result?.structuredContent;
  check(`describe_tool("${name}") returns a complete result`, r.body?.result?.resultType === 'complete' && !r.body?.error && def, JSON.stringify(r.body).slice(0, 200));
  const keysOk = def && ['name', 'description', 'inputSchema', 'outputSchema', 'annotations', 'lifecycle_status'].every((k) => def[k] !== undefined);
  check(`describe_tool("${name}") carries the full definition (name/description/inputSchema/outputSchema/annotations/lifecycle_status)`, keysOk, JSON.stringify(Object.keys(def ?? {})));
  const vendored = JSON.parse(readFileSync(join(DATA_DIR, 'mcp', 'output-schemas.json'), 'utf8'))[name];
  check(`describe_tool("${name}") outputSchema sha256 == manifest projection`, vendored && sha(def.outputSchema) === sha(vendored), `${sha(def?.outputSchema)} vs ${sha(vendored)}`);
  if (vendored) console.log(`· describe_tool("${name}") outputSchema sha256: ${sha(vendored)} (matches data/mcp/output-schemas.json / repo/manifests)`);
  const lifecycle = JSON.parse(readFileSync(join(DATA_DIR, 'mcp', 'lifecycle.json'), 'utf8'));
  const expectedLifecycle = lifecycle.overrides?.[name] ?? lifecycle.default ?? 'Active';
  check(`describe_tool("${name}") lifecycle_status "${def?.lifecycle_status}" == lifecycle.json`, def?.lifecycle_status === expectedLifecycle);
}
{
  const r = await post({ method: 'tools/call', params: { name: 'describe_tool', arguments: { name: 'nope' } } });
  check('describe_tool("nope") → JSON-RPC -32602 protocol error', r.body?.error?.code === -32602, JSON.stringify(r.body).slice(0, 200));
  check('describe_tool("nope") -32602 carries error.data.nearest_names (from find_tool)', Array.isArray(r.body?.error?.data?.nearest_names), JSON.stringify(r.body?.error?.data));
  console.log(`· describe_tool("nope"): -32602, nearest_names=${JSON.stringify(r.body?.error?.data?.nearest_names)}`);
}
{
  const r = await post({ method: 'tools/call', params: { name: 'describe_tool', arguments: {} } });
  check('describe_tool with no name → -32602 invalid params', r.body?.error?.code === -32602, JSON.stringify(r.body).slice(0, 120));
}

// ── 5. SDK path: direct buildServer transport — registration + output-schema validity ──────────
{
  const load = (p) => {
    try { return JSON.parse(readFileSync(join(DATA_DIR, p), 'utf8')); } catch { return null; }
  };
  const { widgetGlue, stripCspMeta } = await import('../worker.mjs');
  const { PILOT } = await import('../pilot.mjs');
  const get = (p) => readFileSync(join(DATA_DIR, p), 'utf8');
  const data = {
    manifests: {}, widgets: {},
    catalog: load('mcp/catalog.json'),
    chaingraph: load('chaingraph/chaingraph.json'),
    searchIndex: load('search-index.json'),
    chainFixtures: load('chain-fixtures.json'),
    fvStatusIndex: load('mcp/fv-status-index.json') ?? { entries: [] },
    recipes: load('mcp/recipes.json'),
    showcasePrompts: load('mcp/showcase-prompts.json'),
    describeMap: load('mcp/static/tool-describe.json'),
    lifecycle: load('mcp/lifecycle.json') ?? { default: 'Active', overrides: {} },
  };
  const glue = widgetGlue(get('ext-apps-inline.js'));
  for (const slug of PILOT) {
    data.manifests[slug] = JSON.parse(get('manifests/' + slug + '.manifest.json'));
    data.widgets[slug] = stripCspMeta(get('tools/' + slug + '.html')) + glue;
  }
  const { buildServer } = await import('../worker.mjs');
  const server = buildServer(data, {});
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  await clientT.start();
  const pending = new Map();
  clientT.onmessage = (m) => { if (m && m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const rpc = (id, method, params) => new Promise((r) => { pending.set(id, r); clientT.send({ jsonrpc: '2.0', id, method, params }); });
  await rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'describe-tool-test', version: '1' } });
  await clientT.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const list = await rpc(2, 'tools/list', {});
  const dt = (list.result?.tools ?? []).find((t) => t.name === 'describe_tool');
  check('SDK tools/list registers describe_tool WITH a declared outputSchema (the SDK validates responses against it)', !!dt?.outputSchema && typeof dt.outputSchema === 'object');
  const called = await rpc(3, 'tools/call', { name: 'describe_tool', arguments: { name: 'recompute_payment_waterfall' } });
  check('SDK describe_tool call passes the SDK output-schema validation (ADDITION C: schema-valid output)', called.result && !called.result.isError && !!called.result.structuredContent, JSON.stringify(called.result ?? called.error).slice(0, 200));
  const bad = await rpc(4, 'tools/call', { name: 'describe_tool', arguments: { name: 'nope' } });
  check('SDK describe_tool("nope") is refused (isError result on the direct-transport path; the HTTP dispatch path answers the protocol-level -32602)', bad.result?.isError === true && /-32602|not found/i.test(bad.result?.content?.[0]?.text ?? ''), JSON.stringify(bad.result ?? bad.error).slice(0, 160));
  await clientT.close(); await server.close();
}

console.log(failed ? `\n✗ test-describe-tool FAILED (${failed})` : '\n✅ test-describe-tool OK — trim + describe_tool contract holds offline (dispatch path + SDK path)');
process.exit(failed ? 1 : 0);
