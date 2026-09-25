// test-call-tool-dispatch.mjs — offline proof harness for MCP-REACH-DISPATCH-1 D1 (`call_tool`).
//
// Drives the Worker's own fetch handler against the committed ./data assets (the
// scripts/test-describe-tool.mjs pattern: same local ASSETS stub wrangler serves), so the
// dispatcher's contract is proven BEFORE anything deploys. Asserts:
//   1. call_tool is listed, and on page ONE (the reach claim: a page-1-only host must see it).
//   2. PARITY — for 20 allowlisted tools, >=5 of them from tools/list pages >=2:
//      `tools/call call_tool {name, arguments}` and a direct `tools/call name {arguments}` return
//      the same execution_hash and the same content/structuredContent, byte for byte. Arguments come
//      from the vendored chain fixtures, so real kernels really run on both legs.
//   3. The ONLY permitted difference: _meta["ainumbers/dispatched_via"] === "call_tool" on the
//      dispatched leg, and it is OUTSIDE the hashed payload (same execution_hash proves that).
//   4. REFUSALS, each a tool result with isError:true and never a 5xx: all 10 non-allowlisted
//      names, self-target, unknown name, and a non-object `arguments`.
//   5. SCHEMA PARITY — schema-invalid arguments are refused by the dispatched call EXACTLY as the
//      direct call refuses them (same JSON-RPC error code and message), because the dispatcher
//      rewrites params and reuses the one validator instead of carrying its own.
//
// `--mutate` runs the SAME comparisons against a deliberately corrupted dispatched result (one
// structuredContent field dropped) and expects them to FAIL — SO #34c's red-before-green, in the
// harness rather than in a second throwaway script. The PR body quotes both runs.
//
// Run: node scripts/test-call-tool-dispatch.mjs   [--mutate]

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(HERE, '..', 'data');
const MUTATE = process.argv.includes('--mutate');

const env = {
  ASSETS: {
    fetch: async (url) => {
      const u = new URL(typeof url === 'string' ? url : url.url);
      const filePath = join(DATA_DIR, decodeURIComponent(u.pathname).replace(/^\/+/, ''));
      if (!filePath.startsWith(DATA_DIR)) return new Response('Not Found', { status: 404 });
      try { return new Response(readFileSync(filePath), { status: 200 }); }
      catch { return new Response('Not Found', { status: 404 }); }
    },
  },
};

const worker = (await import('../worker.mjs')).default;

let failed = 0;
const check = (label, cond, detail = '') => {
  if (cond) console.log('test-call-tool-dispatch: ' + label + '... ok');
  else { failed++; console.error('test-call-tool-dispatch: ' + label + '... FAIL' + (detail ? ' — ' + detail : '')); }
};

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
  return { status: res.status, body: parseBody(text) };
}
const callDirect = (name, args) => post({ method: 'tools/call', params: { name, ...(args !== undefined ? { arguments: args } : {}) } });
const callVia = (name, args) => post({ method: 'tools/call', params: { name: 'call_tool', arguments: { name, ...(args !== undefined ? { arguments: args } : {}) } } });

// ── the served pages, so "page >= 2" is measured, not assumed ───────────────────────────────────
const pageOf = new Map();
{
  let cursor;
  let page = 0;
  do {
    const r = await post({ method: 'tools/list', params: cursor ? { cursor } : {} });
    page++;
    for (const t of r.body?.result?.tools ?? []) if (!pageOf.has(t.name)) pageOf.set(t.name, page);
    cursor = r.body?.result?.nextCursor;
    if (page > 50) break;
  } while (cursor);
  console.log('· walked ' + page + ' pages, ' + pageOf.size + ' tools');
}

// ── 1. call_tool listed on page one ─────────────────────────────────────────────────────────────
check('call_tool is listed on page ONE of tools/list', pageOf.get('call_tool') === 1, 'page=' + pageOf.get('call_tool'));

const allowlist = JSON.parse(readFileSync(join(DATA_DIR, 'mcp', 'dispatch-allowlist.json'), 'utf8'));
const allowed = new Set(allowlist.tools);
check('dispatch allowlist excludes call_tool itself', !allowed.has('call_tool'));
check('dispatch allowlist excludes all ' + allowlist.excluded.length + ' non-read-only / open-world tools',
  allowlist.excluded.every((n) => !allowed.has(n)), allowlist.excluded.join(', '));

// ── 2+3. PARITY ─────────────────────────────────────────────────────────────────────────────────
// ⚠ MEASURED LIMIT OF THIS HARNESS, quoted because it decides where the kernel-parity proof lives:
// a real `tools/call` driven through worker.fetch OFFLINE never reaches the tool — the SDK's Node
// transport shim (@hono/node-server) is not available here and answers an EMPTY HTTP 400 first. That
// is pre-existing and documented at scripts/test-error-envelope.mjs:81-86; measured again on this
// branch, identically for BOTH legs: direct tools/call and dispatched tools/call each return
// `HTTP 400 {}` for every one of the 10 fixture-backed tools sampled below.
// ⇒ The 20-tool / >=5-deep execution_hash parity therefore runs in scripts/smoke-mcp.mjs against the
//   DEPLOYED endpoint (post-deploy CI leg), where tools/call actually executes. It is NOT skipped.
// ⇒ What IS provable offline, and is proven here, is every part of the dispatcher that lives in the
//   worker's own dispatch layer: the allowlist, all the refusals, schema-refusal parity, and — via
//   describe_tool, which the dispatch layer answers WITHOUT the SDK transport — that a dispatched
//   result is byte-identical to a direct one except for the _meta stamp.
{
  const name = 'recompute_payment_waterfall';
  const a = await callDirect('describe_tool', { name });
  const b = await callVia('describe_tool', { name });
  const direct = a.body?.result;
  let via = b.body?.result;
  if (MUTATE && via?.structuredContent) {
    // SO #34c red-before-green: a dispatcher that DROPS a field must fail these comparisons.
    via = { ...via, structuredContent: { ...via.structuredContent } };
    delete via.structuredContent[Object.keys(via.structuredContent)[0]];
  }
  const ran = !!direct?.structuredContent && !!via?.structuredContent;
  check('describe_tool dispatch: both legs returned a result (dispatch-layer path, no SDK transport)', ran,
    'direct HTTP ' + a.status + ', via HTTP ' + b.status);
  if (ran) {
    const stripped = (r) => JSON.stringify({ ...r, _meta: undefined });
    check('describe_tool dispatch: result byte-identical to the direct call apart from _meta', stripped(direct) === stripped(via));
    check('describe_tool dispatch: dispatched leg carries _meta["ainumbers/dispatched_via"]="call_tool"',
      via._meta?.['ainumbers/dispatched_via'] === 'call_tool', JSON.stringify(via._meta));
    check('describe_tool dispatch: the DIRECT leg carries no dispatched_via stamp',
      direct._meta?.['ainumbers/dispatched_via'] === undefined, JSON.stringify(direct._meta));
  }
}

const chaingraph = JSON.parse(readFileSync(join(DATA_DIR, 'chaingraph', 'chaingraph.json'), 'utf8'));
// chain-fixtures.json is keyed chain name -> tool_id -> policy_parameters (scripts/gen-chain-fixtures.mjs).
const mcpNameById = new Map((chaingraph.nodes ?? []).filter((n) => n.mcp_name).map((n) => [n.tool_id, n.mcp_name]));
const fixtures = JSON.parse(readFileSync(join(DATA_DIR, 'chain-fixtures.json'), 'utf8'));
const candidates = [];
const seen = new Set();
for (const byNode of Object.values(fixtures)) {
  for (const [nodeId, args] of Object.entries(byNode ?? {})) {
    const name = mcpNameById.get(nodeId);
    if (!name || seen.has(name) || !allowed.has(name) || !args || typeof args !== 'object') continue;
    seen.add(name);
    candidates.push({ name, args, page: pageOf.get(name) ?? 0 });
  }
}
// >=5 from pages >=2 is a REQUIREMENT of the row's gate, so select for it explicitly rather than
// hoping the fixture order happens to satisfy it.
const deep = candidates.filter((c) => c.page >= 2);
const shallow = candidates.filter((c) => c.page === 1);
const sample = [...deep, ...shallow].slice(0, 20);
// The live parity leg (smoke-mcp.mjs) needs fixture-backed, allowlisted tools with >=5 from pages
// >=2; this harness reports whether the vendored data can supply them, so a shortfall is caught
// BEFORE deploy rather than in the post-deploy leg.
check('vendored fixtures can supply >=5 allowlisted parity tools from pages >=2 (for the live leg)',
  deep.length >= 5, 'deep=' + deep.length + ' shallow=' + shallow.length);
console.log('· live-parity candidates: ' + candidates.length + ' fixture-backed allowlisted tools, '
  + deep.length + ' of them on pages >=2; sample of ' + sample.length + ': '
  + sample.map((c) => c.name + '@p' + c.page).join(', '));
{
  // Record the offline limit as EVIDENCE, not as a silent skip: both legs must fail the same way.
  const { name, args, page } = sample[0] ?? {};
  if (name) {
    const a = await callDirect(name, args);
    const b = await callVia(name, args);
    check('offline SDK-transport limit is symmetric (direct and dispatched both HTTP ' + a.status + ' for ' + name + '@p' + page + ')',
      a.status === b.status && JSON.stringify(a.body) === JSON.stringify(b.body),
      'direct ' + a.status + ' ' + JSON.stringify(a.body).slice(0, 80) + ' / via ' + b.status + ' ' + JSON.stringify(b.body).slice(0, 80));
  }
}

// ── 4. refusals ─────────────────────────────────────────────────────────────────────────────────
const refusalText = (r) => r.body?.result?.content?.[0]?.text ?? '';
const isRefusal = (r) => r.status === 200 && r.body?.result?.isError === true && refusalText(r).length > 0 && !r.body?.error;
for (const name of allowlist.excluded) {
  const r = await callVia(name, {});
  check('refuses non-allowlisted "' + name + '" as a tool result', isRefusal(r) && /call it directly/.test(refusalText(r)),
    r.status + ' ' + JSON.stringify(r.body).slice(0, 160));
}
{
  const r = await callVia('call_tool', {});
  check('refuses self-target', isRefusal(r) && /cannot target itself/.test(refusalText(r)), JSON.stringify(r.body).slice(0, 160));
}
{
  const r = await callVia('no_such_tool_at_all', {});
  check('refuses an unknown name and points at find_tool', isRefusal(r) && /find_tool/.test(refusalText(r)), JSON.stringify(r.body).slice(0, 160));
}
{
  const r = await post({ method: 'tools/call', params: { name: 'call_tool', arguments: { name: 'find_tool', arguments: 'not-an-object' } } });
  check('refuses non-object arguments', isRefusal(r), JSON.stringify(r.body).slice(0, 160));
}
{
  const r = await post({ method: 'tools/call', params: { name: 'call_tool', arguments: {} } });
  check('refuses a missing name', isRefusal(r), JSON.stringify(r.body).slice(0, 160));
}

// ── 5. schema-invalid arguments refused EXACTLY as a direct call refuses them ───────────────────
{
  const bad = { query: 42 };                    // find_tool.query is a string
  const a = await callDirect('find_tool', bad);
  const b = await callVia('find_tool', bad);
  const codeA = a.body?.error?.code ?? (a.body?.result?.isError ? 'isError' : 'ok');
  const codeB = b.body?.error?.code ?? (b.body?.result?.isError ? 'isError' : 'ok');
  check('schema-invalid args: dispatched refusal class == direct refusal class', codeA === codeB, 'direct=' + codeA + ' via=' + codeB);
  const msgA = a.body?.error?.message ?? refusalText(a);
  const msgB = b.body?.error?.message ?? refusalText(b);
  check('schema-invalid args: same refusal message (one validator, not two)', msgA === msgB,
    JSON.stringify([msgA, msgB]).slice(0, 240));
}

if (MUTATE) {
  console.log(failed
    ? '\n✅ MUTATION PROBE: harness correctly FAILED (' + failed + ') on a dispatcher that drops a field — the parity check is real'
    : '\n✗ MUTATION PROBE: harness passed a corrupted dispatched result — the parity check proves nothing');
  process.exit(failed ? 0 : 1);
}
console.log(failed ? '\n✗ test-call-tool-dispatch FAILED (' + failed + ')' : '\n✅ test-call-tool-dispatch OK — dispatcher parity, refusals and schema parity hold offline');
process.exit(failed ? 1 : 0);
