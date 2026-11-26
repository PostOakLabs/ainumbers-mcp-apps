#!/usr/bin/env node
// test-hash-null-never-matches.mjs — HASH-NULL-NEVER-MATCHES-1.
//
// The site SSOT hasher (kernels/_hash.mjs, vendored here on each refresh) is moving from "throw on
// a preimage it cannot canonicalize" to "return null" (site HASH-REFUSAL-SHARED-1). A receipt
// minted from such a payload carries `execution_hash: null`, and every recompute of it is null too.
// With a bare `recomputed === receipt.execution_hash` the worker's verifiers read null === null as
// a MATCH and report a receipt nobody could hash as intact. This test proves they no longer do.
//
//   1. hashesMatch() unit truth table: null/undefined/''/non-string on the recomputed side never
//      matches, a real equal digest does.
//   2. Live verifiers under the null-returning hasher: checkrun.mjs, redline.mjs and otelspan.mjs
//      are copied into a scratch dir next to a stub kernels/_hash.mjs whose executionHash() returns
//      null (the post-HASH-REFUSAL-SHARED-1 refusal), every other export re-exported from the real
//      vendored file. Receipts are minted AND verified there, so every claimed and every recomputed
//      hash is null. Each hash check must come back false.
//   3. Mutation control: the same scratch run with a naive `a === b` hash-match.mjs must report the
//      hash checks as passing. That proves the verifiers really route through hashesMatch() and
//      that check 2 is not vacuous.
//   4. Source pin: worker.mjs's two kernel round-trip self-checks call hashesMatch(), and no raw
//      `<recomputed> === <x>.execution_hash` comparison is left in the four worker modules.
//
// No network, no packages beyond Node built-ins.

import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { hashesMatch } from '../hash-match.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let failed = 0;
const ok = (cond, msg) => { if (cond) console.log('  ✓ ' + msg); else { failed++; console.error('  ✗ ' + msg); } };

// ── 1. truth table ────────────────────────────────────────────────────────────────────────────
console.log('▸ hashesMatch truth table');
const H = 'a'.repeat(64);
ok(hashesMatch(null, null) === false, 'null vs null is NOT a match');
ok(hashesMatch(undefined, undefined) === false, 'undefined vs undefined is NOT a match');
ok(hashesMatch(undefined, null) === false, 'undefined vs null is NOT a match');
ok(hashesMatch('', '') === false, "'' vs '' is NOT a match");
ok(hashesMatch(null, H) === false, 'null recompute vs a real claim is NOT a match');
ok(hashesMatch(0, 0) === false && hashesMatch(false, false) === false, 'non-string equal values are NOT a match');
ok(hashesMatch(H, null) === false, 'real recompute vs null claim is NOT a match');
ok(hashesMatch(H, 'b'.repeat(64)) === false, 'two different digests do not match');
ok(hashesMatch(H, H) === true, 'equal non-empty digests match');

// ── 2 + 3. live verifiers under a null-returning hasher ──────────────────────────────────────
const REAL_HASH = pathToFileURL(join(ROOT, 'kernels', '_hash.mjs')).href;
const REAL_PROOF = pathToFileURL(join(ROOT, 'kernels', '_proof.mjs')).href;

function scratch(matchSource) {
  const dir = mkdtempSync(join(tmpdir(), 'hash-null-'));
  mkdirSync(join(dir, 'kernels'));
  for (const f of ['checkrun.mjs', 'redline.mjs', 'otelspan.mjs']) copyFileSync(join(ROOT, f), join(dir, f));
  // A local export shadows the star re-export (ECMA-262 ResolveExport), so only executionHash changes.
  writeFileSync(join(dir, 'kernels', '_hash.mjs'),
    `export * from ${JSON.stringify(REAL_HASH)};\n` +
    `export async function executionHash() { return null; }\n`);
  writeFileSync(join(dir, 'kernels', '_proof.mjs'), `export * from ${JSON.stringify(REAL_PROOF)};\n`);
  writeFileSync(join(dir, 'hash-match.mjs'), matchSource);
  return dir;
}

const TS = '2026-11-25T00:00:00.000Z';
const ORIG = 'alpha\nbravo\ncharlie\n';
const REV = 'alpha\nBRAVO\ncharlie\ndelta\n';
const sha256Hex = async (s) => {
  const d = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, '0')).join('');
};

async function runVerifiers(dir) {
  const imp = (f) => import(pathToFileURL(join(dir, f)).href);
  const checkrun = await imp('checkrun.mjs');
  const redline = await imp('redline.mjs');
  const otel = await imp('otelspan.mjs');
  const out = {};

  // checkrun: one step receipt minted under the null hasher, plus a run receipt claiming null.
  const step = { step_id: 's1', title: 'Step one', gate: 'advisory', evidence_requirement: 'none' };
  const sr = await checkrun.buildStepReceipt({ definition_digest: 'd'.repeat(64), step, step_index: 0, timestamp: TS });
  out.minted_null = sr.execution_hash === null;
  const runReceipt = { policy_parameters: { run_id: 'r1' }, output_payload: { merkle_root: null }, execution_hash: null };
  const cr = await checkrun.verifyRun({ runReceipt, stepReceipts: [sr] });
  out.checkrun_step_hash_ok = cr.chain_ok;
  out.checkrun_run_hash_ok = cr.run_hash_ok;

  // redline: a full cross-party bundle minted under the null hasher.
  const agent = await redline.runAgentDiff({ original: ORIG, revised: REV, generated_at: TS });
  const hunks = redline.computeDiff(ORIG, REV).hunks;
  const dispositions = hunks.map(() => 'accept');
  const hunkReceipts = [];
  let prev = null;
  for (let i = 0; i < hunks.length; i++) {
    const r = await redline.buildHunkReceipt({ hunk: hunks[i], hunk_index: i, disposition: dispositions[i], note: '', timestamp: TS, prev_hunk_receipt_digest: prev, diff_receipt_hash: agent.diff_receipt.execution_hash, role: 'human' });
    hunkReceipts.push(r);
    prev = r.execution_hash;
  }
  const accepted = redline.reconstructAcceptedText(redline.computeDiff(ORIG, REV).renderOps, dispositions);
  const disposition = await redline.buildDispositionReceipt({ diffReceipt: agent.diff_receipt, hunkReceipts, acceptedTextDigest: await sha256Hex(accepted), generated_at: TS });
  const rv = await redline.verifyBundle(ORIG, REV, { diff_receipt: agent.diff_receipt, hunk_receipts: hunkReceipts, disposition_receipt: disposition });
  const byLabel = (needle) => rv.checks.find((c) => c.label.includes(needle));
  out.redline_hunks = hunks.length;
  out.redline_diff_hash_ok = byLabel('diff_receipt execution_hash')?.ok;
  out.redline_disposition_hash_ok = byLabel('disposition_receipt execution_hash')?.ok;
  out.redline_hunk_detail = rv.checks.filter((c) => c.label.startsWith('hunk ')).map((c) => c.detail);
  out.redline_bundle_ok = rv.ok;

  // otelspan: a trace receipt whose execution_hash is null.
  const trace = { resourceSpans: [{ scopeSpans: [{ spans: [{ traceId: '1'.repeat(32), spanId: '2'.repeat(16), name: 'step' }] }] }] };
  const ov = await otel.verifySpanReceiptBundle({ trace, span_receipts: [], trace_receipt: { policy_parameters: { a: 1 }, output_payload: { b: 2 }, execution_hash: null } });
  out.otel_trace_exec_hash_ok = ov.trace_receipt_exec_hash_ok;
  return out;
}

console.log('\n▸ verifiers under a null-returning executionHash (fixed hash-match.mjs)');
const fixedDir = scratch(readFileSync(join(ROOT, 'hash-match.mjs'), 'utf8'));
try {
  const r = await runVerifiers(fixedDir);
  ok(r.minted_null === true, 'precondition: the stub hasher really mints execution_hash: null');
  ok(r.checkrun_step_hash_ok === false, 'checkrun verifyRun: a null step hash is not a match (chain_ok false)');
  ok(r.checkrun_run_hash_ok === false, 'checkrun verifyRun: a null run-receipt hash is not a match (run_hash_ok false)');
  ok(r.redline_hunks > 0, `precondition: the redline diff has hunks (${r.redline_hunks})`);
  ok(r.redline_diff_hash_ok === false, 'redline verifyBundle: diff_receipt null hash is not a match');
  ok(r.redline_disposition_hash_ok === false, 'redline verifyBundle: disposition_receipt null hash is not a match');
  ok(r.redline_hunk_detail.length > 0 && r.redline_hunk_detail.every((d) => typeof d === 'string' && d.includes('exec_hash_ok=false')), 'redline verifyBundle: every hunk receipt null hash is not a match');
  ok(r.redline_bundle_ok === false, 'redline verifyBundle: a bundle of null hashes does NOT verify');
  ok(r.otel_trace_exec_hash_ok === false, 'otelspan verifySpanReceiptBundle: a null trace_receipt hash is not a match');
} finally { rmSync(fixedDir, { recursive: true, force: true }); }

console.log('\n▸ mutation control: naive `a === b` hash-match.mjs must let the null hashes through');
const naiveDir = scratch('export function hashesMatch(a, b) { return a === b; }\n');
try {
  const r = await runVerifiers(naiveDir);
  const passedThrough = r.checkrun_step_hash_ok === true && r.checkrun_run_hash_ok === true
    && r.redline_diff_hash_ok === true && r.redline_disposition_hash_ok === true
    && r.redline_bundle_ok === true && r.otel_trace_exec_hash_ok === true;
  ok(passedThrough, 'with null === null the defect reproduces (every hash check passes, the redline bundle verifies) — the verifiers depend on hashesMatch()');
} finally { rmSync(naiveDir, { recursive: true, force: true }); }

// ── 4. source pin ────────────────────────────────────────────────────────────────────────────
console.log('\n▸ source pin');
const worker = readFileSync(join(ROOT, 'worker.mjs'), 'utf8');
const roundTrips = worker.match(/const hash_valid = hashesMatch\(recomputed, artifact\.execution_hash\);/g) ?? [];
ok(roundTrips.length === 2, `worker.mjs: both kernel round-trip self-checks use hashesMatch() (found ${roundTrips.length})`);
const RAW = /\b\w*(?:recomputed|Recomputed|recheck)\w*\s*===\s*[\w.?]*execution_hash\b/;
for (const f of ['worker.mjs', 'checkrun.mjs', 'redline.mjs', 'otelspan.mjs']) {
  const src = readFileSync(join(ROOT, f), 'utf8');
  const hit = src.split('\n').findIndex((l) => RAW.test(l));
  ok(hit === -1, `${f}: no raw recomputed === execution_hash comparison${hit === -1 ? '' : ' (line ' + (hit + 1) + ')'}`);
  ok(/import\s*\{\s*hashesMatch\s*\}\s*from\s*'\.\/hash-match\.mjs'/.test(src), `${f}: imports hashesMatch from ./hash-match.mjs`);
}

if (failed) {
  console.error(`\n✗ test-hash-null-never-matches: ${failed} failure(s).`);
  process.exit(1);
}
console.log('\n✅ test-hash-null-never-matches: a null hash never counts as a match.');
