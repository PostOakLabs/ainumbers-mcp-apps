// vsa-mapping.test.mjs — §P7.b: §15 gate-suite result -> SLSA v1.2 VSA mapping (PC-7-INTEROP-EXPORTS-SPEC.md).
// Structural shape check against the SLSA v1.2 verification_summary predicate's required members,
// plus a sign->verify round-trip through the EXISTING kernels/_proof.mjs lineage (no new crypto).
import { gateSuiteResultToSlsaVsa, SLSA_VSA_VERSION, SLSA_VSA_PREDICATE_TYPE } from '../_vsa.mjs';
import { sign, verify, rawPubkeyToDidKey, didKeyToPublicKey } from '../kernels/_proof.mjs';

let fail = 0;
const ok = (c, m) => { if (!c) { fail++; console.error('  ✗ ' + m); } else console.log('  ✓ ' + m); };

console.log('§P7.b SLSA v1.2 VSA mapping\n');

const GENERATED_AT = '2026-07-19T00:00:00Z';
const VERIFIER_ID = 'https://ainumbers.co/chaingraph/standard/SPEC.md#section-15';
const POLICY_URI = 'https://ainumbers.co/chaingraph/standard/SPEC.md#section-15';

const passingResult = {
  generated_at: GENERATED_AT,
  resourceUri: 'sha256:' + '1'.repeat(64),
  level: 'L2',
  digest: { sha256: '1'.repeat(64) },
  gates: [
    { name: 'schema-validate.mjs', status: 'pass' },
    { name: 'validate-chains.mjs', status: 'pass' },
    { name: 'proof-binding.test.mjs', status: 'pass' },
  ],
};

// ── happy path ─────────────────────────────────────────────────────────────────────────────────
{
  const vsa = gateSuiteResultToSlsaVsa(passingResult, { verifierId: VERIFIER_ID, policyUri: POLICY_URI });
  ok(vsa._type === 'https://in-toto.io/Statement/v1', 'statement _type is in-toto v1');
  ok(vsa.predicateType === SLSA_VSA_PREDICATE_TYPE, 'predicateType is the SLSA verification_summary predicate');
  ok(vsa.predicate.verifier.id === VERIFIER_ID, 'predicate.verifier.id carries the caller-supplied verifier');
  ok(vsa.predicate.timeVerified === GENERATED_AT, 'predicate.timeVerified reuses generated_at verbatim (no Date.now())');
  ok(vsa.predicate.resourceUri === passingResult.resourceUri, 'predicate.resourceUri carries artifact set A');
  ok(vsa.predicate.policy.uri === POLICY_URI, 'predicate.policy.uri carries policy P');
  ok(vsa.predicate.verificationResult === 'PASSED', 'all-pass gates -> verificationResult PASSED');
  ok(Array.isArray(vsa.predicate.verifiedLevels) && vsa.predicate.verifiedLevels[0] === 'L2', 'verifiedLevels carries level L on PASSED');
  ok(vsa.predicate.slsaVersion === SLSA_VSA_VERSION && SLSA_VSA_VERSION === '1.2', 'slsaVersion pinned to 1.2');
  ok(vsa.subject.length === 1 && vsa.subject[0].name === passingResult.resourceUri, 'subject re-expresses resourceUri');
  ok(vsa.subject[0].digest.sha256 === passingResult.digest.sha256, 'subject.digest carries the caller-supplied digest verbatim');
  ok(vsa.predicate.ocgGateResults.length === 3, 'ocgGateResults traces back to every gate row supplied');
}

// ── a failed gate flips the verdict, never silently upgraded ─────────────────────────────────────
{
  const failingResult = { ...passingResult, gates: [...passingResult.gates, { name: 'gate-zero-egress.mjs', status: 'fail' }] };
  const vsa = gateSuiteResultToSlsaVsa(failingResult, { verifierId: VERIFIER_ID, policyUri: POLICY_URI });
  ok(vsa.predicate.verificationResult === 'FAILED', 'one failing gate -> verificationResult FAILED');
  ok(vsa.predicate.verifiedLevels.length === 0, 'verifiedLevels empty on FAILED — no level claimed that was not earned');
}

// ── determinism: same input -> byte-identical output ─────────────────────────────────────────────
{
  const a = JSON.stringify(gateSuiteResultToSlsaVsa(passingResult, { verifierId: VERIFIER_ID, policyUri: POLICY_URI }));
  const b = JSON.stringify(gateSuiteResultToSlsaVsa(passingResult, { verifierId: VERIFIER_ID, policyUri: POLICY_URI }));
  ok(a === b, 'mapping is deterministic — identical input produces byte-identical output');
}

// ── error handling: required inputs ───────────────────────────────────────────────────────────
{
  const cases = [
    [{ ...passingResult, generated_at: undefined }, { verifierId: VERIFIER_ID, policyUri: POLICY_URI }, 'missing generated_at'],
    [{ ...passingResult, resourceUri: undefined }, { verifierId: VERIFIER_ID, policyUri: POLICY_URI }, 'missing resourceUri'],
    [{ ...passingResult, level: undefined }, { verifierId: VERIFIER_ID, policyUri: POLICY_URI }, 'missing level'],
    [{ ...passingResult, gates: [] }, { verifierId: VERIFIER_ID, policyUri: POLICY_URI }, 'empty gates[]'],
    [{ ...passingResult, gates: [{ name: 'x', status: 'maybe' }] }, { verifierId: VERIFIER_ID, policyUri: POLICY_URI }, 'bad gate status'],
    [passingResult, { policyUri: POLICY_URI }, 'missing verifierId'],
    [passingResult, { verifierId: VERIFIER_ID }, 'missing policyUri'],
  ];
  for (const [input, opts, label] of cases) {
    let threw = false;
    try { gateSuiteResultToSlsaVsa(input, opts); } catch { threw = true; }
    ok(threw, `throws on ${label} (never fabricates a required field)`);
  }
}

// ── re-verifies: sign the VSA statement via the EXISTING §16 _proof.mjs lineage, no new crypto ──
{
  // _proof.mjs's HOME for a proof is artifact.audit_signature.proof (§16) — the caller attaches the
  // (initially empty) envelope slot before signing, same as every other OCG artifact in this repo.
  const vsa = { ...gateSuiteResultToSlsaVsa(passingResult, { verifierId: VERIFIER_ID, policyUri: POLICY_URI }), audit_signature: {} };
  const kp = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  const vm = await rawPubkeyToDidKey(kp.publicKey);
  const created = GENERATED_AT;
  const signed = await sign(vsa, { verificationMethod: vm, created, privateKey: kp.privateKey });
  ok(signed.audit_signature.proof.type === 'DataIntegrityProof', 'VSA signs via the standard DataIntegrityProof shape');
  const pub = await didKeyToPublicKey(vm);
  ok(await verify(signed, pub), 'signed VSA re-verifies via kernels/_proof.mjs verify() — no new crypto path introduced');

  const tampered = structuredClone(signed);
  tampered.predicate.verifiedLevels = ['L4']; // post-signing tamper: claim a level that was never verified
  ok(!(await verify(tampered, pub)), 'tampering the verdict after signing fails verify — the VSA is tamper-evident');
}

console.log(fail ? `\n✗ ${fail} FAILED` : '\n✓ all VSA mapping assertions passed');
process.exit(fail ? 1 : 0);
