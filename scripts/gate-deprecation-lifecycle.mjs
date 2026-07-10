// gate-deprecation-lifecycle.mjs — MCP-500-2 §M2.2 proof.
//
// tools/list is served from build-time-PRECOMPUTED static bytes (worker.mjs
// STATIC_DISCOVERY_METHODS fast path -> data/mcp/static/tools-list.sse.txt), so lifecycle_status
// must be proven at the precompute-discovery.mjs layer, not by mocking ASSETS at request time.
// tools/call, by contrast, always builds dynamically per request, so its Removed-tool rejection
// (worker.mjs lifecycleStatusOf gate) is provable by mocking ASSETS at request time (same pattern
// as test-malformed-body-fastfail.mjs).
//
// This gate therefore:
//   1. Temporarily rewrites the on-disk data/mcp/lifecycle.json with ONE injected override (a
//      real, live tool marked "Removed"), re-runs precomputeDiscovery(), and asserts the static
//      tools-list.sse.txt (a) drops the Removed tool entirely and (b) stamps lifecycle_status on
//      every surviving tool (default "Active" for a control tool with no override).
//   2. ALWAYS restores the original committed data/mcp/lifecycle.json + re-runs
//      precomputeDiscovery() in a `finally`, so this gate never leaves the working tree dirty.
//   3. Drives the REAL worker.mjs fetch handler (ASSETS stub backed by ./data, lifecycle.json
//      response overridden in-memory only) to prove tools/call 404s the Removed tool cleanly
//      (HTTP 200, isError:true, no throw/500) and leaves a control tool callable.
//
// Usage: node scripts/gate-deprecation-lifecycle.mjs

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { precomputeDiscovery } from './precompute-discovery.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const DATA_DIR = join(ROOT, 'data');
const LIFECYCLE_PATH = resolve(DATA_DIR, 'mcp', 'lifecycle.json');
const STATIC_TOOLS_PATH = resolve(DATA_DIR, 'mcp', 'static', 'tools-list.sse.txt');

const chaingraph = JSON.parse(readFileSync(join(DATA_DIR, 'chaingraph', 'chaingraph.json'), 'utf8'));
const liveNode = chaingraph.nodes.find((n) => n.status === 'live' && n.mcp_name);
if (!liveNode) { console.error('FATAL: no live node with mcp_name found to test against'); process.exit(1); }
const REMOVED_TOOL = liveNode.mcp_name;
const CONTROL_TOOL = chaingraph.nodes.find((n) => n.status === 'live' && n.mcp_name && n.mcp_name !== REMOVED_TOOL)?.mcp_name;

let failed = 0;
const check = (cond, msg) => { if (cond) console.log('  ✓ ' + msg); else { console.error('  ✗ ' + msg); failed++; } };

function parseFramedSse(text, idPlaceholder) {
  const dataLine = text.split('\ndata: ')[1]?.split('\n\n')[0] ?? text;
  return JSON.parse(dataLine.replace(idPlaceholder, '0'));
}

const originalLifecycle = readFileSync(LIFECYCLE_PATH, 'utf8');

async function main() {
  console.log('▶ [static tools/list] inject Removed override for ' + REMOVED_TOOL + ', re-precompute');
  writeFileSync(LIFECYCLE_PATH, JSON.stringify({ default: 'Active', overrides: { [REMOVED_TOOL]: 'Removed' } }, null, 2) + '\n');
  await precomputeDiscovery();
  const staticText = readFileSync(STATIC_TOOLS_PATH, 'utf8');
  const parsed = parseFramedSse(staticText, '__OCG_ID__');
  const tools = parsed.result.tools;
  const removedStillListed = tools.find((t) => t.name === REMOVED_TOOL);
  check(!removedStillListed, 'Removed tool (' + REMOVED_TOOL + ') absent from precomputed tools/list');
  const control = tools.find((t) => t.name === CONTROL_TOOL);
  check(control?.lifecycle_status === 'Active', 'control tool (' + CONTROL_TOOL + ') lifecycle_status === "Active" (got ' + control?.lifecycle_status + ')');
  check(tools.every((t) => 'lifecycle_status' in t), 'every surviving tool has a lifecycle_status field');

  console.log('▶ [dynamic tools/call] Removed tool 404s cleanly; control tool still callable');
  function assetsFetch(url) {
    const u = new URL(url);
    const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '');
    if (rel === 'mcp/lifecycle.json') {
      return new Response(JSON.stringify({ default: 'Active', overrides: { [REMOVED_TOOL]: 'Removed' } }), { status: 200 });
    }
    const filePath = join(DATA_DIR, rel);
    if (!existsSync(filePath)) return new Response('Not Found', { status: 404 });
    return new Response(readFileSync(filePath), { status: 200 });
  }
  const env = { ASSETS: { fetch: async (url) => assetsFetch(typeof url === 'string' ? url : url.url) } };
  const worker = (await import('../worker.mjs?t=' + Date.now())).default;
  async function rpc(method, params) {
    const req = new Request('https://mcp.ainumbers.co/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const res = await worker.fetch(req, env, { waitUntil: () => {}, passThroughOnException: () => {} });
    const text = await res.text();
    const jsonStr = text.startsWith('event:') ? text.split('\ndata: ')[1]?.split('\n')[0] : text;
    return { status: res.status, body: jsonStr ? JSON.parse(jsonStr) : null };
  }

  {
    const { status, body } = await rpc('tools/call', { name: REMOVED_TOOL, arguments: {} });
    check(status === 200, 'Removed tool call: HTTP 200 (not 500)');
    check(body?.result?.isError === true, 'Removed tool call: result.isError === true');
    check(typeof body?.result?.content?.[0]?.text === 'string' && /not found/i.test(body.result.content[0].text), 'Removed tool call: clean "not found"-shaped message');
    check(!body?.error, 'Removed tool call: no thrown JSON-RPC error object');
  }
  {
    // Empty arguments legitimately 400s on required-param validation (unrelated to lifecycle) —
    // what matters here is that a non-Removed tool near a Removed one is NOT swept up into the
    // 404 path and never 500s.
    const { status, body } = await rpc('tools/call', { name: CONTROL_TOOL, arguments: {} });
    check(status !== 500, 'control tool call: not HTTP 500 (got ' + status + ')');
    check(!(body?.result?.isError === true && /not found/i.test(body?.result?.content?.[0]?.text || '')), 'control tool call: NOT rejected as "not found" (lifecycle gate did not over-match)');
  }
}

try {
  await main();
} finally {
  console.log('▶ restoring committed lifecycle.json + re-precomputing static discovery');
  writeFileSync(LIFECYCLE_PATH, originalLifecycle);
  await precomputeDiscovery();
  console.log('  restored');
}

if (failed) { console.error(`\n${failed} check(s) FAILED`); process.exit(1); }
console.log('\nAll deprecation-lifecycle checks passed.');
