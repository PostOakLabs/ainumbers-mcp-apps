// _vsa.mjs — §15 gate-suite result -> SLSA v1.2 Verification Summary Attestation mapping (PC-7 §P7.b).
//
// Version-pinned to SLSA v1.2 (slsa.dev, https://slsa.dev/verification_summary/v1.2, the
// verification-summary predicate track). NEVER imports a SLSA library — mapping only,
// borrow-not-depend, same doctrine as _oscal.mjs (EXPORT-1 §E1.a).
//
// Semantics rule (§P7.b): this is a RE-EXPRESSION of a gate-suite outcome — it asserts only
// "these artifacts passed policy P at level L", nothing the gate run did not itself establish.
// No new trust claim is minted in translation; verificationResult/verifiedLevels are derived
// mechanically from the caller-supplied gates[] pass/fail record, never inferred or upgraded.
//
// Determinism: `generated_at` is CALLER-SUPPLIED (never Date.now() here) — same discipline as
// _oscal.mjs (`collected` reuses artifact.generated_at) and kernels/_proof.mjs sign() (`created`
// is caller-supplied). The VSA statement this module returns is a plain object, signable as-is
// via the existing kernels/_proof.mjs sign()/verify() (no new crypto — see scripts/vsa-mapping.test.mjs).
//
// Schema note: hand-verified against the SLSA v1.2 verification_summary predicate's documented
// REQUIRED members (verifier.id, timeVerified, resourceUri, policy.uri, verificationResult,
// slsaVersion) — no live schema fetch in this environment (same FLAG as _oscal.mjs: run a real
// schema validation before any external consumer relies on this shape).

const SLSA_VERSION = '1.2';
const PREDICATE_TYPE = 'https://slsa.dev/verification_summary/v1';
const STATEMENT_TYPE = 'https://in-toto.io/Statement/v1';

const asArray = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);

/**
 * gateSuiteResultToSlsaVsa(gateSuiteResult, { verifierId, policyUri }) -> SLSA v1.2 VSA statement.
 *
 * gateSuiteResult (caller-supplied, produced by an actual SPEC.md §15 gate-suite run — this
 * module runs nothing itself):
 *   - generated_at:  ISO-8601 string. Reused verbatim as predicate.timeVerified.
 *   - resourceUri:   string, or array of strings — the artifact set A that was verified.
 *   - level:         string|number — the policy level L the gates were run against.
 *   - gates:         non-empty array of { name: string, status: 'pass'|'fail' } — the §15 rows
 *                    actually executed for this run.
 *   - digest:        optional { <alg>: <hex> } re-attached verbatim to every subject entry
 *                    (e.g. { sha256: execution_hash }) — never fabricated here.
 *   - inputAttestations: optional array of { uri, digest } re-expressed verbatim.
 *
 * opts:
 *   - verifierId:  required string — identifies the verifier that ran the gate suite (a URI).
 *   - policyUri:   required string — identifies policy P (e.g. a SPEC.md §15 anchor URL).
 */
export function gateSuiteResultToSlsaVsa(gateSuiteResult, { verifierId, policyUri } = {}) {
  if (!gateSuiteResult || typeof gateSuiteResult !== 'object') {
    throw new Error('gateSuiteResultToSlsaVsa requires a gate-suite result object');
  }
  const { generated_at, resourceUri, level, gates, digest, inputAttestations } = gateSuiteResult;
  if (!generated_at || typeof generated_at !== 'string') {
    throw new Error('gateSuiteResult.generated_at is required — reused verbatim as timeVerified, never fabricated');
  }
  const resources = asArray(resourceUri);
  if (resources.length === 0 || resources.some((u) => typeof u !== 'string' || !u)) {
    throw new Error('gateSuiteResult.resourceUri is required (string or array of non-empty strings)');
  }
  if (level === undefined || level === null || level === '') {
    throw new Error('gateSuiteResult.level is required — the policy level L that was verified');
  }
  if (!Array.isArray(gates) || gates.length === 0) {
    throw new Error('gateSuiteResult.gates must be a non-empty array of the §15 rows actually run');
  }
  if (gates.some((g) => !g || typeof g.name !== 'string' || !g.name || (g.status !== 'pass' && g.status !== 'fail'))) {
    throw new Error('every gates[] entry needs a non-empty name and status of "pass" or "fail"');
  }
  if (!verifierId || typeof verifierId !== 'string') {
    throw new Error('opts.verifierId is required — identifies the verifier that ran the gate suite');
  }
  if (!policyUri || typeof policyUri !== 'string') {
    throw new Error('opts.policyUri is required — identifies policy P');
  }

  // Mechanical derivation only — no gate is re-run or re-judged here, only re-read.
  const failed = gates.filter((g) => g.status === 'fail');
  const verificationResult = failed.length === 0 ? 'PASSED' : 'FAILED';
  const verifiedLevels = verificationResult === 'PASSED' ? [String(level)] : [];

  const subjectDigest = digest && typeof digest === 'object' ? digest : {};

  return {
    _type: STATEMENT_TYPE,
    subject: resources.map((uri) => ({ name: uri, digest: subjectDigest })),
    predicateType: PREDICATE_TYPE,
    predicate: {
      verifier: { id: verifierId },
      timeVerified: generated_at,
      resourceUri: resources[0],
      policy: { uri: policyUri },
      inputAttestations: asArray(inputAttestations),
      verificationResult,
      verifiedLevels,
      slsaVersion: SLSA_VERSION,
      // Informative extension (non-normative, additional to the SLSA-required fields above):
      // the exact §15 gate rows this VSA re-expresses, so a consumer can trace the claim back
      // to its source without re-running anything. Adds no new trust claim — pure carry-through.
      ocgGateResults: gates.map((g) => ({ name: g.name, status: g.status })),
    },
  };
}

export const SLSA_VSA_VERSION = SLSA_VERSION;
export const SLSA_VSA_PREDICATE_TYPE = PREDICATE_TYPE;
