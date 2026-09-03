// test-access-caps.mjs — WORKER-CAPS-1 (2026-09-03, audit WORK-1/WORK-2/WORK-3): runtime
// regression test for the /access/v1 body-size cap, the evaluations[] item cap, and the
// server.mjs 500-handler constant-ization.
//
// WHAT THIS PROVES (each block was RED on the unpatched tree — the red run is quoted in
// this row's PR body, per SO #34c):
//   1. WORK-1: every /access/v1 JSON parse (/access/v1/evaluation, /access/v1/evaluations,
//      /access/v1/search/{subject,resource,action}) is body-size capped at
//      MAX_REQUEST_BODY_BYTES = 1048576, with the byte-identical 413 rejection the /mcp
//      P1-2 branch returns — both via the declared Content-Length and via the post-read
//      backstop (a request with no Content-Length header).
//   2. WORK-2: authzenEvaluateBatch refuses evaluations[] over the stated engineering cap
//      (MAX_BATCH_EVALUATIONS = 64 — the AuthZEN 1.0 spec is silent on batch capacity per
//      its own §2, so this is a stated engineering cap, not spec guidance) with a
//      structured error — never silent truncation — and evaluates a full-cap batch intact.
//   3. WORK-3: server.mjs's legacy 500 handler returns the constant 'Internal error', not
//      String(e) — the internals-leak shape worker.mjs's C2 fix removed (source-level
//      assert; server.mjs is the dev-only surface and is not booted here).
//
// Runs the real worker.mjs default export against a lightweight local ASSETS stub backed by
// the committed ./data directory — the same instrument scripts/test-idreplace-dos.mjs uses.
// No network egress, no live endpoint hit. No env rate-limiter bindings, so the rate-limit
// branch (which runs FIRST in the worker, before the cap — unchanged ordering) no-ops and
// the cap behavior is measured directly.
//
// Usage: node scripts/test-access-caps.mjs

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { authzenEvaluateBatch } from '../_authzen.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const DATA_DIR = join(ROOT, 'data');

function assetsFetch(url) {
  // not reached by the /access/v1 routes, but the worker fetch entry expects the binding
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

// The spec'd values (from the WORKER-CAPS-1 row), NOT read from the code under test at
// runtime: a constant change in worker.mjs/_authzen.mjs without this file going red first
// would silently re-anchor the test to whatever the code says. The source asserts below
// force that reconciliation to be conscious.
const CAP = 1048576;              // MAX_REQUEST_BODY_BYTES (worker.mjs, P1-2)
const BATCH_CAP = 64;             // MAX_BATCH_EVALUATIONS (_authzen.mjs)

let failed = 0;
const ok   = (m) => console.log(`  ✓ ${m}`);
const bad  = (m) => { console.error(`  ✗ ${m}`); failed++; };
const eq   = (m, got, want) => (got === want ? ok(m) : bad(`${m} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`));

async function post(path, bodyText, headers = {}) {
  const req = new Request('https://mcp.ainumbers.co' + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: bodyText,
  });
  const res = await worker.fetch(req, env, { waitUntil: () => {}, passThroughOnException: () => {} });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = undefined; }
  return { status: res.status, text, json };
}

// A valid AuthZEN evaluation request padded to exactly `target` bytes (pure-ASCII pad, so
// UTF-16 code units === UTF-8 bytes — the same conservative direction as the worker's own
// length check). The pad rides at the TOP level, outside subject/action/resource, so the
// receipt preimage (and this test's runtime) stays small.
function paddedEvalRequest(target, extra = {}) {
  const skeleton = JSON.stringify({
    subject: { type: 'user', id: 'alice' },
    action: { name: 'read' },
    resource: { type: 'record', id: 'record-1' },
    pad: '@',
    ...extra,
  });
  const n = target - skeleton.length + 1;
  if (n < 1) throw new Error('target too small for the padded request skeleton');
  return JSON.stringify({
    subject: { type: 'user', id: 'alice' },
    action: { name: 'read' },
    resource: { type: 'record', id: 'record-1' },
    pad: 'a'.repeat(n),
    ...extra,
  });
}

const OVER_CAP_BODY = paddedEvalRequest(CAP + 4096);
const AT_CAP_BODY   = paddedEvalRequest(CAP);
if (AT_CAP_BODY.length !== CAP) throw new Error('fixture construction bug: AT_CAP_BODY is ' + AT_CAP_BODY.length + ' bytes');
if (OVER_CAP_BODY.length !== CAP + 4096) throw new Error('fixture construction bug: OVER_CAP_BODY is ' + OVER_CAP_BODY.length + ' bytes');

const aliceRead = JSON.stringify({
  subject: { type: 'user', id: 'alice' },
  action: { name: 'read' },
  resource: { type: 'record', id: 'record-1' },
});

console.log(`▶ /access/v1 caps — body cap ${CAP}, batch cap ${BATCH_CAP}`);

// ── 0) source anchors: the constants the behavior below asserts against ───────────────────────
{
  const workerSrc = readFileSync(join(ROOT, 'worker.mjs'), 'utf8');
  eq('worker.mjs defines the spec\'d MAX_REQUEST_BODY_BYTES',
     workerSrc.includes(`const MAX_REQUEST_BODY_BYTES = ${CAP};`), true);
  const azSrc = readFileSync(join(ROOT, '_authzen.mjs'), 'utf8');
  eq('_authzen.mjs defines the spec\'d MAX_BATCH_EVALUATIONS',
     azSrc.includes(`MAX_BATCH_EVALUATIONS = ${BATCH_CAP}`), true);
}

// ── 1) WORK-1: body cap on every /access/v1 JSON parse, rejection identical to /mcp P1-2 ──────
// The /mcp 413 is the parity anchor: byte-identical status + body on the /access/v1 routes.
const mcpOver = await post('/mcp', OVER_CAP_BODY, { 'Content-Length': String(OVER_CAP_BODY.length) });
eq('/mcp oversized (declared Content-Length) → 413', mcpOver.status, 413);
const MIRROR_BODY = mcpOver.text;

for (const path of ['/access/v1/evaluation', '/access/v1/evaluations']) {
  // a. declared Content-Length (byte-accurate pre-read check)
  const declared = await post(path, OVER_CAP_BODY, { 'Content-Length': String(OVER_CAP_BODY.length) });
  eq(`${path} oversized (declared) → 413`, declared.status, 413);
  eq(`${path} 413 body byte-identical to /mcp P1-2`, declared.text, MIRROR_BODY);
  // b. no Content-Length at all (post-read backstop; undici leaves the header null for a
  //    string body, which is exactly the chunked/absent-header case the backstop exists for)
  const backstop = await post(path, OVER_CAP_BODY);
  eq(`${path} oversized (no Content-Length) → 413`, backstop.status, 413);
  eq(`${path} backstop 413 body byte-identical to /mcp P1-2`, backstop.text, MIRROR_BODY);
}

for (const path of ['/access/v1/search/subject', '/access/v1/search/resource', '/access/v1/search/action']) {
  const declared = await post(path, OVER_CAP_BODY, { 'Content-Length': String(OVER_CAP_BODY.length) });
  eq(`${path} oversized (declared) → 413`, declared.status, 413);
  eq(`${path} 413 body byte-identical to /mcp P1-2`, declared.text, MIRROR_BODY);
  const backstop = await post(path, OVER_CAP_BODY);
  eq(`${path} oversized (no Content-Length) → 413`, backstop.status, 413);
}

// ── 2) no off-by-one: a body of EXACTLY the cap is legal and parses ───────────────────────────
{
  const atCap = await post('/access/v1/evaluation', AT_CAP_BODY, { 'Content-Length': String(CAP) });
  eq('exactly-cap body → 200 (not rejected)', atCap.status, 200);
  eq('exactly-cap body decides from the fixture policy (read → permit)', atCap.json?.decision, true);
  eq('exactly-cap body carries the receipt', typeof atCap.json?.context?.execution_hash, 'string');
}

// ── 3) routes still serve their normal traffic (cap must not over-reject) ─────────────────────
{
  const single = await post('/access/v1/evaluation', aliceRead);
  eq('small valid /access/v1/evaluation → 200', single.status, 200);
  eq('small valid evaluation → decision true', single.json?.decision, true);
  const batch2 = await post('/access/v1/evaluations', JSON.stringify({
    subject: { type: 'user', id: 'alice' }, resource: { type: 'record', id: 'record-1' },
    evaluations: [{ action: { name: 'read' } }, { action: { name: 'write' } }],
  }));
  eq('small valid /access/v1/evaluations → 200', batch2.status, 200);
  eq('small batch evaluates every item', batch2.json?.evaluations?.length, 2);
  const search = await post('/access/v1/search/subject', ''); // body accepted, not required
  eq('search with empty body → 200 (existing behavior preserved)', search.status, 200);
  eq('search returns the fixture entity set', search.json?.page?.count, 2);
}

// ── 4) WORK-2: evaluations[] item cap — structured over-cap error, never silent truncation ────
const items = (n) => Array.from({ length: n }, () => ({ action: { name: 'read' } }));
const batchBody = (n) => JSON.stringify({
  subject: { type: 'user', id: 'alice' }, resource: { type: 'record', id: 'record-1' },
  evaluations: items(n),
});
{
  const over = await post('/access/v1/evaluations', batchBody(BATCH_CAP + 1));
  eq(`batch of ${BATCH_CAP + 1} → 400`, over.status, 400);
  eq('over-cap batch error is structured (batch_too_large)', over.json?.context?.error, 'batch_too_large');
  eq('over-cap batch REFUSES the whole batch (no partial service)', over.json?.evaluations?.length ?? 0, 0);
  eq('over-cap error names the cap', /64/.test(over.json?.context?.detail ?? ''), true);

  const atCap = await post('/access/v1/evaluations', batchBody(BATCH_CAP));
  eq(`batch of exactly ${BATCH_CAP} → 200`, atCap.status, 200);
  eq(`exactly-cap batch evaluates every item (no truncation)`, atCap.json?.evaluations?.length, BATCH_CAP);
  eq('every at-cap item still carries its receipt', atCap.json?.evaluations?.every((e) => typeof e.context?.execution_hash === 'string'), true);

  // unit-level: the batch function itself, not just the route wrapper
  const unit = await authzenEvaluateBatch({
    subject: { type: 'user', id: 'alice' }, resource: { type: 'record', id: 'record-1' },
    evaluations: items(BATCH_CAP + 1),
  });
  eq('authzenEvaluateBatch over-cap → structured error', unit.context?.error, 'batch_too_large');
  eq('authzenEvaluateBatch over-cap → empty result set', unit.evaluations?.length ?? 0, 0);
}

// ── 5) WORK-3: server.mjs 500 handler constant-ized (source-level; dev-only surface) ──────────
{
  const src = readFileSync(join(ROOT, 'server.mjs'), 'utf8');
  eq('server.mjs 500 handler returns the constant message',
     src.includes(`message: 'Internal error'`), true);
  eq('server.mjs 500 handler no longer leaks String(e) into the response',
     src.includes(`message: String(e)`), false);
}

console.log(failed ? `\n✗ ${failed} assertion(s) failed` : '\n✓ all /access/v1 cap assertions passed');
process.exit(failed ? 1 : 0);
