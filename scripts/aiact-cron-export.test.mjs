// aiact-cron-export.test.mjs — MONDAY-SHIP §AC AIACT-CRON: exercises the composed AI-Act Art-12
// evidence export end-to-end (art-236 decision-log build -> OSCAL export -> ISO/IEC 24970 export
// -> anchor-lineage receipt). No new kernel, no chaingraph.json touch — pure composition of
// shipped primitives on the live GAP-d cron substrate.
import { runAiActEvidenceExport, SAMPLE_DECISION } from '../_aiact_cron.mjs';
import { verify as verifyReceipt, didKeyToPublicKey } from '../kernels/_proof.mjs';

let fail = 0;
const ok = (c, m) => { if (!c) { fail++; console.error('  ✗ ' + m); } else console.log('  ✓ ' + m); };

console.log('AIACT-CRON — art-236 -> OSCAL + ISO/IEC 24970 export -> anchor-lineage receipt\n');

const nowMs = Date.parse('2026-07-14T06:00:00.000Z');
const result = await runAiActEvidenceExport(SAMPLE_DECISION, nowMs);

// art-236 artifact
ok(/^[0-9a-f]{64}$/.test(result.artifact.execution_hash), 'art-236 execution_hash is a well-formed hex SHA-256');
ok(result.artifact.output_payload.record_status === 'COMPLETE', 'art-236 record_status COMPLETE for the demo fixture');
ok(result.artifact.output_payload.art12_fields_present === true, 'art-236 Art 12(2) required fields present');

// OSCAL export (§E1.a) — pure re-expression, no new claim
ok(result.oscal['assessment-results'].metadata.props.some((p) => p.name === 'ocg-execution-hash' && p.value === result.artifact.execution_hash),
  'OSCAL metadata props carry the exact art-236 execution_hash (re-expression, not a new claim)');
ok(result.oscal['assessment-results'].results[0].observations.length === (result.artifact.output_payload.checks?.length ?? 0),
  'OSCAL observations count matches artifact checks (art-236 has no .checks field, so 0 is correct here)');
ok(result.oscal['assessment-results'].results[0]['reviewed-controls'].remarks.includes('No control-catalog mapping is asserted'),
  'OSCAL export carries the no-control-mapping disclaimer verbatim');

// ISO/IEC 24970 export (§E1.b) — DRAFT-PINNED
ok(result.iso24970.execution_hash === result.artifact.execution_hash, 'ISO/IEC 24970 record execution_hash matches the art-236 artifact');
// _iso24970.mjs reads decision_outcome off output_payload.overall_status, a field art-236 does
// not emit (that field belongs to gate-style kernels) — pure re-expression means it stays null
// here rather than being backfilled from decision_label (no new claim beyond what's on the record).
ok(result.iso24970.decision_outcome === null, 'ISO/IEC 24970 decision_outcome is null (art-236 has no output_payload.overall_status — no claim fabricated)');
ok(result.iso24970.log_record_version === 'iso-iec-24970-working-draft-2026-07', 'ISO/IEC 24970 log_record_version is the pinned draft revision');

// Anchor-lineage receipt (kernels/_proof.mjs eddsa-jcs-2022, ephemeral did:key — same signer §RW uses)
ok(result.receipt.aiact_evidence_receipt === 'v1', 'receipt carries the aiact_evidence_receipt version tag');
ok(result.receipt.artifact_ref === result.artifact.execution_hash, 'receipt artifact_ref points at the art-236 execution_hash, not a re-signed copy');
ok(Array.isArray(result.receipt.audit_signature?.proof) ? result.receipt.audit_signature.proof.length > 0 : !!result.receipt.audit_signature?.proof,
  'receipt carries a non-empty audit_signature.proof');

const pubKey = await didKeyToPublicKey(result.verificationMethod);
const verified = await verifyReceipt(result.receipt, pubKey);
ok(verified === true, 'receipt signature verifies against its own did:key verificationMethod');

console.log(fail ? `\n${fail} FAILED` : '\nAll checks passed.');
process.exit(fail ? 1 : 0);
