// _aiact_cron.mjs — MONDAY-SHIP §AC: AI-Act Art-12 evidence cron.
//
// Composes three already-shipped primitives on the live GAP-d weekly cron tick — mints nothing
// new, no new MCP tool, no tool-registry touch:
//   1. art-236 kernel (build_ai_decision_log_record) — the Art 12(2) decision-log builder,
//      unmodified. Produces the OCG artifact this export re-expresses.
//   2. EXPORT-1 §E1.a/§E1.b mappings — _oscal.mjs (receiptToOscalAssessmentResults, pinned OSCAL
//      1.1.3) + _iso24970.mjs (receiptToIso24970LogRecord, DRAFT-PINNED
//      iso-iec-24970-working-draft-2026-07). Both are PURE RE-EXPRESSIONS of what the art-236
//      artifact already proves — this module mints no new finding/trust claim in translation
//      (EXPORT-1 §E1.a semantics rule, carried into §AC).
//   3. kernels/_proof.mjs eddsa-jcs-2022 sign() — the SAME ephemeral-did:key receipt signer
//      §RW's _reserve_watch.mjs and GAP-a's renewal-watch checkpoint use. This anchors the
//      export bundle by signing a receipt that references the OSCAL/24970 payloads' own
//      execution_hash-derived digest — it is NOT a fresh RFC 3161/JAdES timestamp token. Minting
//      a fresh TSA timestamp from this worker is explicitly FLAGGED, same as _blta.mjs's renewal
//      path and _reserve_watch.mjs's anchor-lineage note: no TSA-request integration exists here
//      (zero-fetch, free-plan, no KV/D1/R2), and inventing one would be a new crypto primitive
//      this band's "borrow-not-depend / no new primitives" rule guards against. A real RFC 3161
//      timestamp over this bundle is anchor-suite's job (anchor.ainumbers.co), same as every
//      other §20 binding.
//
// Ingestion note (honest, matches §RW's standard of not overclaiming): no live decision-event
// feed is wired — this worker has no persistent artifact registry (no KV/D1/R2 binding) to hold
// a real window of decision receipts. Each weekly tick runs the SAME demo-fixture decision below,
// which proves the full plumbing (art-236 build -> OSCAL export -> ISO/IEC 24970 export ->
// anchor-lineage receipt -> envelope) fires live ahead of a real high-risk-system decision-log
// feed integration. Wiring an actual per-decision ingest source is a follow-on WU once a live
// Annex III system (credit scoring / insurance pricing) is onboarded.

import { buildArtifact as buildDecisionLogArtifact, meta as decisionLogMeta }
  from './kernels/art-236-build-ai-decision-log-record.kernel.mjs';
import { receiptToOscalAssessmentResults, OSCAL_MAPPING_VERSION } from './_oscal.mjs';
import { receiptToIso24970LogRecord, DRAFT_REVISION as ISO24970_DRAFT_REVISION } from './_iso24970.mjs';
import { sign, rawPubkeyToDidKey } from './kernels/_proof.mjs';

// Demo-fixture Art 12(2) decision — a clean COMPLETE-shaped record (Annex III 5(b)
// creditworthiness), zero-PII subject_ref, no override. Exercises the full compute path; swap
// for a real per-decision ingest once a live Annex III system feed exists (see header note).
export const SAMPLE_DECISION = Object.freeze({
  model_id: 'sample-credit-scoring-model',
  model_version: '2026.1.0',
  input_digest: 'a3f2c9e1b4d6087f5a2e9c1b3d7f0846a1c5e8b2d4f60937a1c5e8b2d4f60937',
  output_digest: 'c9e1b4d6087fa3f25a2e9c1b3d7f0846a1c5e8b2d4f60937a1c5e8b2d4f6093',
  decision_label: 'CREDIT_APPROVED',
  confidence: 0.87,
  override_flag: false,
  subject_ref: 'case-ref-2026-07-14-sample',
  system_context: 'Annex III 5(b) creditworthiness assessment — demo fixture',
  sha256_prev_record: '',
  retention_months: 6,
  operator_id: 'sample-operator',
});

// Run one receipted AI-Act evidence export pass: build the art-236 decision-log artifact, map
// it through both LIVE EXPORT-1 exports (OSCAL + ISO/IEC 24970), then sign a small anchor-lineage
// receipt referencing the artifact's execution_hash (never re-signs the artifact or the export
// payloads themselves — same pattern _reserve_watch.mjs uses for its artifact_ref field).
// Deterministic over (decisionInput, nowMs) except for the ephemeral signing key.
export async function runAiActEvidenceExport(decisionInput, nowMs) {
  const now = new Date(nowMs).toISOString();
  const artifact = await buildDecisionLogArtifact(decisionInput, { now });

  const oscalUuid = crypto.randomUUID();
  const oscal = receiptToOscalAssessmentResults(artifact, { uuid: oscalUuid });
  const iso24970 = receiptToIso24970LogRecord(artifact);

  const keyPair = await globalThis.crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const verificationMethod = await rawPubkeyToDidKey(keyPair.publicKey);
  const receiptDoc = {
    aiact_evidence_receipt: 'v1',
    tool_id: decisionLogMeta.tool_id,
    mcp_name: decisionLogMeta.mcp_name,
    oscal_mapping_version: OSCAL_MAPPING_VERSION,
    iso24970_draft_revision: ISO24970_DRAFT_REVISION,
    decision_label: artifact.output_payload.decision_label,
    record_status: artifact.output_payload.record_status,
    compliance_flags: artifact.compliance_flags,
    artifact_ref: artifact.execution_hash,
    checked_at: now,
    // Pre-declared before signing — sign()/verify() strip-then-restore this key (see
    // _reserve_watch.mjs / renewal-watch-logic.mjs buildSignedCheckpoint for the identical
    // requirement).
    audit_signature: {},
  };
  const signed = await sign(receiptDoc, { verificationMethod, created: now, privateKey: keyPair.privateKey });

  return { artifact, oscal, iso24970, receipt: signed, verificationMethod };
}
