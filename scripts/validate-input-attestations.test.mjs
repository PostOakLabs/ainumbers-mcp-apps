// validate-input-attestations.test.mjs — §23 input-attestations GATE (SPEC.md §15 row, conformance-
// by-construction). Exercises the SAME verifier modules the validate_input_attestations MCP tool
// imports (worker.mjs), per type:
//   (a) rfc3161-snapshot — REAL FreeTSA TimeStampToken, verified via the shipped §20 rfc3161-tst
//       verifier (kernels/_rfc3161.mjs) — no second RFC 3161 implementation;
//   (b) vc-2.0 — real eddsa-jcs-2022 Data Integrity proof (kernels/_proof.mjs / embed/lib/_proof.mjs),
//       subject-digest == the resolved input's canonical digest;
//   (c) c2pa-manifest — structural only (art-123 kernel's compute()): manifest well-formed +
//       hard-binding assertion digest matches the resolved input;
//   (d) zktls — structural digest-binding only; OCG ships no verifier for it (verifiable:"external"
//       is a reporting contract, asserted directly, not exercised as pass/fail crypto here);
//   (e) tamper-fail — for each type: a tampered proof, unresolved RFC 6901 pointer, or digest
//       mismatch MUST fail.
// The rfc3161-snapshot fixture is a REAL committed timestamp (see
// _regen-input-attestations-fixture.mjs) — this gate itself makes zero network calls.
// Run:  node scripts/validate-input-attestations.test.mjs
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cgCanon } from '../kernels/_hash.mjs';
import { verifyRfc3161, extractMessageImprintHex, FREETSA_ROOT_PEM } from '../kernels/_rfc3161.mjs';
import { sign, verifyProofs, rawPubkeyToDidKey, didKeyToPublicKey } from '../embed/lib/_proof.mjs';
import { compute as c2paCompute } from '../kernels/art-123-c2pa-manifest-validator.kernel.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

let fail = 0;
const ok = (c, m) => { if (!c) { fail++; console.error('  ✗ ' + m); } else console.log('  ✓ ' + m); };
const attempt = async (fn) => { try { return { ok: true, value: await fn() }; } catch (e) { return { ok: false, error: e.message }; } };
const b64 = (s) => Buffer.from(s, 'base64');
const norm = (h) => (h == null ? h : String(h).replace(/^sha256:/, ''));

// Mirrors worker.mjs's attestDigestHex/resolveJsonPointer (OCG §23) exactly — SHA-256 hex of the
// §4 cgCanon encoding of one resolved value, and RFC 6901 resolution against policy_parameters.
async function digestHex(value) {
  return createHash('sha256').update(JSON.stringify(cgCanon(value))).digest('hex');
}
function resolveJsonPointer(root, pointer) {
  if (pointer === '') return { ok: true, value: root };
  if (typeof pointer !== 'string' || pointer[0] !== '/') return { ok: false };
  let cur = root;
  for (const raw of pointer.slice(1).split('/')) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (cur == null) return { ok: false };
    if (Array.isArray(cur)) {
      if (!/^(0|[1-9]\d*)$/.test(key)) return { ok: false };
      const idx = Number(key);
      if (idx >= cur.length) return { ok: false };
      cur = cur[idx];
    } else if (typeof cur === 'object') {
      if (!Object.prototype.hasOwnProperty.call(cur, key)) return { ok: false };
      cur = cur[key];
    } else return { ok: false };
  }
  return { ok: true, value: cur };
}

console.log('§23 validate_input_attestations gate\n');

// ── (a) rfc3161-snapshot — REAL FreeTSA token, reuses the SAME §20 verifier ──────────────────────
const FIX = JSON.parse(readFileSync(join(HERE, 'fixtures', 'input-attestations.fixture.json'), 'utf8'));
{
  const resolved = resolveJsonPointer(FIX.policy_parameters, FIX.input_attestation.pointer);
  ok(resolved.ok, '(a) pointer resolves against policy_parameters');
  const expected = await digestHex(resolved.value);
  ok(expected === FIX.expected_digest_hex, '(a) resolved value digest matches the fixture-committed digest');
  ok(extractMessageImprintHex(FIX.input_attestation.proof.proof) === expected, '(a) structural: messageImprint == resolved-value digest');
  const r = await attempt(() => verifyRfc3161(FIX.input_attestation.proof, { rootPem: FREETSA_ROOT_PEM, expectHashHex: expected }));
  ok(r.ok, `(a) REAL rfc3161-snapshot verifies via the shipped §20 verifier${r.ok ? '' : ` [${r.error}]`}`);
}
// (e) tamper: flip a byte in the CMS signature value
{
  const bad = structuredClone(FIX.input_attestation.proof);
  const raw = b64(bad.proof);
  raw[raw.length - 4] ^= 0x01;
  bad.proof = raw.toString('base64');
  const r = await attempt(() => verifyRfc3161(bad, { rootPem: FREETSA_ROOT_PEM, expectHashHex: FIX.expected_digest_hex }));
  ok(!r.ok, '(e) rfc3161-snapshot tampered CMS signature fails');
}
// (e) unresolved RFC 6901 pointer
{
  const resolved = resolveJsonPointer(FIX.policy_parameters, '/does_not_exist');
  ok(!resolved.ok, '(e) unresolved RFC 6901 pointer rejected before any crypto check');
}
// (e) digest mismatch: the messageImprint was bound to /amount_usd, not /currency
{
  const resolved = resolveJsonPointer(FIX.policy_parameters, '/currency');
  const wrongExpected = await digestHex(resolved.value);
  ok(wrongExpected !== FIX.expected_digest_hex, '(e) a different resolved field has a different digest');
  const r = await attempt(() => verifyRfc3161(FIX.input_attestation.proof, { rootPem: FREETSA_ROOT_PEM, expectHashHex: wrongExpected }));
  ok(!r.ok, '(e) rfc3161-snapshot digest mismatch (messageImprint != resolved-value digest) fails');
}

// ── (b) vc-2.0 — §16/§13.11 Data Integrity, subject-digest == resolved input digest ─────────────
{
  const policy_parameters = { borrower: { income_usd: 95000 } };
  const pointer = '/borrower/income_usd';
  const resolved = resolveJsonPointer(policy_parameters, pointer);
  const expected = await digestHex(resolved.value);
  const { publicKey, privateKey } = await globalThis.crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const did = await rawPubkeyToDidKey(publicKey);
  const credential = { credentialSubject: { digest: 'sha256:' + expected }, audit_signature: {} };
  const signed = await sign(credential, { verificationMethod: did, created: '2026-01-01T00:00:00Z', privateKey });

  ok(norm(signed.credentialSubject.digest) === expected, '(b) vc-2.0 structural: subject digest == resolved input digest');
  const verified = await verifyProofs(signed, (d) => didKeyToPublicKey(d));
  ok(verified === true, '(b) vc-2.0 verifiable: real eddsa-jcs-2022 Data Integrity proof verifies');

  // (e) tamper: flip the proofValue
  const tampered = structuredClone(signed);
  const pv = tampered.audit_signature.proof.proofValue;
  tampered.audit_signature.proof.proofValue = pv.slice(0, -1) + (pv.at(-1) === 'a' ? 'b' : 'a');
  ok((await verifyProofs(tampered, (d) => didKeyToPublicKey(d))) === false, '(e) vc-2.0 tampered proofValue fails');

  // (e) subject-digest mismatch — the proof itself is valid, but it attests the WRONG value
  const wrongCredential = { credentialSubject: { digest: 'sha256:' + '0'.repeat(64) }, audit_signature: {} };
  const wrongSigned = await sign(wrongCredential, { verificationMethod: did, created: '2026-01-01T00:00:00Z', privateKey });
  ok((await verifyProofs(wrongSigned, (d) => didKeyToPublicKey(d))) === true, '(e) vc-2.0 mismatched-subject proof still verifies cryptographically...');
  ok(norm(wrongSigned.credentialSubject.digest) !== expected, '(e) ...but fails structurally: subject-digest != resolved input digest (must reject overall)');
}

// ── (c) c2pa-manifest — structural only: manifest well-formed + hard-binding digest match ────────
{
  const policy_parameters = { doc_field: 42 };
  const pointer = '/doc_field';
  const resolved = resolveJsonPointer(policy_parameters, pointer);
  const expected = await digestHex(resolved.value);
  const goodManifest = {
    claim_generator: 'ainumbers/1.0',
    claim: { format: 'image/jpeg', instanceID: 'xmp:iid:test' },
    assertions: [{ label: 'c2pa.hash.data', hash: 'sha256:' + expected }, { label: 'c2pa.actions.v2' }],
    signature: { alg: 'es256', present: true },
  };
  const { output_payload } = await c2paCompute(goodManifest);
  ok(output_payload.manifest_valid && output_payload.has_hard_binding, '(c) c2pa-manifest structurally well-formed + hard-binding present');
  const hb = goodManifest.assertions.find((a) => a.label === 'c2pa.hash.data');
  ok(norm(hb.hash) === expected, '(c) c2pa-manifest hard-binding digest matches the resolved input digest');

  // (e) tamper: hard-binding digest no longer matches the resolved input
  const badManifest = { ...goodManifest, assertions: [{ label: 'c2pa.hash.data', hash: 'sha256:' + '1'.repeat(64) }, { label: 'c2pa.actions.v2' }] };
  const badHb = badManifest.assertions.find((a) => a.label === 'c2pa.hash.data');
  ok(norm(badHb.hash) !== expected, '(e) c2pa-manifest tampered hard-binding digest fails the match');

  // (e) missing hard-binding assertion entirely
  const noBindingManifest = { ...goodManifest, assertions: [{ label: 'c2pa.actions.v2' }] };
  const { output_payload: nb } = await c2paCompute(noBindingManifest);
  ok(!nb.has_hard_binding, '(e) c2pa-manifest with no hard-binding assertion fails structurally');
}

// ── (d) zktls — structural digest-binding only; OCG ships NO verifier (§23.1) ────────────────────
{
  const policy_parameters = { session: { attested_field: 'residency-us' } };
  const pointer = '/session/attested_field';
  const resolved = resolveJsonPointer(policy_parameters, pointer);
  const expected = await digestHex(resolved.value);
  const goodProof = { subject_digest: 'sha256:' + expected, attestation_id: 'zktls-demo-1' };
  ok(norm(goodProof.subject_digest) === expected, '(d) zktls structural: subject_digest binds to the resolved input digest');
  // (e) tamper: subject_digest no longer matches -> structural fail (verifiable stays "external" regardless)
  const badProof = { subject_digest: 'sha256:' + '2'.repeat(64) };
  ok(norm(badProof.subject_digest) !== expected, '(e) zktls tampered subject_digest fails the structural digest-binding check');
}

console.log(fail ? `\n✗ ${fail} FAILED` : '\n✓ all validate_input_attestations assertions passed');
process.exit(fail ? 1 : 0);
