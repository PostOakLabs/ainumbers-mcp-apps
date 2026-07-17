// credwork.mjs — server-side crypto for the CREDWORK-1 MCP tools (vc_issue, sdjwt_issue, sdjwt_present).
//
// Reuses the shared canonicalizer (kernels/_hash.mjs) and did:key <-> raw-Ed25519 helpers
// (kernels/_proof.mjs) — same eddsa-jcs-2022 machinery the browser tools use, no second
// canonicalization path. The generic doc-signer here differs from kernels/_proof.mjs's `sign()`
// only in WHERE the proof lives: kernels/_proof.mjs hardcodes `audit_signature.proof` (the OCG
// artifact convention, §16); a W3C VC 2.0 credential carries its Data Integrity proof at the
// document ROOT (`proof`), so this module signs/verifies at an arbitrary top-level field.
//
// SD-JWT (RFC 9901) is hand-rolled per CREDWORK-1-BUILD-SPEC.md: openwallet-foundation/sd-jwt-js
// is reference-only, never vendored. Each MCP call generates a fresh ephemeral Ed25519 keypair —
// nothing persists between calls, so a caller who wants a stable issuer identity must anchor the
// returned did:key externally (this tool does not hold keys across requests).

import { cgCanon, executionHash } from './kernels/_hash.mjs';
import { rawPubkeyToDidKey, didKeyToPublicKey } from './kernels/_proof.mjs';

const enc = (s) => new TextEncoder().encode(s);
const dec = (b) => new TextDecoder().decode(b);

async function sha256(bytes) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}
function jcsBytes(obj) { return enc(JSON.stringify(cgCanon(obj))); }
async function sha256HexOfCanon(v) {
  const b = await sha256(jcsBytes(v));
  return Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('');
}

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58encode(bytes) {
  let zeros = 0; while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const digits = [0];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j++) { carry += digits[j] << 8; digits[j] = carry % 58; carry = (carry / 58) | 0; }
    while (carry) { digits.push(carry % 58); carry = (carry / 58) | 0; }
  }
  let out = ''; for (let k = 0; k < zeros; k++) out += '1';
  for (let q = digits.length - 1; q >= 0; q--) out += B58[digits[q]];
  return out;
}
function b58decode(str) {
  let zeros = 0; while (zeros < str.length && str[zeros] === '1') zeros++;
  const bytes = [0];
  for (let i = zeros; i < str.length; i++) {
    let carry = B58.indexOf(str[i]); if (carry < 0) throw new Error('bad base58 char');
    for (let j = 0; j < bytes.length; j++) { carry += bytes[j] * 58; bytes[j] = carry & 0xff; carry >>= 8; }
    while (carry) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  const out = new Uint8Array(zeros + bytes.length);
  for (let k = 0; k < bytes.length; k++) out[zeros + bytes.length - 1 - k] = bytes[k];
  return out;
}
function b64u(bytes) {
  let bin = ''; for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64uDecode(str) {
  const bin = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ── Generic eddsa-jcs-2022 doc signer/verifier at an arbitrary root-level proof field ─────────────
function proofOptions({ verificationMethod, created }) {
  return { type: 'DataIntegrityProof', cryptosuite: 'eddsa-jcs-2022', verificationMethod, proofPurpose: 'assertionMethod', created };
}
async function hashData(doc, opts) {
  const optHash = await sha256(jcsBytes(opts));
  const docHash = await sha256(jcsBytes(doc));
  const cat = new Uint8Array(optHash.length + docHash.length);
  cat.set(optHash, 0); cat.set(docHash, optHash.length);
  return cat;
}
export async function signDoc(doc, proofField, { verificationMethod, created, privateKey }) {
  const opts = proofOptions({ verificationMethod, created });
  const secured = JSON.parse(JSON.stringify(doc)); delete secured[proofField];
  const sigBytes = new Uint8Array(await crypto.subtle.sign('Ed25519', privateKey, await hashData(secured, opts)));
  const proof = { ...opts, proofValue: 'z' + b58encode(sigBytes) };
  const out = JSON.parse(JSON.stringify(doc)); out[proofField] = proof;
  return out;
}
export async function verifyDoc(doc, proofField, publicKey) {
  const proof = doc[proofField];
  if (!proof || proof.type !== 'DataIntegrityProof' || proof.cryptosuite !== 'eddsa-jcs-2022') return false;
  if (proof.proofPurpose !== 'assertionMethod' || typeof proof.proofValue !== 'string' || proof.proofValue[0] !== 'z') return false;
  const opts = proofOptions({ verificationMethod: proof.verificationMethod, created: proof.created });
  try {
    const sig = b58decode(proof.proofValue.slice(1));
    const secured = JSON.parse(JSON.stringify(doc)); delete secured[proofField];
    return await crypto.subtle.verify('Ed25519', publicKey, sig, await hashData(secured, opts));
  } catch { return false; }
}

// ── VC 2.0 issuance ────────────────────────────────────────────────────────────────────────────
export async function issueVc({ subject_id, credential_type, claims, valid_from, valid_until, pointer }) {
  const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const issuerDid = await rawPubkeyToDidKey(kp.publicKey);
  const created = new Date().toISOString();
  const subjectId = subject_id || 'did:example:subject';
  const ptr = pointer || '/subject_claims';

  const credentialSubject = { id: subjectId, ...claims, digestSHA256: await sha256HexOfCanon(claims) };
  const unsigned = {
    '@context': ['https://www.w3.org/ns/credentials/v2'],
    type: credential_type ? ['VerifiableCredential', credential_type] : ['VerifiableCredential'],
    issuer: issuerDid,
    validFrom: valid_from || created,
    credentialSubject,
  };
  if (valid_until) unsigned.validUntil = valid_until;

  const credential = await signDoc(unsigned, 'proof', { verificationMethod: issuerDid, created, privateKey: kp.privateKey });
  const input_attestation = { pointer: ptr, type: 'vc-2.0', proof: credential };

  const policy_parameters = { activity: 'vc_issuance', issuer: issuerDid, subject: subjectId, credential_type: credential_type || 'VerifiableCredential', pointer: ptr };
  const output_payload = { credential_digest: await sha256HexOfCanon(credential), verification_method: issuerDid, issued_at: created };
  const receipt = { chaingraph_version: '0.4.0', tool_id: 'vc_issue', generated_at: created, policy_parameters, output_payload, execution_hash: await executionHash(policy_parameters, output_payload) };

  return { credential, input_attestation, receipt };
}

// ── SD-JWT (RFC 9901), hand-rolled ────────────────────────────────────────────────────────────
async function makeDisclosure(key, value) {
  const salt = b64u(crypto.getRandomValues(new Uint8Array(16)));
  const arr = [salt, key, value];
  const str = b64u(enc(JSON.stringify(arr)));
  const digest = b64u(await sha256(enc(str)));
  return { salt, key, value, str, digest };
}
function b64uJson(obj) { return b64u(enc(JSON.stringify(obj))); }
function b64uJsonDecode(str) { return JSON.parse(dec(b64uDecode(str))); }
function looksLikeJwt(s) { return typeof s === 'string' && s.split('.').length === 3; }

export async function issueSdJwt({ claims, selective_keys, subject, issuer }) {
  const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const issuerDid = issuer || await rawPubkeyToDidKey(kp.publicKey);
  const selective = new Set(selective_keys || []);
  const cleartext = {}; const disclosures = [];
  for (const k of Object.keys(claims || {})) {
    if (selective.has(k)) disclosures.push(await makeDisclosure(k, claims[k]));
    else cleartext[k] = claims[k];
  }
  const payload = { ...cleartext, iss: issuerDid, sub: subject || 'subject-001', iat: Math.floor(Date.now() / 1000), _sd: disclosures.map((d) => d.digest), _sd_alg: 'sha-256' };
  const header = { alg: 'EdDSA', typ: 'vc+sd-jwt', kid: issuerDid };
  const signingInput = b64uJson(header) + '.' + b64uJson(payload);
  const sig = new Uint8Array(await crypto.subtle.sign('Ed25519', kp.privateKey, enc(signingInput)));
  const jwt = signingInput + '.' + b64u(sig);
  const sd_jwt = jwt + '~' + disclosures.map((d) => d.str).join('~') + '~';
  return { sd_jwt, issuer: issuerDid, payload, disclosures: disclosures.map(({ key, value, digest }) => ({ key, value, digest })) };
}

export async function parseSdJwt(sd_jwt) {
  const segments = sd_jwt.split('~');
  const jwt = segments[0];
  let rest = segments.slice(1);
  let kbjwt = null;
  if (rest.length && rest[rest.length - 1] === '') rest = rest.slice(0, -1);
  else if (rest.length && looksLikeJwt(rest[rest.length - 1])) { kbjwt = rest[rest.length - 1]; rest = rest.slice(0, -1); }
  const parts = jwt.split('.');
  if (parts.length !== 3) throw new Error('Malformed SD-JWT: issuer-signed JWT must have 3 dot-separated parts.');
  const header = b64uJsonDecode(parts[0]);
  const payload = b64uJsonDecode(parts[1]);
  const disclosures = [];
  for (const str of rest) {
    if (!str) throw new Error('Malformed SD-JWT: empty disclosure segment.');
    const arr = b64uJsonDecode(str);
    if (!Array.isArray(arr) || arr.length !== 3) throw new Error('Malformed disclosure: expected [salt, key, value].');
    const digest = b64u(await sha256(enc(str)));
    disclosures.push({ salt: arr[0], key: arr[1], value: arr[2], str, digest });
  }
  return { jwt, header, payload, signingInput: parts[0] + '.' + parts[1], signatureB64u: parts[2], disclosures, kbjwt };
}

export async function verifySdJwt(sd_jwt, issuerPublicKey) {
  const parsed = await parseSdJwt(sd_jwt);
  let sigOk = false;
  try { sigOk = await crypto.subtle.verify('Ed25519', issuerPublicKey, b64uDecode(parsed.signatureB64u), enc(parsed.signingInput)); } catch { sigOk = false; }
  const sdSet = new Set(parsed.payload._sd || []);
  const disclosed = {}; const invalidDisclosures = [];
  for (const d of parsed.disclosures) {
    if (sdSet.has(d.digest)) disclosed[d.key] = d.value;
    else invalidDisclosures.push(d.key);
  }
  const resolvedClaims = { ...parsed.payload };
  delete resolvedClaims._sd; delete resolvedClaims._sd_alg;
  Object.assign(resolvedClaims, disclosed);
  return { sigOk, resolvedClaims, disclosedKeys: Object.keys(disclosed), invalidDisclosures, parsed };
}

export async function presentSdJwt(sd_jwt, keepKeys, kb) {
  const parsed = await parseSdJwt(sd_jwt);
  const kept = parsed.disclosures.filter((d) => keepKeys.includes(d.key));
  const core = parsed.jwt + '~' + kept.map((d) => d.str).join('~') + '~';
  if (!kb) return { presentation: core, kbjwt: null };
  const kbHeader = { alg: 'EdDSA', typ: 'kb+jwt' };
  const sdHashDigest = b64u(await sha256(enc(core)));
  const kbPayload = { iat: Math.floor(Date.now() / 1000), aud: kb.aud, nonce: kb.nonce, sd_hash: sdHashDigest };
  const kbSigningInput = b64uJson(kbHeader) + '.' + b64uJson(kbPayload);
  const kbSig = new Uint8Array(await crypto.subtle.sign('Ed25519', kb.privateKey, enc(kbSigningInput)));
  const kbCompact = kbSigningInput + '.' + b64u(kbSig);
  return { presentation: core + kbCompact, kbjwt: kbCompact, kbPayload };
}

export async function presentSdJwtTool({ sd_jwt, keep_keys, issuer_did, aud, nonce }) {
  let kb = null; let holderDid = null;
  if (aud) {
    const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
    holderDid = await rawPubkeyToDidKey(kp.publicKey);
    kb = { aud, nonce: nonce || b64u(crypto.getRandomValues(new Uint8Array(12))), privateKey: kp.privateKey };
  }
  const built = await presentSdJwt(sd_jwt, keep_keys || [], kb);
  const out = { presentation: built.presentation, kbjwt: built.kbjwt, holder_did: holderDid };
  if (issuer_did) {
    const issuerPub = await didKeyToPublicKey(issuer_did);
    const verified = await verifySdJwt(built.presentation, issuerPub);
    out.verifier_view = verified.resolvedClaims;
    out.sig_ok = verified.sigOk;

    const created = new Date().toISOString();
    const policy_parameters = { activity: 'sdjwt_presentation', issuer: issuer_did, disclosed_keys: verified.disclosedKeys, holder_bound: !!kb };
    const output_payload = { input_sd_jwt_digest: await sha256HexOfCanon(sd_jwt), presentation_digest: await sha256HexOfCanon(built.presentation), presented_at: created };
    out.receipt = { chaingraph_version: '0.4.0', tool_id: 'sdjwt_present', generated_at: created, policy_parameters, output_payload, execution_hash: await executionHash(policy_parameters, output_payload) };
  }
  return out;
}
