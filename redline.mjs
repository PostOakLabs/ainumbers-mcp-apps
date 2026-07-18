// redline.mjs — RL-3 shared logic for the worker's redline/diff-receipt MCP tools.
// Same algorithm as tools/552-text-redline-workbench.html (RL-1/RL-2) on the site repo —
// hand-rolled Myers (1986) O(ND) line diff, hunk grouping, diff receipt, per-hunk
// disposition receipts, disposition receipt binding the accepted-text digest, and the
// independent verifier — ported here (not imported: the site tool is an inlined,
// zero-dependency browser surface by design, same discipline as checkrun.mjs/_checklist.mjs)
// so an AGENT can propose a diff headlessly and interleave with a HUMAN's browser-produced
// hunk/disposition receipts on the SAME document. Byte-identical parity to RL-1's output for
// the same inputs is what makes that interleave valid — proven by the parity fixture in
// scripts/redline-parity-fixture.mjs.
//
// Reuses the vendored kernels/_hash.mjs canonicalizer — no second canonicalization path,
// same discipline as worker.mjs's own cgCanon/cgExecutionHash and checkrun.mjs.
//
// Doctrine fence: pure functions over caller-supplied text. No server state, no storage.
import { cgCanon, executionHash } from './kernels/_hash.mjs';

async function sha256Hex(str) {
  const bytes = new TextEncoder().encode(str);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ── Hand-rolled Myers (1986) O(ND) line diff — zero-dep, deterministic. ──
// Identical tie-break rule to the browser tool (prefer larger x; ties toward
// insert-before-delete via the k===-d/k!==d guard), so identical inputs always
// produce identical edit scripts on both runtimes.
function myersTrace(a, b) {
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
function myersBacktrack(a, b, tr) {
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
function myersDiff(a, b) { return myersBacktrack(a, b, myersTrace(a, b)); }

// Group the op stream into replace-hunks + a flat renderOps list — pure function of
// (originalLines, revisedLines), so any caller with only the original+revised text can
// regenerate identical hunks with no help from a receipt bundle.
export function computeDiff(originalText, revisedText) {
  const aLines = originalText.split('\n');
  const bLines = revisedText.split('\n');
  const ops = myersDiff(aLines, bLines);
  const hunks = [];
  const renderOps = [];
  let current = null;
  ops.forEach((op) => {
    if (op.op === 'equal') {
      if (current) { hunks.push(current); current = null; }
      renderOps.push({ type: 'equal', text: aLines[op.aIdx] });
    } else if (op.op === 'delete') {
      if (!current) current = { orig: [], rev: [] };
      current.orig.push(aLines[op.aIdx]);
      renderOps.push({ type: 'del', text: aLines[op.aIdx], hunkIndex: hunks.length });
    } else {
      if (!current) current = { orig: [], rev: [] };
      current.rev.push(bLines[op.bIdx]);
      renderOps.push({ type: 'ins', text: bLines[op.bIdx], hunkIndex: hunks.length });
    }
  });
  if (current) hunks.push(current);
  return { aLines, bLines, ops, hunks, renderOps };
}

export async function hunkDigest(hunk, idx) {
  return sha256Hex(JSON.stringify(cgCanon({ hunk_index: idx, orig_lines: hunk.orig, revised_lines: hunk.rev })));
}

export function reconstructAcceptedText(renderOps, dispositions) {
  const out = [];
  renderOps.forEach((ro) => {
    if (ro.type === 'equal') { out.push(ro.text); return; }
    const disp = dispositions[ro.hunkIndex] || 'reject';
    if (ro.type === 'del') { if (disp === 'reject' || disp === 'comment') out.push(ro.text); }
    else { if (disp === 'accept') out.push(ro.text); }
  });
  return out.join('\n');
}

// Diff receipt — produced once, at diff time. compute_mode:'server' (no reviewer keypair on
// the worker; the browser tool's audit_signature is the one that carries an eddsa signature —
// same "signed:false, still tamper-evident via the hash chain" story as CHECKRUN-1's unsigned
// placeholder for a browser feature the server side doesn't have).
export async function buildDiffReceipt({ originalText, revisedText, hunks, generated_at }) {
  const original_digest = await sha256Hex(originalText);
  const revised_digest = await sha256Hex(revisedText);
  const hunk_digests = [];
  for (let i = 0; i < hunks.length; i++) hunk_digests.push(await hunkDigest(hunks[i], i));
  const policy_parameters = { original_digest, revised_digest, diff_algorithm: 'myers-1986-line-onnd', hunk_count: hunks.length, hunk_digests, generated_at };
  const output_payload = { hunks: hunks.map((h, i) => ({ hunk_index: i, orig_line_count: h.orig.length, revised_line_count: h.rev.length })) };
  const execution_hash = await executionHash(policy_parameters, output_payload);
  return {
    tool_id: 'redline-diff-receipt', tool_version: '1.0.0', generated_at,
    policy_parameters, output_payload, execution_hash, compute_mode: 'server',
    audit_signature: { payloadType: 'application/vnd.ainumbers.redline-diff-receipt+json;version=1', algorithm: null, reviewer_public_key: null, signature: null, signed: false, note: 'Minted server-side (redline_diff MCP tool) — no reviewer keypair here; tamper-evident via the hash chain, matching the browser tool\'s unsigned fallback shape.' },
  };
}

export async function buildHunkReceipt({ hunk, hunk_index, disposition, note, timestamp, prev_hunk_receipt_digest, diff_receipt_hash, role }) {
  const hunk_digest = await hunkDigest(hunk, hunk_index);
  const policy_parameters = { diff_receipt_hash, hunk_index, hunk_digest, disposition, note: note || null, timestamp, prev_hunk_receipt_digest: prev_hunk_receipt_digest || null, role: role || 'human' };
  const output_payload = { orig_lines: hunk.orig, revised_lines: hunk.rev };
  const execution_hash = await executionHash(policy_parameters, output_payload);
  return { tool_id: 'redline-hunk-receipt', policy_parameters, output_payload, execution_hash };
}

export async function buildDispositionReceipt({ diffReceipt, hunkReceipts, acceptedTextDigest, generated_at }) {
  const policy_parameters = { diff_receipt_hash: diffReceipt.execution_hash, hunk_count: hunkReceipts.length, generated_at };
  const output_payload = {
    accepted_text_digest: acceptedTextDigest,
    dispositions: hunkReceipts.map((r, i) => ({ hunk_index: i, disposition: r.policy_parameters.disposition, execution_hash: r.execution_hash, role: r.policy_parameters.role || 'human' })),
    chain_head: hunkReceipts.length ? hunkReceipts[hunkReceipts.length - 1].execution_hash : null,
  };
  const execution_hash = await executionHash(policy_parameters, output_payload);
  return { tool_id: 'redline-disposition-receipt', tool_version: '1.0.0', generated_at, policy_parameters, output_payload, execution_hash };
}

// Agent-proposal pipeline (redline_diff MCP tool): an agent diffs original vs. its own
// proposed revision and returns the diff + diff receipt, ready for a human to disposition
// in the browser workbench (RL-1) against the SAME original/revised text — the diff_receipt's
// execution_hash is what the human side's hunk receipts reference as diff_receipt_hash.
export async function runAgentDiff({ original, revised, generated_at }) {
  const diff = computeDiff(original, revised);
  const diffReceipt = await buildDiffReceipt({ originalText: original, revisedText: revised, hunks: diff.hunks, generated_at });
  return {
    diff_receipt: diffReceipt,
    hunk_count: diff.hunks.length,
    hunks: diff.hunks.map((h, i) => ({ hunk_index: i, orig_lines: h.orig, revised_lines: h.rev })),
  };
}

// Independent verifier (redline_verify MCP tool / RL-2 parity): recomputes everything from
// the pasted original+revised text and a receipt bundle, never trusting a bundle claim
// without checking it against a fresh hash/digest. Cross-party aware: a hunk_receipt's
// role may be 'agent' or 'human' and either can supply the prev_hunk_receipt_digest link —
// the chain-link check only cares that it matches the PRECEDING receipt in hunk_receipts,
// regardless of which party minted which entry, which is exactly what lets an agent's
// proposal receipts and a human's disposition receipts interleave on one document.
export async function verifyBundle(originalText, revisedText, bundle) {
  const checks = [];
  let brokenHunk = null;
  const { diff_receipt, hunk_receipts, disposition_receipt } = bundle || {};

  if (!diff_receipt || !Array.isArray(hunk_receipts) || !disposition_receipt) {
    return { ok: false, checks: [{ label: 'Bundle shape', ok: false, detail: 'Missing diff_receipt, hunk_receipts, or disposition_receipt.' }], brokenHunk: null };
  }

  const diff = computeDiff(originalText, revisedText);
  const recomputedOriginalDigest = await sha256Hex(originalText);
  const recomputedRevisedDigest = await sha256Hex(revisedText);
  checks.push({ label: 'original_digest matches supplied original text', ok: recomputedOriginalDigest === diff_receipt.policy_parameters.original_digest });
  checks.push({ label: 'revised_digest matches supplied revised text', ok: recomputedRevisedDigest === diff_receipt.policy_parameters.revised_digest });
  checks.push({ label: 'hunk_count matches recomputed diff', ok: diff.hunks.length === diff_receipt.policy_parameters.hunk_count });

  const diffReceiptRecomputed = await executionHash(diff_receipt.policy_parameters, diff_receipt.output_payload);
  checks.push({ label: 'diff_receipt execution_hash recomputes', ok: diffReceiptRecomputed === diff_receipt.execution_hash });

  if (diff_receipt.audit_signature && diff_receipt.audit_signature.signed) {
    checks.push({ label: 'diff_receipt eddsa signature', ok: false, detail: 'Signature verification requires a browser WebCrypto Ed25519 import; not checked by this server-side verifier.' });
  } else {
    checks.push({ label: 'diff_receipt eddsa signature', ok: true, detail: 'Not signed in this bundle — hash-chain checks below still apply.' });
  }

  let prev = null;
  const dispositions = [];
  for (let i = 0; i < Math.max(diff.hunks.length, hunk_receipts.length); i++) {
    const r = hunk_receipts[i];
    if (!r) { checks.push({ label: `hunk ${i} receipt present`, ok: false }); brokenHunk = brokenHunk === null ? i : brokenHunk; continue; }
    const recomputedDigest = diff.hunks[i] ? await hunkDigest(diff.hunks[i], i) : null;
    const digestOk = recomputedDigest !== null && recomputedDigest === r.policy_parameters.hunk_digest;
    const recomputedExecHash = await executionHash(r.policy_parameters, r.output_payload);
    const execHashOk = recomputedExecHash === r.execution_hash;
    const linkOk = i === 0 ? (r.policy_parameters.prev_hunk_receipt_digest === null) : (r.policy_parameters.prev_hunk_receipt_digest === prev);
    const ok = digestOk && execHashOk && linkOk;
    if (!ok && brokenHunk === null) brokenHunk = i;
    checks.push({ label: `hunk ${i} (${r.policy_parameters.role || 'human'}): digest recomputes, receipt hash intact, chain-linked`, ok, detail: ok ? null : `digest_ok=${digestOk} exec_hash_ok=${execHashOk} link_ok=${linkOk}` });
    prev = r.execution_hash;
    dispositions[i] = r.policy_parameters.disposition;
  }

  const dispositionReceiptRecomputed = await executionHash(disposition_receipt.policy_parameters, disposition_receipt.output_payload);
  checks.push({ label: 'disposition_receipt execution_hash recomputes', ok: dispositionReceiptRecomputed === disposition_receipt.execution_hash });

  const acceptedText = reconstructAcceptedText(diff.renderOps, dispositions);
  const acceptedTextDigest = await sha256Hex(acceptedText);
  checks.push({ label: 'accepted-text digest recomputes from original + accepted hunks', ok: acceptedTextDigest === disposition_receipt.output_payload.accepted_text_digest });

  const allOk = checks.every((c) => c.ok);
  return { ok: allOk, checks, brokenHunk, accepted_text: acceptedText, accepted_text_digest: acceptedTextDigest };
}
