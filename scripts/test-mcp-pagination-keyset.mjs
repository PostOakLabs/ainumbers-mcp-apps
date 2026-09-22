// test-mcp-pagination-keyset.mjs — RUN-4-1 selftest (2026-09-22)
//
// Covers the RUN-4-1 delta over the shipped MCP-TOOLSLIST-PAGINATION-2 surface:
//   (1) DEFAULT-SHAPE COMPAT — a no-cursor tools/list page one is BYTE-IDENTICAL to the shipped
//       algorithm's frame (same v1 token, same slice, NO "total" key): the RUN-4-1 fence.
//   (2) FULL CURSOR WALK — echoing nextCursor to exhaustion yields exactly the template's ordered
//       tool set (no skip/dup); every continuation page echoes "total" (the row's total echo);
//       page one carries no total and issues a v1 token, continuations issue v2 keyset tokens.
//   (3) INVALID/STALE TOKENS — garbage, unknown v2 ids and non-boundary v1 offsets are refused
//       -32602 (never served page one), matching the shipped invalid-token contract.
//   (4) CURSOR STABILITY ACROSS A SYNTHETIC REGEN/REORDER — the row's gate: a v2 token issued
//       against one template still anchors the SAME element against a regenerated template with
//       (a) a synthetic insertion at the front (all byte offsets shifted) and (b) a synthetic
//       reorder (page-one head element moved to the tail). The same drift REFUSES the old v1
//       offset token — demonstrating the silent-page-shift class v2 closes.
//   (5) SEARCH SURFACE — list_ainumbers_tools gains cursor pagination (keyset on tool name) +
//       total echo, with the shipped default rows (count/tools) unchanged (additive keys only).
//   (6) SINGLE-PAGE LISTS — resources/list and prompts/list keep byte-identical full frames.
//
// Runs the real worker.mjs default export against a lightweight local ASSETS stub backed by the
// committed ./data directory (same harness as test-mcp-accept-negotiation.mjs). Mutated templates
// in (4) are IN-MEMORY strings only — no vendored byte is touched. No network egress.
//
// Usage: node scripts/test-mcp-pagination-keyset.mjs

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const DATA_DIR = join(ROOT, 'data');

let passed = 0;
const fails = [];
function check(name, ok, detail) {
  if (ok) { passed++; console.log('  ok ' + name); }
  else { fails.push(name + (detail ? ' — ' + detail : '')); console.error('  FAIL ' + name + (detail ? ' — ' + detail : '')); }
}

// ── assets stub: serves the committed data/ dir, with per-file OVERRIDES (mutated templates) ──
function makeEnv(overrides = {}) {
  const assetsFetch = (url) => {
    const u = new URL(typeof url === 'string' ? url : url.url);
    const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '');
    if (Object.prototype.hasOwnProperty.call(overrides, rel)) return new Response(overrides[rel], { status: 200 });
    const filePath = join(DATA_DIR, rel);
    try { return new Response(readFileSync(filePath), { status: 200 }); }
    catch { return new Response('Not Found', { status: 404 }); }
  };
  return { ASSETS: { fetch: assetsFetch } };
}
const CTX = { waitUntil: () => {}, passThroughOnException: () => {} };

let nextId = 1;
// The SDK transport (tools/call path) refuses requests with no/unknown mcp-protocol-version
// ("Bad Request: Unsupported protocol version") — send the smoke's PROTO on every request.
// Accept stays JSON-only so static list pages come back as bare JSON-RPC bodies; the SSE framing
// is asserted separately as the byte-compat control below.
async function postMcp(worker, env, method, params, headers) {
  const req = new Request('https://mcp.ainumbers.co/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'mcp-protocol-version': '2025-06-18',
      ...(headers ?? {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params: params ?? {} }),
  });
  const res = await worker.fetch(req, env, CTX);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* left null — callers assert on status/raw text */ }
  return { status: res.status, text, json };
}

// ── independent template reader (mirrors the gate pattern: derive expectations from the SOURCE,
//    never from the endpoint under test) ──
function readTemplate(file) {
  return readFileSync(join(DATA_DIR, 'mcp', 'static', file), 'utf8');
}
// Full-array walk: ordered element ids + per-element start offsets (string/escape/depth-aware —
// same discipline as worker.mjs; page budget 150000 mirrors LIST_PAGE_MAX_BYTES).
function walkTemplate(tpl, key) {
  const marker = '"' + key + '":[';
  const arrayStart = tpl.indexOf(marker) + marker.length;
  const starts = [];
  let depth = 0, inStr = false, esc = false, elemStart = -1;
  for (let i = arrayStart; i < tpl.length; i++) {
    const c = tpl[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') { inStr = true; continue; }
    if (c === '{' || c === '[') { if (depth === 0) elemStart = i; depth++; continue; }
    if (c === '}' || c === ']') {
      if (c === ']' && depth === 0) break;
      depth--;
      if (depth === 0 && c === '}') starts.push(elemStart);
    }
  }
  const names = starts.map((at) => {
    const m = tpl.slice(at, at + 200).match(/^\{"name":"([^"]+)"/);
    if (m) return m[1];
    const u = tpl.slice(at, at + 200).match(/^\{"uri":"([^"]+)"/);
    return u ? u[1] : null;
  });
  return { arrayStart, starts, names };
}
// The SHIPPED page-one algorithm (MCP-TOOLSLIST-PAGINATION-2 as of 290cf71), reimplemented here
// byte-for-byte so the default reply can be asserted identical. LIST_PAGE_MAX_BYTES = 150000,
// LIST_CURSOR_PREFIX = 'v1.' (hardcoded mirrors — the worker does not export them).
function shippedPageOneFrame(tpl, key, idJson) {
  const PAGE_MAX = 150000;
  const marker = '"' + key + '":[';
  const arrayStart = tpl.indexOf(marker) + marker.length;
  let depth = 0, inStr = false, esc = false, elemStart = -1, end = -1, next = -1;
  for (let i = arrayStart; i < tpl.length; i++) {
    const c = tpl[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') { inStr = true; continue; }
    if (c === '{' || c === '[') { if (depth === 0) elemStart = i; depth++; continue; }
    if (c === '}' || c === ']') {
      if (c === ']' && depth === 0) break;
      depth--;
      if (depth === 0 && c === '}') {
        const elemEnd = i + 1;
        if (tpl[i + 1] !== ',') break;
        if (end >= 0 && elemEnd - arrayStart > PAGE_MAX) { next = elemStart; break; }
        end = elemEnd;
      }
    }
  }
  if (next < 0 || !tpl.endsWith(']}}\n\n')) throw new Error('expected a multi-page template for the shipped page-one recomputation');
  const frame = tpl.slice(0, arrayStart) + tpl.slice(arrayStart, end) + '],"nextCursor":' + JSON.stringify('v1.' + next) + '}}\n\n';
  return frame.replace('__OCG_ID__', () => idJson);
}

const env = makeEnv();
const worker = (await import('../worker.mjs')).default;

console.log('RUN-4-1 selftest — keyset cursor hardening + total echo');
console.log('(1) default-shape compat (the fence: no default-shape changes)');

const TPL = readTemplate('tools-list.sse.txt');
const tmpl = walkTemplate(TPL, 'tools');
const myId = nextId;
const p1 = await postMcp(worker, env, 'tools/list', {});
check('page one answers 200 JSON-RPC', p1.status === 200 && p1.json?.result?.resultType === 'complete');
const res1 = p1.json.result;
check('page one keys are exactly the shipped set [resultType, tools, nextCursor]',
  JSON.stringify(Object.keys(res1)) === JSON.stringify(['resultType', 'tools', 'nextCursor']),
  JSON.stringify(Object.keys(res1)));
check('page one carries NO total (fence)', !('total' in res1));
check('page one issues a v1 offset token (shipped grammar)', typeof res1.nextCursor === 'string' && res1.nextCursor.startsWith('v1.'),
  String(res1.nextCursor).slice(0, 12));
const expectedP1 = shippedPageOneFrame(TPL, 'tools', JSON.stringify(myId));
// Content negotiation (MCP-CONTENT-NEGOTIATION-FIX-1): JSON-only Accept gets the SSE frame's data
// line as a bare body; the SSE framing is asserted as the byte-compat control right below.
const ssePrefixLen = TPL.indexOf('{"jsonrpc"');
check('page one is BYTE-IDENTICAL to the shipped MCP-TOOLSLIST-PAGINATION-2 page (JSON framing)',
  p1.text === expectedP1.slice(ssePrefixLen, -2),
  'response ' + p1.text.length + 'B vs shipped-recomputed ' + (expectedP1.length - ssePrefixLen - 2) + 'B');
{
  const pSse = await postMcp(worker, env, 'tools/list', {}, { Accept: 'text/event-stream' });
  const expectedSse = shippedPageOneFrame(TPL, 'tools', JSON.stringify(pSse.json ? pSse.json.id : nextId - 1));
  check('page one is BYTE-IDENTICAL in SSE framing too (compat control)',
    pSse.status === 200 && pSse.text === expectedSse,
    'response ' + pSse.text.length + 'B vs shipped-recomputed ' + expectedSse.length + 'B');
}

console.log('(2) full cursor walk to exhaustion (v2 continuations + total echo)');
const walked = [...(res1.tools ?? []).map((t) => t.name)];
const pageTotals = [];
let cursor = res1.nextCursor;
let issuedV2 = false, allContinuationsHaveTotal = true, lastPageHadNoNext = false;
for (let page = 2; page <= 100 && cursor; page++) {
  const p = await postMcp(worker, env, 'tools/list', { cursor });
  if (p.json?.error) { fails.push('walk page ' + page + ' errored: ' + JSON.stringify(p.json.error)); break; }
  const r = p.json.result;
  if (r.nextCursor && r.nextCursor.startsWith('v2.')) issuedV2 = true;  // tokens ISSUED on continuations
  if (!('total' in r)) allContinuationsHaveTotal = false;
  pageTotals.push(r.total);
  walked.push(...(r.tools ?? []).map((t) => t.name));
  cursor = r.nextCursor;
  if (!cursor) lastPageHadNoNext = true;
}
check('continuation pages issue v2 keyset tokens (incl. the final page, echoed and resolved)', issuedV2);
check('every continuation page echoes total (RUN-4-1 total echo)', allContinuationsHaveTotal);
check('every continuation page total === template element count (' + tmpl.names.length + ')', pageTotals.length > 0 && pageTotals.every((t) => t === tmpl.names.length), JSON.stringify([...new Set(pageTotals)]));
check('final page omits nextCursor', lastPageHadNoNext);
check('walk yields no duplicates', new Set(walked).size === walked.length, walked.length + ' rows, ' + new Set(walked).size + ' unique');
check('walk order === template order, complete (' + tmpl.names.length + ' tools)', walked.length === tmpl.names.length && walked.every((n, i) => n === tmpl.names[i]),
  'walked ' + walked.length + ' vs template ' + tmpl.names.length);

console.log('(3) invalid / stale tokens refused -32602');
for (const [label, cur] of [['garbage token', 'garbage'], ['unknown v2 id', 'v2.no_such_tool_zz'], ['non-boundary v1 offset', 'v1.5'], ['v2 empty id', 'v2.']]) {
  const p = await postMcp(worker, env, 'tools/list', { cursor: cur });
  check('cursor ' + label + ' → 400/-32602', p.status === 400 && p.json?.error?.code === -32602,
    'status=' + p.status + ' code=' + p.json?.error?.code);
}

console.log('(4) cursor stability across a synthetic regen / reorder (the row gate)');
// Tokens are ISSUED against the committed template (worker/env) and REPLAYED against regenerated
// templates served by fresh worker instances (module-level template caches demand one instance
// per template). (4a) synthetic INSERTION at the front — every downstream byte offset shifts;
// (4b) synthetic REORDER — the head element moved to the tail. The v2 id token must anchor the
// SAME element both times; the v1 offset token must be REFUSED (not silently re-anchored).
const anchorNameOf = async (instance, envx) => {
  const a1 = await postMcp(instance, envx, 'tools/list', {});
  const a2 = await postMcp(instance, envx, 'tools/list', { cursor: a1.json.result.nextCursor });
  const v2 = a2.json.result.nextCursor;
  const a3 = await postMcp(instance, envx, 'tools/list', { cursor: v2 });
  return { v1: a1.json.result.nextCursor, v2, anchor: a3.json.result.tools[0].name };
};
const A = await anchorNameOf(worker, env);

const synthetic = '{"name":"aaa_zz_synthetic_probe","title":"Synthetic probe","description":"RUN-4-1 selftest synthetic insertion","inputSchema":{"type":"object"}}';
const insertedTpl = TPL.replace('"tools":[', '"tools":[' + synthetic + ',');
const workerB = (await import('../worker.mjs?run41-insert')).default;
const envB = makeEnv({ 'mcp/static/tools-list.sse.txt': insertedTpl });
const rb1 = await postMcp(workerB, envB, 'tools/list', { cursor: A.v1 });
check('(4a) stale v1 offset token after insertion is REFUSED (never silently re-anchored)',
  rb1.status === 400 && rb1.json?.error?.code === -32602,
  'status=' + rb1.status + ' code=' + rb1.json?.error?.code);
const rb2 = await postMcp(workerB, envB, 'tools/list', { cursor: A.v2 });
check('(4a) v2 token after insertion anchors the SAME element ("' + A.anchor + '")',
  rb2.json?.result?.tools?.[0]?.name === A.anchor,
  'anchored ' + A.anchor + ' got ' + rb2.json?.result?.tools?.[0]?.name);
check('(4a) continuation page echoes the REGENERATED total (' + (tmpl.names.length + 1) + ')',
  rb2.json?.result?.total === tmpl.names.length + 1, String(rb2.json?.result?.total));
{
  const insTmpl = walkTemplate(insertedTpl, 'tools');
  const rows = [...(rb1.status === 200 ? rb1.json.result.tools : []).map((t) => t.name)];
  let cur = rb1.status === 200 ? rb1.json.result.nextCursor : undefined;
  if (cur === undefined) {
    const own1 = await postMcp(workerB, envB, 'tools/list', {});
    rows.length = 0;
    rows.push(...(own1.json.result.tools ?? []).map((t) => t.name));
    cur = own1.json.result.nextCursor;
  }
  for (let page = 2; page <= 100 && cur; page++) {
    const p = await postMcp(workerB, envB, 'tools/list', { cursor: cur });
    rows.push(...(p.json.result?.tools ?? []).map((t) => t.name));
    cur = p.json.result?.nextCursor;
  }
  check('(4a) full walk on the regenerated template: complete, order intact, probe exactly once',
    rows.length === insTmpl.names.length && rows.every((n, i) => n === insTmpl.names[i]) &&
    rows.filter((n) => n === 'aaa_zz_synthetic_probe').length === 1,
    'rows=' + rows.length + ' expected=' + insTmpl.names.length);
}

const firstElemStart = tmpl.starts[0];
const firstElemEnd = tmpl.starts[1] - 1; // up to (not incl.) the separating comma
const movedElem = TPL.slice(firstElemStart, firstElemEnd);
const reorderedTpl = TPL.slice(0, firstElemStart) + TPL.slice(firstElemEnd) // drop the head element + comma
  .slice(0, -']}}\n\n'.length) + ',' + movedElem + ']}}\n\n';               // re-append it at the tail
const workerC = (await import('../worker.mjs?run41-reorder')).default;
const envC = makeEnv({ 'mcp/static/tools-list.sse.txt': reorderedTpl });
const rc1 = await postMcp(workerC, envC, 'tools/list', { cursor: A.v1 });
check('(4b) stale v1 offset token after reorder is REFUSED (never silently re-anchored)',
  rc1.status === 400 && rc1.json?.error?.code === -32602,
  'status=' + rc1.status + ' code=' + rc1.json?.error?.code);
const rc2 = await postMcp(workerC, envC, 'tools/list', { cursor: A.v2 });
check('(4b) v2 token after reorder anchors the SAME element ("' + A.anchor + '")',
  rc2.json?.result?.tools?.[0]?.name === A.anchor,
  'anchored ' + A.anchor + ' got ' + rc2.json?.result?.tools?.[0]?.name);
check('(4b) continuation page echoes total (' + tmpl.names.length + ') after the reorder',
  rc2.json?.result?.total === tmpl.names.length, String(rc2.json?.result?.total));
{
  const reTmpl = walkTemplate(reorderedTpl, 'tools');
  const rows = [...(rc2.json.result?.tools ?? []).map((t) => t.name)];
  let cur = rc2.json.result?.nextCursor;
  for (let page = 3; page <= 100 && cur; page++) {
    const p = await postMcp(workerC, envC, 'tools/list', { cursor: cur });
    rows.push(...(p.json.result?.tools ?? []).map((t) => t.name));
    cur = p.json.result?.nextCursor;
  }
  // rows start AT the anchor (rc2's first tool is the anchored element — asserted above)
  const walkedNames = rows;
  const fromAnchor = reTmpl.names.indexOf(A.anchor);
  check('(4b) v2-anchored continuation === template order from the anchor to the (moved) tail',
    walkedNames.length === reTmpl.names.length - fromAnchor && walkedNames.every((n, i) => n === reTmpl.names[fromAnchor + i]),
    'walked ' + walkedNames.length + ' expected ' + (reTmpl.names.length - fromAnchor));
  check('(4b) moved head element appears exactly once, at the tail',
    walkedNames[walkedNames.length - 1] === tmpl.names[0] && walkedNames.filter((n) => n === tmpl.names[0]).length === 1);
}

console.log('(5) search surface: list_ainumbers_tools cursor pagination + total (additive)');
const catalog = JSON.parse(readFileSync(join(DATA_DIR, 'mcp', 'catalog.json'), 'utf8'));
const catTools = catalog.tools ?? [];
// tools/call is driven over buildServer + InMemoryTransport (the house offline pattern —
// check-delegation-reason.mjs): fetch-to-node's toReqRes/StreamableHTTPServerTransport pair
// returns an empty HTTP 400 under plain Node for ANY tools/call, a documented harness limit.
const { buildServer, loadData } = await import('../worker.mjs');
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
const data = await loadData(env);
async function callTool(name, args) {
  const server = buildServer(data, { onlyTool: name });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'run41-pagination-selftest', version: '1.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    return await client.callTool({ name, arguments: args });
  } catch (e) {
    return { isError: true, content: [{ type: 'text', text: String(e?.message ?? e) }] };
  } finally {
    await client.close();
  }
}
const callSearch = (args) => callTool('list_ainumbers_tools', args);
{
  const p = await callSearch({ limit: 5 });
  const sc = p?.structuredContent;
  check('search answers with structuredContent', !!sc);
  // compat: the shipped default computation, reimplemented (filter → slice → map)
  const q = '';
  const shippedRows = catTools
    .filter((t) => !q || (t.name + ' ' + t.description).toLowerCase().includes(q))
    .slice(0, 5)
    .map((t) => ({ name: t.name, tool_id: t.metadata?.tool_id, url: t.metadata?.url, prefill: !!t.metadata?.prefill, ap2_export: !!t.metadata?.ap2_export, description: t.description.slice(0, 160) }));
  check('default page rows unchanged (shipped count/tools values)', sc?.count === 5 && JSON.stringify(sc.tools) === JSON.stringify(shippedRows));
  check('total echoes the whole match set (' + catTools.length + ')', sc?.total === catTools.length, String(sc?.total));
  check('nextCursor names the last row served (keyset contract)', sc?.nextCursor === sc?.tools[sc.tools.length - 1].name);
  const p2 = await callSearch({ limit: 5, cursor: sc.nextCursor });
  const sc2 = p2.structuredContent;
  check('cursor page starts strictly after the cursor row', sc2?.tools?.[0]?.name === catTools[5].name && sc2?.total === catTools.length);
  check('no overlap between page one and page two', !sc.tools.some((r) => sc2.tools.some((r2) => r2.name === r.name)));
  const unknown = await callSearch({ limit: 5, cursor: 'no_such_catalog_row_zz' });
  check('unknown search cursor → isError result, never a shifted page', unknown?.isError === true);
  // filtered + walk to exhaustion
  const fq = 'fraud';
  const expect = catTools.filter((t) => (t.name + ' ' + t.description).toLowerCase().includes(fq)).map((t) => t.name);
  const rows = [];
  let cur;
  for (let page = 1; page <= 50; page++) {
    const pf = await callSearch({ query: fq, limit: 3, ...(cur ? { cursor: cur } : {}) });
    const s = pf.structuredContent;
    if (page === 1) check('filtered total matches an independent count (' + expect.length + ')', s?.total === expect.length, String(s?.total));
    rows.push(...s.tools.map((t) => t.name));
    cur = s.nextCursor;
    if (!cur) break;
  }
  check('filtered walk exhausts to exactly the filtered set', rows.length === expect.length && rows.every((n, i) => n === expect[i]),
    'walked ' + rows.length + ' expected ' + expect.length);
  // exhaust the unfiltered catalog and confirm union == catalog order
  const all = [];
  cur = undefined;
  for (let page = 1; page <= 100; page++) {
    const pa = await callSearch({ limit: 500, ...(cur ? { cursor: cur } : {}) });
    const s = pa.structuredContent;
    all.push(...s.tools.map((t) => t.name));
    cur = s.nextCursor;
    if (!cur) break;
  }
  check('unfiltered walk exhausts to the catalog in order (' + catTools.length + ')',
    all.length === catTools.length && all.every((n, i) => n === catTools[i].name));
}

console.log('(6) single-page lists keep byte-identical full frames');
for (const [method, key, file] of [['resources/list', 'resources', 'resources-list.sse.txt'], ['prompts/list', 'prompts', 'prompts-list.sse.txt']]) {
  const t = readTemplate(file);
  const prefix = t.indexOf('{"jsonrpc"');
  const p = await postMcp(worker, env, method, {});
  const expected = t.replace('__OCG_ID__', () => JSON.stringify(p.json.id ?? null));
  // JSON framing: the data line only (SSE wrapper stripped by the negotiation)
  check(method + ' full frame byte-identical (shipped guarantee, JSON framing)', p.text === expected.slice(prefix, -2),
    'response ' + p.text.length + 'B vs expected ' + (expected.length - prefix - 2) + 'B');
  const pSse = await postMcp(worker, env, method, {}, { Accept: 'text/event-stream' });
  const expectedSse = t.replace('__OCG_ID__', () => JSON.stringify(pSse.json ? pSse.json.id : nextId - 1));
  check(method + ' full frame byte-identical (SSE framing control)', pSse.text === expectedSse,
    'response ' + pSse.text.length + 'B vs expected ' + expectedSse.length + 'B');
  const inv = await postMcp(worker, env, method, { cursor: 'v2.no_such_' + key + '_zz' });
  check(method + ' unknown v2 id refused -32602', inv.status === 400 && inv.json?.error?.code === -32602);
}

console.log('');
if (fails.length) {
  console.error('✗ RUN-4-1 selftest: ' + fails.length + ' failure(s)');
  for (const f of fails) console.error('  - ' + f);
  process.exit(1);
}
console.log('✓ RUN-4-1 selftest: all ' + passed + ' checks green');
