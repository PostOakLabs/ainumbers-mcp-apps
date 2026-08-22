// test-mcp-accept-negotiation.mjs — regression test (MCP-CONTENT-NEGOTIATION-FIX-1, 2026-08-22)
//
// Live diagnosis: `curl -D- https://mcp.ainumbers.co/mcp` for `tools/list` returned HTTP 200 +
// `Content-Type: text/event-stream` (body starts `event: message\ndata: {...}`) EVEN when the
// client's Accept header was `application/json` only (or no Accept header at all, the plain-curl
// default). Any MCP client that accepts only JSON cannot parse that body (`JSON.parse` throws on
// the `event:` line) — a live interop regression: third-party scorer mcpqueen dropped 100 -> 62
// on 2026-08-12 for exactly this ("tools/list failed: HTTP 200", Tooling 0/35).
//
// The MCP Streamable HTTP spec requires a POST response to be EITHER `application/json` (one
// JSON-RPC object) OR `text/event-stream` (SSE), and the choice MUST respect the client's Accept
// header. This worker's static fast path (initialize / tools|resources|prompts list, and the
// Removed-tool tools/call rejection) served every result as `text/event-stream` unconditionally.
// The fix content-negotiates: a client that indicates it can take application/json (including a
// client that sends no Accept header at all) gets a bare JSON-RPC body; a client that asked
// specifically for text/event-stream and did NOT also offer application/json keeps today's SSE
// framing byte-for-byte.
//
// Runs the real worker.mjs default export against a lightweight local ASSETS stub backed by the
// committed ./data directory (mirrors what wrangler dev / the deployed Worker serve via the
// assets binding). No network egress, no live endpoint hit — fast and deterministic for CI.
//
// Usage: node scripts/test-mcp-accept-negotiation.mjs

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const DATA_DIR = join(ROOT, 'data');

function assetsFetch(url) {
  const u = new URL(typeof url === 'string' ? url : url.url);
  const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '');
  const filePath = join(DATA_DIR, rel);
  if (!existsSync(filePath)) return new Response('Not Found', { status: 404 });
  return new Response(readFileSync(filePath), { status: 200 });
}

const env = {
  ASSETS: { fetch: async (url) => assetsFetch(url) },
};

const worker = (await import('../worker.mjs')).default;

let nextId = 1;
// headers=null means "send no Accept header at all" (the plain-curl-default shape that
// reproduced the live bug) — omitted entirely from the Headers object, not sent as ''.
async function post(method, headers) {
  const h = { 'Content-Type': 'application/json' };
  if (headers) Object.assign(h, headers);
  const req = new Request('https://mcp.ainumbers.co/mcp', {
    method: 'POST',
    headers: h,
    body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params: {} }),
  });
  const res = await worker.fetch(req, env, { waitUntil: () => {}, passThroughOnException: () => {} });
  const contentType = res.headers.get('content-type') ?? '';
  const text = await res.text();
  return { status: res.status, contentType, text };
}

let failed = 0;
function check(label, cond, detail = '') {
  if (cond) console.log('  ✓ ' + label);
  else { failed++; console.error('  ✗ ' + label + (detail ? ' — ' + detail : '')); }
}

// ---- RED-first shape: Accept: application/json only, no text/event-stream -----------------
console.log('▶ tools/list, Accept: application/json (JSON-only client — the live-reproducing shape)');
{
  const { status, contentType, text } = await post('tools/list', { Accept: 'application/json' });
  console.log(`  status=${status} content-type=${contentType} bytes=${text.length}`);
  check('HTTP 200', status === 200, `status=${status}`);
  check('Content-Type: application/json (not text/event-stream)', contentType.includes('application/json'), `content-type=${contentType}`);
  let parsed, parseError = null;
  try { parsed = JSON.parse(text); } catch (e) { parseError = String(e); }
  check('body is valid JSON (JSON.parse succeeds)', !parseError, parseError);
  check('body has no SSE "event:" framing', !text.startsWith('event:'), `starts with: ${text.slice(0, 40)}`);
  check('result.tools is a non-empty array', Array.isArray(parsed?.result?.tools) && parsed.result.tools.length > 0,
    `tools=${JSON.stringify(parsed?.result?.tools)?.slice(0, 100)}`);
}

console.log('\n▶ initialize, Accept: application/json (JSON-only client)');
{
  const { status, contentType, text } = await post('initialize', { Accept: 'application/json' });
  console.log(`  status=${status} content-type=${contentType} bytes=${text.length}`);
  check('HTTP 200', status === 200, `status=${status}`);
  check('Content-Type: application/json', contentType.includes('application/json'), `content-type=${contentType}`);
  let parsed, parseError = null;
  try { parsed = JSON.parse(text); } catch (e) { parseError = String(e); }
  check('body is valid JSON (JSON.parse succeeds)', !parseError, parseError);
  check('result.protocolVersion present', typeof parsed?.result?.protocolVersion === 'string', JSON.stringify(parsed?.result));
}

console.log('\n▶ tools/list, NO Accept header at all (plain `curl -d`, the exact corroborating shape ORCH hit live)');
{
  const { status, contentType, text } = await post('tools/list', null);
  console.log(`  status=${status} content-type=${contentType} bytes=${text.length}`);
  check('HTTP 200', status === 200, `status=${status}`);
  check('Content-Type: application/json (default is JSON-capable, not SSE)', contentType.includes('application/json'), `content-type=${contentType}`);
  let parseError = null;
  try { JSON.parse(text); } catch (e) { parseError = String(e); }
  check('body is valid JSON (JSON.parse succeeds)', !parseError, parseError);
}

console.log('\n▶ tools/list, Accept offers BOTH application/json and text/event-stream (spec-recommended client header) — single complete result, JSON wins');
{
  const { status, contentType, text } = await post('tools/list', { Accept: 'application/json, text/event-stream' });
  console.log(`  status=${status} content-type=${contentType} bytes=${text.length}`);
  check('Content-Type: application/json', contentType.includes('application/json'), `content-type=${contentType}`);
  let parseError = null;
  try { JSON.parse(text); } catch (e) { parseError = String(e); }
  check('body is valid JSON (JSON.parse succeeds)', !parseError, parseError);
}

// ---- negative control: SSE-only client must be completely unaffected ----------------------
console.log('\n▶ CONTROL: tools/list, Accept: text/event-stream only (SSE client — must be byte-for-byte unchanged)');
{
  const { status, contentType, text } = await post('tools/list', { Accept: 'text/event-stream' });
  console.log(`  status=${status} content-type=${contentType} bytes=${text.length}`);
  check('HTTP 200', status === 200, `status=${status}`);
  check('Content-Type: text/event-stream (unchanged)', contentType.includes('text/event-stream'), `content-type=${contentType}`);
  check('body starts with SSE "event:" framing (unchanged)', text.startsWith('event:'), `starts with: ${text.slice(0, 40)}`);
  check('body ends with the SSE double-newline terminator (unchanged)', text.endsWith('\n\n'), `ends with: ${JSON.stringify(text.slice(-10))}`);
}

console.log('\n▶ CONTROL: initialize, Accept: text/event-stream only (SSE client — must be byte-for-byte unchanged)');
{
  const { status, contentType, text } = await post('initialize', { Accept: 'text/event-stream' });
  console.log(`  status=${status} content-type=${contentType} bytes=${text.length}`);
  check('Content-Type: text/event-stream (unchanged)', contentType.includes('text/event-stream'), `content-type=${contentType}`);
  check('body starts with SSE "event:" framing (unchanged)', text.startsWith('event:'), `starts with: ${text.slice(0, 40)}`);
}

if (failed) {
  console.error(`\n✗ test-mcp-accept-negotiation: ${failed} check(s) failed`);
  process.exit(1);
}
console.log('\n✅ test-mcp-accept-negotiation: all checks passed — JSON-Accept clients get application/json, SSE-Accept clients unaffected.');
