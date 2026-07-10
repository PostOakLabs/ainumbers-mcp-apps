// iso24970-mapping.test.mjs — EXPORT-1 §E1.b (folded R1): OCG receipt -> ISO/IEC 24970 log record.
// DRAFT-PINNED module — see _iso24970.mjs header for the publication-date guard.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { receiptToIso24970LogRecord, DRAFT_REVISION } from '../_iso24970.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = JSON.parse(readFileSync(join(HERE, 'fixtures', 'anchor-binding.fixture.json'), 'utf8'));
const artifact = FIX.artifact;

let fail = 0;
const ok = (c, m) => { if (!c) { fail++; console.error('  ✗ ' + m); } else console.log('  ✓ ' + m); };

console.log('§E1.b ISO/IEC 24970 log-export mapping (DRAFT-PINNED)\n');

{
  const rec = receiptToIso24970LogRecord(artifact);
  ok(rec.log_record_version === DRAFT_REVISION, 'log_record_version stamps the pinned draft revision');
  ok(rec.timestamp === artifact.generated_at, 'timestamp reuses artifact.generated_at verbatim (no Date.now())');
  ok(rec.system_id === artifact.tool_id, 'system_id maps from tool_id');
  ok(rec.execution_hash === artifact.execution_hash, 'execution_hash carried verbatim');
  ok(rec.decision_outcome === artifact.output_payload.overall_status, 'decision_outcome maps from output_payload.overall_status');
  ok(JSON.stringify(rec.compliance_flags) === JSON.stringify(artifact.compliance_flags), 'compliance_flags carried verbatim, no additions');
  ok(rec.chain_depth === artifact.chain.chain_depth, 'chain_depth maps from chain.chain_depth');
  ok(rec.anchor_binding_present === true, 'anchor_binding_present true when anchor_bindings[] is non-empty');
}

// ── anchor_binding_present is false when absent (no fabricated claim) ────────────────────────────
{
  const noAnchor = { ...artifact, anchor_bindings: [] };
  const rec = receiptToIso24970LogRecord(noAnchor);
  ok(rec.anchor_binding_present === false, 'anchor_binding_present false when anchor_bindings is empty');
}

// ── proof_binding_present reflects audit_signature.proof presence, both shapes ───────────────────
{
  const withProof = { ...artifact, audit_signature: { proof: { type: 'DataIntegrityProof' } } };
  ok(receiptToIso24970LogRecord(withProof).proof_binding_present === true, 'proof_binding_present true for a single-proof object');
  const withProofArray = { ...artifact, audit_signature: { proof: [{ type: 'DataIntegrityProof' }] } };
  ok(receiptToIso24970LogRecord(withProofArray).proof_binding_present === true, 'proof_binding_present true for a non-empty proof array');
  const emptyProofArray = { ...artifact, audit_signature: { proof: [] } };
  ok(receiptToIso24970LogRecord(emptyProofArray).proof_binding_present === false, 'proof_binding_present false for an empty proof array');
  const noProof = { ...artifact, audit_signature: {} };
  ok(receiptToIso24970LogRecord(noProof).proof_binding_present === false, 'proof_binding_present false when no proof at all');
}

// ── determinism ────────────────────────────────────────────────────────────────────────────────
{
  const a = JSON.stringify(receiptToIso24970LogRecord(artifact));
  const b = JSON.stringify(receiptToIso24970LogRecord(artifact));
  ok(a === b, 'mapping is deterministic — identical input produces byte-identical output');
}

// ── required input ─────────────────────────────────────────────────────────────────────────────
{
  let threw = false;
  try { receiptToIso24970LogRecord({ ...artifact, generated_at: undefined }); } catch { threw = true; }
  ok(threw, 'throws without artifact.generated_at (never falls back to a fabricated timestamp)');
}

console.log(fail ? `\n✗ ${fail} FAILED` : '\n✓ all ISO/IEC 24970 mapping assertions passed');
process.exit(fail ? 1 : 0);
