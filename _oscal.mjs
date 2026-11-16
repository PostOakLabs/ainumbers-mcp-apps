// _oscal.mjs — OCG execution receipt / AIUC-1 evidence pack -> NIST OSCAL Assessment Results
// (EXPORT-1 §E1.a + GRC-PILOT-OSCAL-EXPORT-1).
//
// Version-pinned to OSCAL 1.2.3 (2026-08-07 release; NIST CSWP 53, Dec 2025, targets continuous
// assurance + agentic AI, making assessment-results the receipt's native enterprise-GRC
// dialect). NEVER imports an OSCAL library — mapping only, borrow-not-depend, same doctrine
// that keeps Summa/Vouch schema borrows out of the kernel path. The only node import is
// node:crypto's SHA-1, used solely for deterministic UUID v5 derivation (no randomness).
//
// Semantics rule (§E1.a): this is a RE-EXPRESSION of what the receipt/pack already proves. Every
// observation/finding below is read verbatim off the artifact — nothing is inferred, scored, or
// asserted that the artifact itself does not contain. No control-catalog mapping is asserted
// (reviewed-controls carries an explicit disclaimer) — that mapping is the consuming GRC
// platform's job, not this export's.
//
// Determinism: every uuid is a caller-supplied RFC 4122 v4/v5 UUID used as a UUID **v5
// namespace** over stable keys (`uuidV5(root, 'observation:<i>:<control-id>')`…) — no
// crypto.randomUUID() anywhere in this pure mapping. Timestamps reuse the artifact's OWN
// `generated_at` for receipts; the pack mapper takes an optional caller `lastModified` and
// otherwise emits the documented `1970-01-01T00:00:00Z` sentinel (the pack payload carries no
// timestamp — a wall-clock sample here would break byte-determinism and mint a claim the pack
// does not contain). Same discipline as embed/lib/_proof.mjs sign() (created is
// caller-supplied, not wall-clock-sampled here).
//
// Schema note (closes the 1.1.3-era FLAG): both mappers are schema-validated by
// scripts/oscal-mapping.test.mjs against the VENDORED CC0 v1.2.3 schema
// scripts/fixtures/oscal-1.2.3/oscal_assessment-results_schema.json (ajv, draft-07) plus the
// four NIST oscal-content golden examples, which prove the validator setup itself. Schema
// shapes this file is written against: UUIDDatatype is RFC 4122 **v4-or-v5 only** (`[45]` +
// variant `[89ABab]`) — hence the v5 derivation; `finding.target` REQUIRES `type`
// (`statement-id`|`objective-id`), `target-id`, and `status` (`state`: `satisfied`|
// `not-satisfied`); `observation` REQUIRES `methods` (plural) and `collected`;
// `observation.relevant-evidence` items REQUIRE `description`; `result.observations`/`findings`
// have minItems 1, so empty arrays are omitted, never emitted.

import { createHash } from 'node:crypto';

const OSCAL_VERSION = '1.2.3';

// The NIST UUIDDatatype pattern (v4-or-v5, RFC 4122 variant) — verbatim from the vendored
// schema. The caller-supplied root uuid must satisfy it: it IS the document root uuid and it
// seeds every derived uuid as the v5 namespace.
const UUID_RE = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[45][0-9A-Fa-f]{3}-[89ABab][0-9A-Fa-f]{3}-[0-9A-Fa-f]{12}$/;

// No-timestamp sentinel for the pack mapper (see header): valid date-time, visibly synthetic.
const NO_TIMESTAMP_SENTINEL = '1970-01-01T00:00:00Z';

// Stub href emitted for import-ap when the caller has no assessment plan (always-required by
// the consuming OSCAL tooling; fragment-only URI reference points at this same document).
const IMPORT_AP_STUB_HREF = '#ocg-assessment-plan-stub';

// UUID v5 over (namespace, name) per RFC 4122 §4.3, SHA-1 flavor. Pure and deterministic:
// same inputs -> same uuid, forever. Throws on a non-v4/v5 namespace (a root uuid outside the
// NIST UUIDDatatype pattern would poison every derived uuid below it).
function uuidV5(namespace, name) {
  if (!UUID_RE.test(namespace)) {
    throw new Error(`uuid namespace must be an RFC 4122 v4/v5 UUID (NIST UUIDDatatype), got: ${namespace}`);
  }
  const nsBytes = Buffer.from(namespace.replaceAll('-', ''), 'hex');
  const digest = createHash('sha1').update(nsBytes).update(Buffer.from(name, 'utf8')).digest();
  const b = Uint8Array.from(digest.subarray(0, 16));
  b[6] = (b[6] & 0x0f) | 0x50; // version 5
  b[8] = (b[8] & 0x3f) | 0x80; // RFC 4122 variant (10xx)
  const hex = Buffer.from(b).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function requireRootUuid(uuid, fnName) {
  if (!uuid || typeof uuid !== 'string') {
    throw new Error(`${fnName}: uuid is required and caller-supplied (no crypto.randomUUID() in this pure mapping)`);
  }
  if (!UUID_RE.test(uuid)) {
    throw new Error(`${fnName}: root uuid must be an RFC 4122 v4/v5 UUID (NIST UUIDDatatype pattern) — every uuid in the document derives from it via UUID v5, got: ${uuid}`);
  }
  return uuid;
}

// Re-expression objective for receipt findings. The OSCAL schema forces target.status.state
// onto every finding; the honest reading is the one that adds no new claim: the objective is
// "this OCG flag was raised and captured verbatim in this receipt", which is satisfied BY the
// flag's presence — never "the underlying control passed". The remarks say exactly that.
const RECEIPT_FINDING_TARGET_ID = 'ocg-compliance-mandate-flag';
const RECEIPT_FINDING_REMARKS =
  'Objective = the OCG compliance flag was raised and captured verbatim in this receipt ' +
  '(evidence re-expression). No claim is made that the underlying control or mandate passed.';

function observationsFromChecks(rootUuid, artifact, collected) {
  const checks = artifact?.output_payload?.checks;
  if (!Array.isArray(checks) || checks.length === 0) return [];
  const subjectUuid = uuidV5(rootUuid, 'subject:ocg-artifact');
  return checks.map((c, i) => ({
    uuid: uuidV5(rootUuid, `observation:${i}:${c?.code ?? 'unknown'}`),
    title: `OCG output_payload.checks[${i}]`,
    description: `OCG output_payload.checks[${i}] — code ${c?.code ?? 'unknown'}`,
    methods: ['TEST'],
    types: ['ocg-compliance-mandate'],
    collected,
    subjects: [{ 'subject-uuid': subjectUuid, type: 'component', title: artifact.tool_id ?? 'unknown-tool' }],
    props: [
      { name: 'ocg-check-code', value: String(c?.code ?? '') },
      { name: 'ocg-check-status', value: String(c?.status ?? '') },
    ],
  }));
}

function findingsFromFlags(rootUuid, artifact, observations) {
  const flags = Array.isArray(artifact?.compliance_flags) ? artifact.compliance_flags : [];
  if (flags.length === 0) return [];
  const status = artifact?.output_payload?.overall_status ?? null;
  const relatedObservations = observations.map((o) => ({ 'observation-uuid': o.uuid }));
  return flags.map((flag, i) => ({
    uuid: uuidV5(rootUuid, `finding:${i}:${flag}`),
    title: String(flag),
    description: `OCG compliance_flags[${i}]: ${flag} (re-expressed verbatim, no new claim added)`,
    target: {
      type: 'objective-id',
      'target-id': RECEIPT_FINDING_TARGET_ID,
      status: { state: 'satisfied', remarks: RECEIPT_FINDING_REMARKS },
    },
    'related-observations': relatedObservations,
    props: [{ name: 'ocg-overall-status', value: String(status ?? '') }],
  }));
}

/**
 * receiptToOscalAssessmentResults(artifact, { uuid, importApHref }) -> OSCAL 1.2.3
 * assessment-results doc, schema-validated shape (see scripts/oscal-mapping.test.mjs).
 * artifact: an OCG v0.4 execution artifact (must carry generated_at, tool_id, output_payload).
 * uuid: caller-supplied RFC 4122 v4/v5 UUID for the assessment-results root; every other uuid
 * in the document derives from it as UUID v5 over stable keys (deterministic).
 * importApHref (optional): href of an OSCAL assessment-plan this result set answers. import-ap
 * is ALWAYS emitted — when the caller has no plan it is the documented `#` stub
 * (IMPORT_AP_STUB_HREF), because the NIST schema/tooling expects a plan reference on real
 * assessment results.
 */
export function receiptToOscalAssessmentResults(artifact, { uuid, importApHref } = {}) {
  if (!artifact || typeof artifact !== 'object') throw new Error('receiptToOscalAssessmentResults requires an OCG artifact object');
  requireRootUuid(uuid, 'receiptToOscalAssessmentResults');
  const collected = artifact.generated_at;
  if (!collected || typeof collected !== 'string') throw new Error('artifact.generated_at is required — reused verbatim as the OSCAL timestamp, never fabricated');

  const observations = observationsFromChecks(uuid, artifact, collected);
  const findings = findingsFromFlags(uuid, artifact, observations);

  return {
    'assessment-results': {
      uuid,
      metadata: {
        title: `OpenChainGraph execution receipt — ${artifact.tool_id ?? 'unknown-tool'}`,
        'last-modified': collected,
        version: artifact.tool_version ?? '0.0.0',
        'oscal-version': OSCAL_VERSION,
        props: [
          { name: 'ocg-execution-hash', value: String(artifact.execution_hash ?? '') },
          { name: 'ocg-chaingraph-version', value: String(artifact.chaingraph_version ?? '') },
        ],
      },
      'import-ap': { href: importApHref ?? IMPORT_AP_STUB_HREF },
      results: [
        {
          uuid: uuidV5(uuid, 'result:ocg-execution'),
          title: 'OpenChainGraph execution result',
          description: 'Assessment result re-expressed from a single OCG execution receipt. Asserts no finding beyond what the receipt itself contains.',
          start: collected,
          'reviewed-controls': {
            // Schema forces every control-selection to be include-all or include-controls; a
            // receipt maps no catalog, so the honest shape is include-all (scope of THIS
            // receipt only) with the no-mapping disclaimer in remarks.
            'control-selections': [{ 'include-all': {} }],
            remarks: 'No control-catalog mapping is asserted by this export — that mapping is the responsibility of the consuming GRC platform.',
          },
          ...(observations.length > 0 ? { observations } : {}),
          ...(findings.length > 0 ? { findings } : {}),
        },
      ],
    },
  };
}

// Pack status -> finding.target.status.state, per GRC-PILOT-OSCAL-EXPORT-1: receipt-backed
// controls map to satisfied; attestation-only and missing (and any unrecognized status) map
// to not-satisfied, with the pack's own reason carried in the status remarks.
function packStatusToState(status) {
  return status === 'receipt-backed' ? 'satisfied' : 'not-satisfied';
}

function packStatusReason(status, digests) {
  switch (status) {
    case 'receipt-backed':
      return `receipt-backed: ${digests.length} artifact digest(s) in the evidence pack replay to this control binding.`;
    case 'attestation-only':
      return `attestation-only: ${digests.length} artifact reference(s) resolved to receipt digests; not all bound artifact references resolved — the evidence pack asserts attestation strength for this control, not receipt strength.`;
    case 'missing':
      return 'missing: no artifact references are bound to this control in the evidence pack.';
    default:
      return `unknown pack status "${status}" — mapped conservatively to not-satisfied (re-expression; no inference).`;
  }
}

/**
 * aiuc1PackToOscalAssessmentResults(packOutput, { uuid, executionHash, lastModified }) ->
 * OSCAL 1.2.3 assessment-results document rendering node art-304's AIUC-1 evidence-pack
 * output payload (GRC-PILOT-OSCAL-EXPORT-1). One result per pack; one "evidence observation"
 * per control (its `relevant-evidence` lists the control's bound artifact digests verbatim);
 * one finding per control re-expressing the pack's own claim_strength: receipt-backed ->
 * `satisfied`, attestation-only/missing -> `not-satisfied`, with the reason in the status
 * remarks. The execution hash rides as a prop.
 *
 * This is an EVIDENCE OBSERVATION export, not an assessment verdict: the document restates
 * what the pack payload itself claims (honest-minimum claim_strength) and adds no finding the
 * pack does not contain.
 *
 * packOutput: art-304 `output_payload` — { aiuc1_version, version_mismatch, controls:
 *   [{control_id, status, artifact_digests, claim_strength}], pack_claim_strength, ... }.
 * uuid: caller-supplied RFC 4122 v4/v5 UUID root; every other uuid derives from it via UUID v5.
 * executionHash: the pack execution's execution_hash, carried as a prop (required).
 * lastModified (optional): ISO-8601 timestamp for metadata.last-modified / result.start /
 *   observation.collected. The pack payload carries no timestamp; when omitted the documented
 *   1970 sentinel is emitted so the mapping stays byte-deterministic (no Date.now()).
 */
export function aiuc1PackToOscalAssessmentResults(packOutput, { uuid, executionHash, lastModified } = {}) {
  if (!packOutput || typeof packOutput !== 'object') throw new Error('aiuc1PackToOscalAssessmentResults requires an art-304 output_payload object');
  requireRootUuid(uuid, 'aiuc1PackToOscalAssessmentResults');
  if (typeof executionHash !== 'string' || executionHash.length === 0) {
    throw new Error('executionHash is required — the OSCAL rendering must bind the pack execution it re-expresses');
  }
  const ts = typeof lastModified === 'string' && lastModified.length > 0 ? lastModified : NO_TIMESTAMP_SENTINEL;

  const controls = Array.isArray(packOutput.controls) ? packOutput.controls : [];
  const observations = controls.map((c, i) => {
    const controlRef = c?.control_id ?? `unbound-control-${i}`;
    const digests = Array.isArray(c?.artifact_digests) ? c.artifact_digests : [];
    return {
      uuid: uuidV5(uuid, `observation:${i}:${controlRef}`),
      title: `Evidence observation — AIUC-1 control ${controlRef}`,
      description: `Evidence observation for AIUC-1 control ${controlRef}: evidence-pack status "${String(c?.status ?? 'unknown')}", ${digests.length} bound artifact digest(s). Re-expressed from the AIUC-1 evidence pack — this is an evidence observation, not an assessment verdict.`,
      methods: ['EXAMINE'],
      types: ['aiuc1-evidence-pack'],
      collected: ts,
      ...(digests.length > 0 ? {
        'relevant-evidence': digests.map((d) => ({
          href: `#${d}`,
          description: `Artifact digest bound to AIUC-1 control ${controlRef} in the evidence pack: ${d}`,
        })),
      } : {}),
    };
  });

  const findings = controls.map((c, i) => {
    const controlRef = c?.control_id ?? `unbound-control-${i}`;
    const digests = Array.isArray(c?.artifact_digests) ? c.artifact_digests : [];
    return {
      uuid: uuidV5(uuid, `finding:${i}:${controlRef}`),
      title: `AIUC-1 control ${controlRef}`,
      description: `Re-expression of the AIUC-1 evidence pack's own claim_strength for control ${controlRef}: "${String(c?.claim_strength ?? c?.status ?? 'unknown')}". Not an assessment verdict — no finding beyond what the pack payload contains.`,
      target: {
        type: 'objective-id',
        'target-id': controlRef,
        status: {
          state: packStatusToState(c?.status),
          remarks: packStatusReason(c?.status, digests),
        },
      },
      'related-observations': [{ 'observation-uuid': observations[i].uuid }],
    };
  });

  return {
    'assessment-results': {
      uuid,
      metadata: {
        title: `AIUC-1 evidence pack — ${packOutput.aiuc1_version ?? 'unknown-version'}`,
        'last-modified': ts,
        version: packOutput.aiuc1_version ?? 'unknown-version',
        'oscal-version': OSCAL_VERSION,
        props: [
          { name: 'aiuc1-pack-claim-strength', value: String(packOutput.pack_claim_strength ?? '') },
        ],
      },
      'import-ap': { href: IMPORT_AP_STUB_HREF },
      results: [
        {
          uuid: uuidV5(uuid, 'result:aiuc1-pack'),
          title: 'AIUC-1 evidence pack result',
          description: 'Evidence observations re-expressed from one AIUC-1 evidence pack (node art-304). Each finding restates the pack payload\'s own per-control claim_strength (receipt-backed -> satisfied; attestation-only/missing -> not-satisfied). This document asserts no assessment verdict beyond the pack payload.',
          start: ts,
          'reviewed-controls': {
            // Re-express the pack's OWN scope: the exact AIUC-1 control ids the pack names.
            // The schema's control-selection is anyOf include-all/include-controls (both
            // minItems 1), so a zero-control pack (version mismatch) falls back to
            // include-all with the no-assertion remark — OSCAL has no "none" selection.
            ...(controls.length > 0
              ? { 'control-selections': [{ 'include-controls': controls.map((c, i) => ({ 'control-id': c?.control_id ?? `unbound-control-${i}` })) }] }
              : { 'control-selections': [{ 'include-all': {} }] }),
            remarks: controls.length > 0
              ? 'Reviewed scope = the AIUC-1 control ids the evidence pack itself names. No further control-catalog mapping is asserted by this export — catalog interpretation is the responsibility of the consuming GRC platform.'
              : 'The evidence pack assembled zero controls (e.g. catalog version mismatch) — nothing was reviewed and no assertion is made; OSCAL has no "none" selection, so include-all here carries no claim.',
          },
          props: [{ name: 'ocg-execution-hash', value: executionHash }],
          ...(observations.length > 0 ? { observations } : {}),
          ...(findings.length > 0 ? { findings } : {}),
        },
      ],
    },
  };
}

export const OSCAL_MAPPING_VERSION = OSCAL_VERSION;
