// test-idreplace-dos.mjs — regression test (WORKER-IDREPLACE-DOS-1, 2026-08-29; a live P0 on the
// public MCP endpoint, found by the hy4 worker audit as P0-2).
//
// THE DEFECT: worker.mjs served the static tools/list SSE by splicing the JSON-RPC id into a
// pre-framed template with `tpl.replace(ID_PLACEHOLDER, JSON.stringify(body.id))`. `String.replace`
// with a STRING second argument interprets `$'`, `` $` ``, `$&` and `$$` in the REPLACEMENT as
// pattern-substitution tokens. `__OCG_ID__` sits at byte 43 of a 1,740,927-byte template, so an
// attacker-supplied id of `"$'"` ("everything AFTER the match") spliced the whole remaining ~1.74MB
// of the template back into itself — a 2x amplification bought with a ~40-byte request. Batched,
// that returned a live HTTP 503 (Cloudflare Error 1102, retryable:false): a single-request DoS on an
// unauthenticated public endpoint.
//
// THE FIX, in three parts, all asserted below:
//   1. a replacer FUNCTION — `() => idJson` — which the spec exempts from pattern interpretation;
//   2. id TYPE VALIDATION before use (JSON-RPC ids are string | number | null, never a container);
//   3. a bounded substitution assert — exactly one splice, inserted bytes === the intended id JSON.
// Folded in from the same attack surface: P1-1 JSON-RPC batch rejection (the N-amplification
// vector, and removed from MCP as of 2025-06-18) and P1-2 a request body-size cap.
//
// Runs the real worker.mjs default export against a lightweight local ASSETS stub backed by the
// committed ./data directory — the same instrument scripts/test-malformed-body-fastfail.mjs uses.
// No network egress, no live endpoint hit: the amplification is measured from bytes, locally.
//
// Usage: node scripts/test-idreplace-dos.mjs

import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const DATA_DIR = join(ROOT, 'data');
const TEMPLATE = join(DATA_DIR, 'mcp/static/tools-list.sse.txt');

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

async function post(bodyText, headers = {}) {
  const req = new Request('https://mcp.ainumbers.co/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream', ...headers },
    body: bodyText,
  });
  const res = await worker.fetch(req, env, { waitUntil: () => {}, passThroughOnException: () => {} });
  const text = await res.text();
  return { status: res.status, text };
}

const call = (id, method = 'tools/list') =>
  post(JSON.stringify({ jsonrpc: '2.0', id, method, params: {} }));

// The size the honest response may not meaningfully exceed. Anything at/above the amplification
// line means the template spliced into itself.
const TEMPLATE_BYTES = statSync(TEMPLATE).size;
const AMPLIFICATION_LINE = Math.round(TEMPLATE_BYTES * 1.5);

let failed = 0;
const ok   = (m) => console.log(`  ✓ ${m}`);
const bad  = (m) => { console.error(`  ✗ ${m}`); failed++; };

console.log(`▶ template = ${TEMPLATE_BYTES.toLocaleString()} bytes; amplification line = ${AMPLIFICATION_LINE.toLocaleString()} bytes`);

// ── P0: the pattern-substitution tokens ───────────────────────────────────────────────────────
// Each of these is a legal JSON-RPC string id. Each is ALSO a `String.replace` replacement token.
// The response must stay ~one template long and must carry the id back LITERALLY.
const TOKENS = [
  { id: "$'", note: "$' — inserts everything AFTER the match (the 1.74MB self-splice, the P0)" },
  { id: '$`', note: '$` — inserts everything BEFORE the match' },
  { id: '$&', note: '$& — inserts the matched placeholder itself' },
  { id: '$$', note: '$$ — collapses to a single literal $' },
  { id: "x$'$`$&y", note: "combined tokens in one id" },
];

for (const { id, note } of TOKENS) {
  console.log(`\n▶ tools/list with id = ${JSON.stringify(id)}  [${note}]`);
  const { status, text } = await call(id);
  console.log(`  status=${status} bytes=${text.length.toLocaleString()}`);

  if (status !== 200) bad(`expected HTTP 200, got ${status}`);
  else ok('HTTP 200');

  if (text.length >= AMPLIFICATION_LINE) {
    bad(`AMPLIFIED: ${text.length.toLocaleString()} bytes from a ${TEMPLATE_BYTES.toLocaleString()}-byte template ` +
        `(${(text.length / TEMPLATE_BYTES).toFixed(2)}x) — the id was interpreted as a replacement pattern`);
  } else {
    ok(`no amplification (${(text.length / TEMPLATE_BYTES).toFixed(2)}x template)`);
  }

  // The id must come back as the literal string the client sent, JSON-encoded.
  const want = '"id":' + JSON.stringify(id);
  if (!text.includes(want)) bad(`response does not carry the literal id ${JSON.stringify(id)} (looked for ${want})`);
  else ok('id echoed literally');

  // The placeholder must be fully consumed — a surviving `__OCG_ID__` means the splice went wrong.
  if (text.includes('__OCG_ID__')) bad('the __OCG_ID__ placeholder survived into the response');
  else ok('placeholder consumed');

  // The served frame must still be parseable JSON-RPC.
  const parsed = parseSse(text);
  if (!parsed.ok) bad(`served frame does not parse: ${parsed.why}`);
  else if (parsed.value.id !== id) bad(`parsed id is ${JSON.stringify(parsed.value.id)}, expected ${JSON.stringify(id)}`);
  else ok('frame parses and round-trips the id');
}

// ── P0b: id TYPE validation ───────────────────────────────────────────────────────────────────
// JSON-RPC 2.0 §4: id is a String, Number, or NULL. A container id is not a valid request, and it
// must be refused BEFORE it reaches the splice — never coerced into the template.
console.log('\n▶ container ids (object / array) must be refused, not spliced');
for (const id of [{ evil: "$'" }, ["$'"]]) {
  const { status, text } = await call(id);
  console.log(`  id=${JSON.stringify(id)} status=${status} bytes=${text.length.toLocaleString()}`);
  if (status === 200 && text.length >= AMPLIFICATION_LINE) bad('a container id reached the splice AND amplified');
  else if (status !== 400) bad(`expected HTTP 400 for a non-scalar id, got ${status}`);
  else if (!/-32600/.test(text)) bad('expected -32600 (invalid request) for a non-scalar id');
  else ok('refused with 400 / -32600');
}

// ── P1-1: JSON-RPC batch rejection ────────────────────────────────────────────────────────────
// A batch bypasses EVERY O(1) fast path above (no scalar `id`, no string `method`), so it falls
// through to the full ~186-tool server build — the documented Error-1102 source — once per array
// element. MCP removed batching in the 2025-06-18 revision, so refusing it is also spec-correct.
console.log('\n▶ JSON-RPC batch must be refused with a structured error (never a full server build)');
{
  const batch = Array.from({ length: 50 }, (_, i) => ({ jsonrpc: '2.0', id: i, method: 'tools/list', params: {} }));
  const { status, text } = await post(JSON.stringify(batch));
  console.log(`  elements=${batch.length} status=${status} bytes=${text.length.toLocaleString()} body=${text.slice(0, 160)}`);
  if (status !== 400) bad(`expected HTTP 400 for a batch, got ${status}`);
  else ok('HTTP 400');
  if (!/-32600/.test(text)) bad('expected -32600 (invalid request) for a batch');
  else ok('-32600 invalid request');
  if (text.length >= AMPLIFICATION_LINE) bad('batch rejection returned an amplified body');
  else ok('rejection body is small');
}
console.log('\n▶ batch of amplifying ids — the combined P0 x P1-1 vector');
{
  const batch = Array.from({ length: 50 }, () => ({ jsonrpc: '2.0', id: "$'", method: 'tools/list', params: {} }));
  const { status, text } = await post(JSON.stringify(batch));
  console.log(`  elements=${batch.length} status=${status} bytes=${text.length.toLocaleString()}`);
  if (text.length >= AMPLIFICATION_LINE) bad(`AMPLIFIED: ${text.length.toLocaleString()} bytes`);
  else ok(`no amplification (${text.length.toLocaleString()} bytes)`);
  if (status !== 400) bad(`expected HTTP 400, got ${status}`);
  else ok('HTTP 400');
}

// ── P1-2: request body-size cap ───────────────────────────────────────────────────────────────
console.log('\n▶ oversized request body must be refused with a structured error');
{
  const huge = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'x', arguments: { blob: 'A'.repeat(4 * 1024 * 1024) } } });
  const { status, text } = await post(huge);
  console.log(`  request=${huge.length.toLocaleString()} bytes status=${status} body=${text.slice(0, 160)}`);
  if (status !== 413) bad(`expected HTTP 413 for an oversized body, got ${status}`);
  else ok('HTTP 413');
  if (!/-32600/.test(text)) bad('expected a structured -32600 JSON-RPC error');
  else ok('-32600 structured rejection');
}

// ── Controls: the honest paths must be completely unaffected ──────────────────────────────────
console.log('\n▶ controls — ordinary ids must behave exactly as before');
for (const id of [1, 0, 'req-42', null, 'a$b']) {
  const { status, text } = await call(id);
  const parsed = parseSse(text);
  const sizeOk = text.length < AMPLIFICATION_LINE;
  const idOk = parsed.ok && parsed.value.id === id;
  console.log(`  id=${JSON.stringify(id)} status=${status} bytes=${text.length.toLocaleString()}`);
  if (status !== 200) bad(`expected HTTP 200 for id ${JSON.stringify(id)}, got ${status}`);
  else if (!sizeOk) bad(`ordinary id ${JSON.stringify(id)} produced an amplified body`);
  else if (!idOk) bad(`ordinary id ${JSON.stringify(id)} did not round-trip (${parsed.ok ? JSON.stringify(parsed.value.id) : parsed.why})`);
  else ok(`id ${JSON.stringify(id)} round-trips, body normal size`);
}

console.log('\n▶ control — a body just under the cap must still be served');
{
  const okBody = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { pad: 'A'.repeat(64 * 1024) } });
  const { status } = await post(okBody);
  console.log(`  request=${okBody.length.toLocaleString()} bytes status=${status}`);
  if (status !== 200) bad(`a ${okBody.length}-byte body was refused with ${status} — the cap is too tight`);
  else ok('served normally');
}

// Parse the `data:` payload out of an SSE frame (or a bare JSON body).
function parseSse(text) {
  try {
    if (!text.startsWith('event:')) return { ok: true, value: JSON.parse(text) };
    const line = text.split('\n').find((l) => l.startsWith('data: '));
    if (!line) return { ok: false, why: 'no data: line in the SSE frame' };
    return { ok: true, value: JSON.parse(line.slice(6)) };
  } catch (e) {
    return { ok: false, why: String(e && e.message) };
  }
}

if (failed) {
  console.error(`\n✗ test-idreplace-dos: ${failed} check(s) failed — the id-splice DoS surface is OPEN.`);
  process.exit(1);
}
console.log('\n✅ test-idreplace-dos: id splicing is literal (no pattern interpretation), container ids refused, batches refused, body cap enforced, honest paths unaffected.');
