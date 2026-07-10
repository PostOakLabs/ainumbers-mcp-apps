// _oscal.mjs — OCG execution receipt -> NIST OSCAL Assessment Results mapping (EXPORT-1 §E1.a).
//
// Version-pinned to OSCAL 1.1.3 (2025-06-25 release, the latest at build time; NIST CSWP 53,
// Dec 2025, targets continuous assurance + agentic AI, making assessment-results the receipt's
// native enterprise-GRC dialect). NEVER imports an OSCAL library — mapping only, borrow-not-depend,
// same doctrine that keeps Summa/Vouch schema borrows out of the kernel path.
//
// Semantics rule (§E1.a): this is a RE-EXPRESSION of what the receipt already proves. Every
// observation/finding below is read verbatim off the artifact — nothing is inferred, scored, or
// asserted that the artifact itself does not contain. No control-catalog mapping is asserted
// (reviewed-controls carries an explicit disclaimer) — that mapping is the consuming GRC
// platform's job, not this export's.
//
// Determinism: `uuid` is CALLER-SUPPLIED (never crypto.randomUUID() here); `collected`/`start`/
// `last-modified` all reuse the artifact's OWN `generated_at` — never Date.now(). Same discipline
// as embed/lib/_proof.mjs sign() (created is caller-supplied, not wall-clock-sampled here).
//
// Schema note: full external JSON Schema validation against the pinned OSCAL 1.1.3
// oscal_ar_schema.json was not run (no network access to fetch it, no vendored copy — vendoring a
// multi-hundred-KB external schema was judged out of scope for this pass). The shape below is
// hand-verified against the OSCAL 1.1.3 assessment-results model's REQUIRED members (uuid,
// metadata.{title,last-modified,version,oscal-version}, results[].{uuid,title,description,start}).
// FLAG for whoever lands this: run a real schema validation before any external OSCAL submission.

const OSCAL_VERSION = '1.1.3';

function observationsFromChecks(artifact, collected) {
  const checks = artifact?.output_payload?.checks;
  if (!Array.isArray(checks)) return [];
  return checks.map((c, i) => ({
    uuid: `observation-${i}`,
    description: `OCG output_payload.checks[${i}] — code ${c?.code ?? 'unknown'}`,
    methods: ['TEST'],
    types: ['ocg-compliance-mandate'],
    collected,
    subjects: [{ 'subject-uuid': 'ocg-artifact', type: 'component', title: artifact.tool_id ?? 'unknown-tool' }],
    props: [
      { name: 'ocg-check-code', value: String(c?.code ?? '') },
      { name: 'ocg-check-status', value: String(c?.status ?? '') },
    ],
  }));
}

function findingsFromArtifact(artifact, observations) {
  const flags = Array.isArray(artifact?.compliance_flags) ? artifact.compliance_flags : [];
  const status = artifact?.output_payload?.overall_status ?? null;
  const relatedObservations = observations.map((o) => ({ 'observation-uuid': o.uuid }));
  return flags.map((flag, i) => ({
    uuid: `finding-${i}`,
    title: String(flag),
    description: `OCG compliance_flags[${i}]: ${flag} (re-expressed verbatim, no new claim added)`,
    'related-observations': relatedObservations,
    props: [{ name: 'ocg-overall-status', value: String(status ?? '') }],
  }));
}

/**
 * receiptToOscalAssessmentResults(artifact, { uuid, importApHref }) -> OSCAL assessment-results doc.
 * artifact: an OCG v0.4 execution artifact (must carry generated_at, tool_id, output_payload).
 * uuid: caller-supplied UUID for the assessment-results root (this mapping is deterministic).
 * importApHref (optional): href of an OSCAL assessment-plan this result set answers, if one exists.
 */
export function receiptToOscalAssessmentResults(artifact, { uuid, importApHref } = {}) {
  if (!artifact || typeof artifact !== 'object') throw new Error('receiptToOscalAssessmentResults requires an OCG artifact object');
  if (!uuid || typeof uuid !== 'string') throw new Error('uuid is required and caller-supplied (no crypto.randomUUID() in this pure mapping)');
  const collected = artifact.generated_at;
  if (!collected || typeof collected !== 'string') throw new Error('artifact.generated_at is required — reused verbatim as the OSCAL timestamp, never fabricated');

  const observations = observationsFromChecks(artifact, collected);
  const findings = findingsFromArtifact(artifact, observations);

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
      ...(importApHref ? { 'import-ap': { href: importApHref } } : {}),
      results: [
        {
          uuid: `${uuid}-result`,
          title: 'OpenChainGraph execution result',
          description: 'Assessment result re-expressed from a single OCG execution receipt. Asserts no finding beyond what the receipt itself contains.',
          start: collected,
          'reviewed-controls': {
            'control-selections': [{}],
            remarks: 'No control-catalog mapping is asserted by this export — that mapping is the responsibility of the consuming GRC platform.',
          },
          observations,
          findings,
        },
      ],
    },
  };
}

export const OSCAL_MAPPING_VERSION = OSCAL_VERSION;
