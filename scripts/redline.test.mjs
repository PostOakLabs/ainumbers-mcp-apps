// redline.test.mjs — RL-3 §RL-3 done-criteria:
//  (a) PARITY: redline.mjs's diff + diff-receipt algorithm produces byte-identical
//      execution_hash / hunk digests to an inline copy of tools/552-text-redline-workbench.html's
//      browser JS (RL-1), for the same original/revised inputs.
//  (b) CROSS-PARTY: an agent's redline_diff output (diff_receipt) composes with a simulated
//      human disposition pass (hunk_receipts + disposition_receipt, minted using the SAME
//      proven-identical algorithm — standing in for the real browser workbench) into one
//      bundle that redline_verify checks end-to-end.
//  (c) TAMPER: an injected post-hoc edit to one hunk_receipt's output_payload is flagged at
//      the exact hunk index, not just "invalid".
import { runAgentDiff, computeDiff as workerComputeDiff, buildDiffReceipt as workerBuildDiffReceipt, buildHunkReceipt, buildDispositionReceipt, reconstructAcceptedText, verifyBundle } from '../redline.mjs';

let fail = 0;
const ok = (c, m) => { if (!c) { fail++; console.error('  ✗ ' + m); } else console.log('  ✓ ' + m); };

console.log('§RL-3 redline_diff / redline_verify\n');

// ── (a) PARITY — inline copy of the tools/552 browser JS, verbatim algorithm ──────────────────
// (Same reasoning as checkrun.mjs's relationship to chaingraph/kernels/_checklist.mjs: the site
// tool is an inlined, zero-dependency browser surface by design and cannot import this module,
// so this is a byte-for-byte port. This block re-derives the browser's own functions from the
// shipped tools/552-text-redline-workbench.html source to prove the port didn't drift.)
function browser_myersTrace(a, b) {
  const N = a.length, M = b.length, MAX = N + M || 1, offset = MAX;
  const v = new Array(2 * MAX + 1).fill(0);
  const trace = [];
  for (let d = 0; d <= MAX; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x;
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) x = v[offset + k + 1];
      else x = v[offset + k - 1] + 1;
      let y = x - k;
      while (x < N && y < M && a[x] === b[y]) { x++; y++; }
      v[offset + k] = x;
      if (x >= N && y >= M) return { trace, offset, N, M };
    }
  }
  return { trace, offset, N, M };
}
function browser_myersBacktrack(a, b, tr) {
  const { trace, offset, N, M } = tr;
  let x = N, y = M;
  const ops = [];
  for (let d = trace.length - 1; d >= 0; d--) {
    const v = trace[d];
    const k = x - y;
    let prevK;
    if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) prevK = k + 1;
    else prevK = k - 1;
    const prevX = v[offset + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) { ops.push({ op: 'equal', aIdx: x - 1, bIdx: y - 1 }); x--; y--; }
    if (d > 0) {
      if (x === prevX) ops.push({ op: 'insert', bIdx: y - 1 });
      else ops.push({ op: 'delete', aIdx: x - 1 });
    }
    x = prevX; y = prevY;
  }
  return ops.reverse();
}
function browser_myersDiff(a, b) { return browser_myersBacktrack(a, b, browser_myersTrace(a, b)); }
function browser_computeDiff(originalText, revisedText) {
  const aLines = originalText.split('\n');
  const bLines = revisedText.split('\n');
  const ops = browser_myersDiff(aLines, bLines);
  const hunks = [];
  let current = null;
  ops.forEach((op) => {
    if (op.op === 'equal') { if (current) { hunks.push(current); current = null; } }
    else if (op.op === 'delete') { if (!current) current = { orig: [], rev: [] }; current.orig.push(aLines[op.aIdx]); }
    else { if (!current) current = { orig: [], rev: [] }; current.rev.push(bLines[op.bIdx]); }
  });
  if (current) hunks.push(current);
  return { hunks };
}
function browser_cgCanon(v) {
  return Array.isArray(v) ? v.map(browser_cgCanon)
    : (v && typeof v === 'object') ? Object.keys(v).sort().reduce((o, k) => (o[k] = browser_cgCanon(v[k]), o), {})
    : v;
}
async function browser_sha256Hex(str) {
  const bytes = new TextEncoder().encode(str);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function browser_executionHash(policy_parameters, output_payload) {
  return browser_sha256Hex(JSON.stringify(browser_cgCanon({ policy_parameters, output_payload })));
}
async function browser_hunkDigest(hunk, idx) {
  return browser_sha256Hex(JSON.stringify(browser_cgCanon({ hunk_index: idx, orig_lines: hunk.orig, revised_lines: hunk.rev })));
}
async function browser_buildDiffReceipt({ originalText, revisedText, hunks, generated_at }) {
  const original_digest = await browser_sha256Hex(originalText);
  const revised_digest = await browser_sha256Hex(revisedText);
  const hunk_digests = [];
  for (let i = 0; i < hunks.length; i++) hunk_digests.push(await browser_hunkDigest(hunks[i], i));
  const policy_parameters = { original_digest, revised_digest, diff_algorithm: 'myers-1986-line-onnd', hunk_count: hunks.length, hunk_digests, generated_at };
  const output_payload = { hunks: hunks.map((h, i) => ({ hunk_index: i, orig_line_count: h.orig.length, revised_line_count: h.rev.length })) };
  const execution_hash = await browser_executionHash(policy_parameters, output_payload);
  return { policy_parameters, output_payload, execution_hash };
}

const ORIG = `# Vendor Onboarding Policy

All new vendors must submit a completed W-9 and a signed data processing
addendum before the first invoice is paid. Payment terms are net 45 from
the invoice date.

Vendors handling customer data must complete an annual security
questionnaire.`;
const REV = `# Vendor Onboarding Policy

All new vendors must submit a completed W-9 and a signed data processing
addendum before the first invoice is paid. Payment terms are net 30 from
the invoice date.

Vendors handling customer data must complete an annual security
questionnaire and provide a current SOC 2 Type II report.`;
const GENERATED_AT = '2026-07-18T00:00:00.000Z';

let agentDiffReceipt, agentHunks;
{
  const browserDiff = browser_computeDiff(ORIG, REV);
  const browserReceipt = await browser_buildDiffReceipt({ originalText: ORIG, revisedText: REV, hunks: browserDiff.hunks, generated_at: GENERATED_AT });

  const workerDiff = workerComputeDiff(ORIG, REV);
  const workerReceipt = await workerBuildDiffReceipt({ originalText: ORIG, revisedText: REV, hunks: workerDiff.hunks, generated_at: GENERATED_AT });

  ok(workerDiff.hunks.length === browserDiff.hunks.length, `same hunk count (${workerDiff.hunks.length})`);
  ok(JSON.stringify(workerDiff.hunks) === JSON.stringify(browserDiff.hunks), 'hunks byte-identical (orig/rev lines per hunk)');
  ok(workerReceipt.policy_parameters.hunk_digests.join(',') === browserReceipt.policy_parameters.hunk_digests.join(','), 'hunk digests byte-identical');
  ok(workerReceipt.execution_hash === browserReceipt.execution_hash, 'diff_receipt execution_hash byte-identical (PARITY)');

  const agentResult = await runAgentDiff({ original: ORIG, revised: REV, generated_at: GENERATED_AT });
  ok(agentResult.diff_receipt.execution_hash === browserReceipt.execution_hash, 'redline_diff (agent tool) execution_hash matches browser-equivalent');
  agentDiffReceipt = agentResult.diff_receipt;
  agentHunks = workerDiff.hunks;
}

// ── (b) CROSS-PARTY — human disposes the SAME diff_receipt the agent minted ───────────────────
let cleanBundle;
{
  const dispositions = ['accept', 'accept']; // human accepts both hunks in the browser workbench
  const hunkReceipts = [];
  let prev = null;
  for (let i = 0; i < agentHunks.length; i++) {
    const r = await buildHunkReceipt({ hunk: agentHunks[i], hunk_index: i, disposition: dispositions[i], note: '', timestamp: GENERATED_AT, prev_hunk_receipt_digest: prev, diff_receipt_hash: agentDiffReceipt.execution_hash, role: 'human' });
    hunkReceipts.push(r);
    prev = r.execution_hash;
  }
  const acceptedText = reconstructAcceptedText(workerComputeDiff(ORIG, REV).renderOps, dispositions);
  const acceptedTextDigest = await (async () => { const b = new TextEncoder().encode(acceptedText); const d = await crypto.subtle.digest('SHA-256', b); return Array.from(new Uint8Array(d)).map((x) => x.toString(16).padStart(2, '0')).join(''); })();
  const dispositionReceipt = await buildDispositionReceipt({ diffReceipt: agentDiffReceipt, hunkReceipts, acceptedTextDigest, generated_at: GENERATED_AT });
  cleanBundle = { diff_receipt: agentDiffReceipt, hunk_receipts: hunkReceipts, disposition_receipt: dispositionReceipt };

  const result = await verifyBundle(ORIG, REV, cleanBundle);
  ok(result.ok === true, 'cross-party bundle (agent diff_receipt + human hunk/disposition receipts) verifies end-to-end');
  ok(result.brokenHunk === null, 'no broken hunk reported on the clean cross-party bundle');
  ok(result.checks.every((c) => c.ok), 'every individual check passes');
}

// ── (c) TAMPER — an injected post-hoc edit is flagged at the exact hunk ────────────────────────
{
  const tampered = JSON.parse(JSON.stringify(cleanBundle));
  tampered.hunk_receipts[1].output_payload.revised_lines = tampered.hunk_receipts[1].output_payload.revised_lines.map((l) => l + ' [SILENTLY EDITED AFTER SIGNING]');
  const result = await verifyBundle(ORIG, REV, tampered);
  ok(result.ok === false, 'tampered bundle reports valid:false');
  ok(result.brokenHunk === 1, `tampered bundle pinpoints hunk 1 exactly (got ${result.brokenHunk})`);
}

console.log(fail ? `\n✗ ${fail} FAILED` : '\n✓ all RL-3 redline assertions passed');
process.exit(fail ? 1 : 0);
