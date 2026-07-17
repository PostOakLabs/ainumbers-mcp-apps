// checkrun.mjs — CHECKRUN-1 CR-4 shared logic for the worker's checklist/SOP MCP tools.
// Same algorithm as chaingraph/kernels/_checklist.mjs on the site repo (definition
// validation, definition digest, step/run receipt construction, RFC 6962 Merkle
// tree, chain verifier) — this file is the Worker's copy so an agent can validate a
// definition, verify a run, or mint a step receipt headlessly, producing byte-identical
// receipt shapes to the browser tools (same canonicalizer, same field order rules —
// JCS key-sorting makes field ORDER irrelevant to the hash either way).
//
// Reuses the vendored kernels (./kernels/_hash.mjs, ./kernels/_proof.mjs) — no second
// canonicalization or crypto path, same discipline as worker.mjs's own cgCanon/cgExecutionHash.
//
// Doctrine fence: these are RECEIPT-producing pure functions. No server state, no
// storage, no accounts. A "run" is caller-held; this module never persists anything.
import { cgCanon, executionHash } from './kernels/_hash.mjs';

export const CHECKLIST_CONTEXT = 'https://ainumbers.co/chaingraph/context/v0.3/context.jsonld';
export const CG_VERSION = '0.4.0';

const EVIDENCE_KINDS = new Set(['none', 'text', 'file-digest', 'attestation']);
const GATE_KINDS = new Set(['blocking', 'advisory']);

export function validateDefinition(def) {
  const errs = [];
  const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
  if (!isObj(def)) { errs.push('definition: must be an object'); return { valid: false, errors: errs }; }
  if (typeof def.definition_id !== 'string' || !def.definition_id) errs.push('definition_id: required non-empty string');
  if (typeof def.title !== 'string' || !def.title) errs.push('title: required non-empty string');
  if (typeof def.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(def.version)) errs.push('version: required semver string (x.y.z)');
  if (def.source_citation != null && typeof def.source_citation !== 'string') errs.push('source_citation: must be a string if present');
  if (def.mandate_hash != null && typeof def.mandate_hash !== 'string') errs.push('mandate_hash: must be a string (§22 work-mandate hash) if present');
  if (!Array.isArray(def.steps) || def.steps.length === 0) {
    errs.push('steps: required non-empty array');
  } else {
    const seenIds = new Set();
    def.steps.forEach((s, i) => {
      const p = `steps[${i}]`;
      if (!isObj(s)) { errs.push(`${p}: must be an object`); return; }
      if (typeof s.step_id !== 'string' || !s.step_id) errs.push(`${p}.step_id: required non-empty string`);
      else if (seenIds.has(s.step_id)) errs.push(`${p}.step_id: duplicate "${s.step_id}"`);
      else seenIds.add(s.step_id);
      if (typeof s.title !== 'string' || !s.title) errs.push(`${p}.title: required non-empty string`);
      if (typeof s.instruction !== 'string' || !s.instruction) errs.push(`${p}.instruction: required non-empty string`);
      if (!EVIDENCE_KINDS.has(s.evidence_requirement)) errs.push(`${p}.evidence_requirement: must be one of none|text|file-digest|attestation`);
      if (s.approver_role != null && typeof s.approver_role !== 'string') errs.push(`${p}.approver_role: must be a string if present`);
      if (!GATE_KINDS.has(s.gate)) errs.push(`${p}.gate: must be one of blocking|advisory`);
    });
  }
  return { valid: errs.length === 0, errors: errs };
}

export async function definitionDigest(def) {
  const stripped = { ...def };
  delete stripped.definition_digest;
  delete stripped.audit_signature;
  const bytes = new TextEncoder().encode(JSON.stringify(cgCanon(stripped)));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(str) {
  const bytes = new TextEncoder().encode(str);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}
export async function leafHash(contentHash) { return sha256Hex('leaf:' + String(contentHash ?? '')); }
export async function combineNodes(left, right) { return sha256Hex('node:' + left + ':' + right); }

export async function merkleRoot(leafContentHashes) {
  const n = leafContentHashes.length;
  if (n === 0) return sha256Hex('');
  if (n === 1) return leafHash(leafContentHashes[0]);
  let k = 1;
  while (k * 2 < n) k *= 2;
  const left = await merkleRoot(leafContentHashes.slice(0, k));
  const right = await merkleRoot(leafContentHashes.slice(k));
  return combineNodes(left, right);
}

export async function buildStepReceipt({ definition_digest, step, step_index, completer_key, timestamp, evidence, prev_step_receipt_digest }) {
  const policy_parameters = {
    definition_digest, step_id: step.step_id, step_index,
    completer_key: completer_key ?? null, timestamp, evidence: evidence ?? null,
    prev_step_receipt_digest: prev_step_receipt_digest ?? null,
  };
  const output_payload = {
    step_title: step.title, gate: step.gate, evidence_requirement: step.evidence_requirement,
    evidence_provided: step.evidence_requirement === 'none' ? true : !!evidence,
  };
  const execution_hash = await executionHash(policy_parameters, output_payload);
  return {
    '@context': CHECKLIST_CONTEXT, chaingraph_version: CG_VERSION, mandate_type: 'compliance_control',
    tool_id: 'checkrun-step-receipt', tool_version: '1.0.0', generated_at: timestamp, execution_hash,
    chain: {
      parent_hashes: prev_step_receipt_digest ? [prev_step_receipt_digest] : [],
      parent_tool_ids: prev_step_receipt_digest ? ['checkrun-step-receipt'] : [],
      chain_depth: step_index,
    },
    policy_parameters, output_payload,
    compliance_flags: step.gate === 'blocking' ? ['CHECKRUN_BLOCKING_GATE'] : ['CHECKRUN_ADVISORY_GATE'],
    compute_mode: 'server',
    audit_signature: { payloadType: 'application/vnd.openchain.graph+json;version=0.4', payload: '', signatures: [] },
  };
}

export async function buildRunReceipt({ definition_digest, run_id, started_at, completed_at, outcome, stepReceipts, escalation }) {
  const leaves = stepReceipts.map((r) => r.execution_hash);
  const merkle_root = await merkleRoot(leaves);
  const policy_parameters = { definition_digest, run_id, started_at, completed_at, outcome, step_count: stepReceipts.length };
  const output_payload = {
    merkle_root, merkle_algorithm: 'rfc6962',
    steps: stepReceipts.map((r, i) => ({ step_id: r.policy_parameters.step_id, index: i, execution_hash: r.execution_hash })),
    outcome, escalation: escalation ?? null,
  };
  const execution_hash = await executionHash(policy_parameters, output_payload);
  return {
    '@context': CHECKLIST_CONTEXT, chaingraph_version: CG_VERSION, mandate_type: 'compliance_control',
    tool_id: 'checkrun-run-receipt', tool_version: '1.0.0', generated_at: completed_at, execution_hash,
    chain: { parent_hashes: leaves, parent_tool_ids: stepReceipts.map(() => 'checkrun-step-receipt'), chain_depth: stepReceipts.length },
    policy_parameters, output_payload,
    compliance_flags: outcome === 'complete' ? ['CHECKRUN_COMPLETE'] : outcome === 'escalated' ? ['CHECKRUN_ESCALATED'] : ['CHECKRUN_ABORTED'],
    compute_mode: 'server',
    audit_signature: { payloadType: 'application/vnd.openchain.graph+json;version=0.4', payload: '', signatures: [] },
  };
}

export function buildEscalationReceipt({ definition_digest, subject_execution_hash, failing_rule_id, ar4si_tier, detail, generated_at }) {
  return {
    '@context': CHECKLIST_CONTEXT, chaingraph_version: CG_VERSION, receipt_type: 'failure_receipt',
    ar4si_tier: ar4si_tier ?? 'contraindicated', failing_rule_id, subject_execution_hash, definition_digest, generated_at, detail,
    spec_ref: 'OpenChainGraph SPEC.md §22.9 (IETF RATS EAR / AR4SI)',
    audit_signature: { payloadType: 'application/vnd.openchain.graph+json;version=0.4', payload: '', signatures: [] },
  };
}

export async function verifyRun({ runReceipt, stepReceipts }) {
  const stepResults = [];
  let brokenAt = null;
  let prevHash = null;
  for (let i = 0; i < stepReceipts.length; i++) {
    const r = stepReceipts[i];
    const recomputed = await executionHash(r.policy_parameters, r.output_payload);
    const hashOk = recomputed === r.execution_hash;
    const linkOk = i === 0
      ? (r.policy_parameters.prev_step_receipt_digest == null)
      : (r.policy_parameters.prev_step_receipt_digest === prevHash);
    const ok = hashOk && linkOk;
    if (!ok && brokenAt === null) brokenAt = i;
    stepResults.push({ index: i, step_id: r.policy_parameters.step_id, hash_ok: hashOk, link_ok: linkOk, ok, recomputed_hash: recomputed, stored_hash: r.execution_hash });
    prevHash = r.execution_hash;
  }
  const leaves = stepReceipts.map((r) => r.execution_hash);
  const recomputedRoot = await merkleRoot(leaves);
  // run_receipt is OPTIONAL here (unlike the browser Run Verifier, which always has one):
  // an agent mid-run may only hold step receipts so far. Absent a run_receipt, the Merkle/
  // run-hash checks are "not applicable" (true) rather than "failed" -- only the step chain
  // gates `valid` in that case. Supplying a run_receipt always re-enables both checks.
  const merkleOk = runReceipt ? recomputedRoot === (runReceipt?.output_payload?.merkle_root ?? null) : true;
  const runRecomputed = runReceipt ? await executionHash(runReceipt.policy_parameters, runReceipt.output_payload) : null;
  const runHashOk = runReceipt ? runRecomputed === runReceipt.execution_hash : true;
  const chainOk = stepResults.every((s) => s.ok);
  return {
    valid: chainOk && merkleOk && runHashOk,
    chain_ok: chainOk, merkle_ok: merkleOk, run_hash_ok: runHashOk,
    broken_at: brokenAt, recomputed_root: recomputedRoot, stored_root: runReceipt?.output_payload?.merkle_root ?? null,
    steps: stepResults,
  };
}
