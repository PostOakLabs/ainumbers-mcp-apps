// test-mcp-limiter-routing.mjs — MCP-REACH-DISPATCH-1 D3 limiter unit test, mocked bindings.
//
// The row ships D3 in TWO PRs because an un-provisioned ratelimit binding reads as `undefined` and
// rateLimitExceeded() treats undefined as "never block" — so a one-PR version could ship a discovery
// path with NO limiter and no signal that it had. This test encodes which PR is live:
//
//   PR 1 (this commit): MCP_PREPARSE_LIMITER (ns 3005) is called PRE-PARSE on EVERY POST, alongside
//     today's MCP_RATE_LIMITER (3001) + MCP_GLOBAL_RATE_LIMITER (3002). No routing change yet, so a
//     16-request discovery walk still touches 3001/3002 — asserted here as the BEFORE state, so PR 2
//     cannot land unnoticed and cannot half-land.
//   PR 2: discovery moves to MCP_DISCOVERY_GLOBAL_LIMITER (ns 3006) and 3001/3002 move behind the
//     size-capped parse. The assertions below flip with it, in the same diff (search for PR2-FLIP).
//
// Also asserts the fail-open contract that makes the two-PR order necessary: with NO bindings
// configured at all, nothing blocks (local dev / pre-provisioning must never 429).
//
// Run: node scripts/test-mcp-limiter-routing.mjs

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(HERE, '..', 'data');

const assets = {
  fetch: async (url) => {
    const u = new URL(typeof url === 'string' ? url : url.url);
    const filePath = join(DATA_DIR, decodeURIComponent(u.pathname).replace(/^\/+/, ''));
    if (!filePath.startsWith(DATA_DIR)) return new Response('Not Found', { status: 404 });
    try { return new Response(readFileSync(filePath), { status: 200 }); }
    catch { return new Response('Not Found', { status: 404 }); }
  },
};

const worker = (await import('../worker.mjs')).default;

let failed = 0;
const check = (label, cond, detail = '') => {
  if (cond) console.log('test-mcp-limiter-routing: ' + label + '... ok');
  else { failed++; console.error('test-mcp-limiter-routing: ' + label + '... FAIL' + (detail ? ' — ' + detail : '')); }
};

// A mock ratelimit binding with the real shape: .limit({ key }) -> { success }.
function mockLimiter(counter, name) {
  return { limit: async ({ key }) => { counter.push({ binding: name, key }); return { success: true }; } };
}

function makeEnv(calls) {
  return {
    ASSETS: assets,
    MCP_PREPARSE_LIMITER: mockLimiter(calls, 'MCP_PREPARSE_LIMITER'),
    MCP_RATE_LIMITER: mockLimiter(calls, 'MCP_RATE_LIMITER'),
    MCP_GLOBAL_RATE_LIMITER: mockLimiter(calls, 'MCP_GLOBAL_RATE_LIMITER'),
    MCP_DISCOVERY_GLOBAL_LIMITER: mockLimiter(calls, 'MCP_DISCOVERY_GLOBAL_LIMITER'),
  };
}

let nextId = 1;
async function post(env, body) {
  const res = await worker.fetch(
    new Request('https://mcp.ainumbers.co/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'CF-Connecting-IP': '203.0.113.7' },
      body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, ...body }),
    }),
    env,
    { waitUntil: () => {}, passThroughOnException: () => {} },
  );
  const text = await res.text();
  let parsed = {};
  try {
    parsed = text.startsWith('event:')
      ? JSON.parse((text.split('\n').find((l) => l.startsWith('data: ')) ?? 'data: {}').slice(6))
      : JSON.parse(text || '{}');
  } catch { parsed = {}; }
  return { status: res.status, body: parsed };
}

// ── a full 13-page discovery walk + the other static methods = 16 requests ──────────────────────
{
  const calls = [];
  const env = makeEnv(calls);
  let requests = 0;
  let cursor;
  let pages = 0;
  do {
    const r = await post(env, { method: 'tools/list', params: cursor ? { cursor } : {} });
    requests++; pages++;
    cursor = r.body?.result?.nextCursor;
    if (pages > 30) break;
  } while (cursor);
  for (const method of ['initialize', 'resources/list', 'prompts/list']) {
    await post(env, { method, params: method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'limiter-test', version: '1' } } : {} });
    requests++;
  }
  const byBinding = (n) => calls.filter((c) => c.binding === n).length;
  console.log('· discovery walk: ' + pages + ' tools/list pages, ' + requests + ' POSTs, limiter calls: '
    + JSON.stringify({ preparse: byBinding('MCP_PREPARSE_LIMITER'), ip: byBinding('MCP_RATE_LIMITER'),
                       global: byBinding('MCP_GLOBAL_RATE_LIMITER'), discovery: byBinding('MCP_DISCOVERY_GLOBAL_LIMITER') }));
  check('a ' + requests + '-request discovery walk is seen by ns 3005 (MCP_PREPARSE_LIMITER) on EVERY POST',
    byBinding('MCP_PREPARSE_LIMITER') === requests, byBinding('MCP_PREPARSE_LIMITER') + ' of ' + requests);
  check('ns 3005 is keyed on the client IP, not a constant', calls.filter((c) => c.binding === 'MCP_PREPARSE_LIMITER').every((c) => c.key === '203.0.113.7'));
  // PR2-FLIP: after PR 2 these two become `=== 0` and the discovery binding becomes `=== requests`.
  check('PR 1 BEFORE-state: the walk still touches ns 3001/3002 (PR 2 is what moves it)',
    byBinding('MCP_RATE_LIMITER') === requests && byBinding('MCP_GLOBAL_RATE_LIMITER') === requests,
    'ip=' + byBinding('MCP_RATE_LIMITER') + ' global=' + byBinding('MCP_GLOBAL_RATE_LIMITER'));
  check('PR 1 BEFORE-state: ns 3006 is provisioned but not yet called',
    byBinding('MCP_DISCOVERY_GLOBAL_LIMITER') === 0, String(byBinding('MCP_DISCOVERY_GLOBAL_LIMITER')));
}

// ── a tools/call must always spend the heavy buckets ────────────────────────────────────────────
{
  const calls = [];
  const env = makeEnv(calls);
  await post(env, { method: 'tools/call', params: { name: 'find_tool', arguments: { query: 'reserve' } } });
  const byBinding = (n) => calls.filter((c) => c.binding === n).length;
  check('tools/call spends the heavy buckets (ns 3001 + 3002) and ns 3005',
    byBinding('MCP_RATE_LIMITER') === 1 && byBinding('MCP_GLOBAL_RATE_LIMITER') === 1 && byBinding('MCP_PREPARSE_LIMITER') === 1,
    JSON.stringify({ ip: byBinding('MCP_RATE_LIMITER'), global: byBinding('MCP_GLOBAL_RATE_LIMITER'), preparse: byBinding('MCP_PREPARSE_LIMITER') }));
}

// ── refusal actually refuses, and only from a configured binding ────────────────────────────────
{
  const env = { ASSETS: assets, MCP_PREPARSE_LIMITER: { limit: async () => ({ success: false }) } };
  const r = await post(env, { method: 'tools/list', params: {} });
  check('ns 3005 answering success:false short-circuits the request (-32029, pre-parse)',
    r.status === 429 || r.body?.error?.code === -32029, r.status + ' ' + JSON.stringify(r.body).slice(0, 160));
}
{
  const r = await post({ ASSETS: assets }, { method: 'tools/list', params: {} });
  check('no bindings configured → nothing blocks (fail-open contract the two-PR order depends on)',
    Array.isArray(r.body?.result?.tools) && r.body.result.tools.length > 0, r.status + ' ' + JSON.stringify(r.body).slice(0, 120));
}

console.log(failed ? '\n✗ test-mcp-limiter-routing FAILED (' + failed + ')' : '\n✅ test-mcp-limiter-routing OK — D3 PR 1 limiter wiring holds');
process.exit(failed ? 1 : 0);
