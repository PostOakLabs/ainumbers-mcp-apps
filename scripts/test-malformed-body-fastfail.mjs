// test-malformed-body-fastfail.mjs — regression test (audit F1, 2026-07-09)
//
// Confirms a syntactically-invalid JSON POST to /mcp gets a fast, typed 400/-32700 parse
// error instead of hanging for HANG_GUARD_MS (25s) and returning a 504 "Server timeout".
// Root cause: request.json() consumes the fetch Request body stream; on parse failure `body`
// was `undefined` and fell through to transport.handleRequest, which tried to re-read the
// already-drained stream via toReqRes(request) and never resolved. Fixed in worker.mjs by
// fast-failing when body===undefined for a POST to /mcp, before the SDK transport is touched.
//
// Runs the real worker.mjs default export against a lightweight local ASSETS stub backed by
// the committed ./data directory (mirrors what `wrangler dev` / the deployed Worker serve via
// the assets binding — see wrangler.jsonc "assets.directory": "./data"). No network egress,
// no live endpoint hit — fast and deterministic for CI.
//
// Usage: node scripts/test-malformed-body-fastfail.mjs

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
  const buf = readFileSync(filePath);
  return new Response(buf, { status: 200 });
}

const env = {
  ASSETS: { fetch: async (url) => assetsFetch(typeof url === 'string' ? url : url.url) },
};

const worker = (await import('../worker.mjs')).default;

async function post(body, headers = {}) {
  const req = new Request('https://mcp.ainumbers.co/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream', ...headers },
    body,
  });
  const t0 = Date.now();
  const res = await worker.fetch(req, env, { waitUntil: () => {}, passThroughOnException: () => {} });
  const ms = Date.now() - t0;
  const text = await res.text();
  return { status: res.status, ms, text };
}

let failed = 0;

console.log('▶ malformed (unparseable) JSON body — must be fast + 400/-32700, never a multi-second hang');
{
  const { status, ms, text } = await post('not-json-at-all{{{');
  console.log(`  status=${status} elapsed=${ms}ms body=${text.slice(0, 140)}`);
  if (status !== 400) { console.error('  ✗ expected HTTP 400'); failed++; }
  else console.log('  ✓ HTTP 400');
  if (!/-32700/.test(text)) { console.error('  ✗ expected -32700 parse-error code in body'); failed++; }
  else console.log('  ✓ -32700 parse error');
  if (ms > 2000) { console.error(`  ✗ took ${ms}ms — expected a fast fail (<2s), the whole point of this gate`); failed++; }
  else console.log(`  ✓ fast (${ms}ms, well under the old 25000ms hang)`);
}

console.log('\n▶ empty body — same fast-fail path (also unparseable JSON)');
{
  const { status, ms, text } = await post('');
  console.log(`  status=${status} elapsed=${ms}ms body=${text.slice(0, 140)}`);
  if (status !== 400) { console.error('  ✗ expected HTTP 400'); failed++; }
  else console.log('  ✓ HTTP 400');
  if (ms > 2000) { console.error(`  ✗ took ${ms}ms`); failed++; }
  else console.log(`  ✓ fast (${ms}ms)`);
}

console.log('\n▶ control: valid JSON, but not a valid JSON-RPC shape (missing "method") — must STILL reach the SDK\'s own fast 400/-32700 (unaffected by this fix, not a regression)');
{
  const { status, ms, text } = await post(JSON.stringify({ jsonrpc: '2.0', id: 1, params: {} }));
  console.log(`  status=${status} elapsed=${ms}ms body=${text.slice(0, 200)}`);
  if (status !== 400) { console.error('  ✗ expected HTTP 400'); failed++; }
  else console.log('  ✓ HTTP 400');
  if (ms > 2000) { console.error(`  ✗ took ${ms}ms`); failed++; }
  else console.log(`  ✓ fast (${ms}ms)`);
}

console.log('\n▶ control: well-formed tools/list call — must still succeed normally (fix does not affect the happy path)');
{
  const { status, ms, text } = await post(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }));
  console.log(`  status=${status} elapsed=${ms}ms bytes=${text.length}`);
  if (status !== 200) { console.error('  ✗ expected HTTP 200'); failed++; }
  else console.log('  ✓ HTTP 200');
  if (!/tools/.test(text)) { console.error('  ✗ expected a tools/list result body'); failed++; }
  else console.log('  ✓ tools/list result present');
}

if (failed) {
  console.error(`\n✗ test-malformed-body-fastfail: ${failed} check(s) failed`);
  process.exit(1);
}
console.log('\n✅ test-malformed-body-fastfail: all checks passed — malformed JSON bodies fail fast (400/-32700), happy path unaffected.');
