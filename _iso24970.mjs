// _iso24970.mjs — OCG execution receipt -> ISO/IEC 24970 AI-system log-export mapping
// (EXPORT-1 §E1.b — folded R1, the AI Act / audit-log dialect).
//
// DRAFT-PINNED (2026-07-10): ISO/IEC 24970 (AI system logging, JTC 1/SC 42) had not reached final
// publication at build time (tracked ~Q3 2026). Per §E1.b's publication-date guard, this module
// ships against the field shape implied by the standard's public working-draft scope (system
// identity, execution timestamp, decision outcome, input/output digest binding, compliance
// signalling) rather than blocking the pass on ISO finality. DRAFT_REVISION below is the ONE
// thing a future revision needs to bump — re-pin it and adjust the field list when 24970
// publishes; nothing else in this EXPORT-1 pass (§E1.a OSCAL, §E1.c B-LTA) depends on it.
//
// Overlap check (§E1.b): no overlap with §PC-7 (COSE-Receipt/SCITT, OCG-VSA, OTel semconv) — those
// are supply-chain + telemetry dialects; this is the regulatory AI-system audit-log dialect.
//
// Semantics: pure re-expression, same discipline as _oscal.mjs — booleans report PRESENCE of a
// proof/anchor, never a fabricated verification verdict this module didn't itself check.

export const DRAFT_REVISION = 'iso-iec-24970-working-draft-2026-07';

/**
 * receiptToIso24970LogRecord(artifact) -> a single ISO/IEC 24970-shaped AI-system log record.
 * artifact: an OCG v0.4 execution artifact.
 */
export function receiptToIso24970LogRecord(artifact) {
  if (!artifact || typeof artifact !== 'object') throw new Error('receiptToIso24970LogRecord requires an OCG artifact object');
  if (!artifact.generated_at || typeof artifact.generated_at !== 'string') {
    throw new Error('artifact.generated_at is required — reused verbatim as the log record timestamp, never fabricated');
  }
  return {
    log_record_version: DRAFT_REVISION,
    timestamp: artifact.generated_at,
    system_id: artifact.tool_id ?? null,
    system_version: artifact.tool_version ?? null,
    event_type: 'ai_system_execution',
    execution_hash: artifact.execution_hash ?? null,
    decision_outcome: artifact.output_payload?.overall_status ?? null,
    compliance_flags: Array.isArray(artifact.compliance_flags) ? artifact.compliance_flags : [],
    chain_parent_hashes: Array.isArray(artifact.chain?.parent_hashes) ? artifact.chain.parent_hashes : [],
    chain_depth: typeof artifact.chain?.chain_depth === 'number' ? artifact.chain.chain_depth : null,
    proof_binding_present: Boolean(artifact.audit_signature?.proof && (Array.isArray(artifact.audit_signature.proof) ? artifact.audit_signature.proof.length : true)),
    anchor_binding_present: Array.isArray(artifact.anchor_bindings) && artifact.anchor_bindings.length > 0,
  };
}
