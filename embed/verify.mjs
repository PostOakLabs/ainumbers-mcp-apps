// OCGR embedded verifiers — offline, dependency-free, zero-network.
//
// Re-exports the THREE canonical OpenChainGraph verification paths so a firm can
// check ANY OCG artifact inside its own walls, without ever calling AINumbers:
//   §4  execution_hash  — recompute SHA-256 over canonical {policy_parameters, output_payload}.
//   §16 signature       — W3C Data Integrity eddsa-jcs-2022 (whole-artifact).
//   §18 compute_proof   — risc0 Groth16-BN254 seal (self-contained BN254 reference verifier).
//
// Every function below is a thin re-export of the SAME code the live Worker and the
// browser tools run (mcp-apps-poc/kernels/_hash.mjs + _proof.mjs, and the site repo's
// _computeproof.mjs). No math is re-implemented here. crypto.subtle is used for §4/§16
// and is present in Node 18+ and every modern browser; §18 is pure JS (vendored @noble).

import { executionHash, cgCanon } from './lib/_hash.mjs';
import { verify as verifySignatureDI, didKeyToPublicKey } from './lib/_proof.mjs';
import { verifySeal } from './lib/_computeproof.mjs';

// Low-level primitives, re-exported verbatim for callers who want them directly.
export { executionHash, cgCanon } from './lib/_hash.mjs';
export { verify as verifySignatureRaw, sign, rawPubkeyToDidKey, didKeyToPublicKey, PROOF_CRYPTOSUITE } from './lib/_proof.mjs';
export { verifySeal, verifyBinding, normId, SEAL_VERIFICATION, RECOMMENDED_RECEIPT_FORMAT } from './lib/_computeproof.mjs';

const stripPrefix = (h) => (h == null ? h : String(h).replace(/^sha256:/, ''));

/**
 * §4 — verify an artifact's execution_hash. Recomputes SHA-256 over the canonical
 * {policy_parameters, output_payload} and compares to the claimed hash.
 * @param {object} artifact  Full OCG artifact (policy_parameters + output_payload + execution_hash),
 *   OR pass { policy_parameters, output_payload, claimed_hash } explicitly via the second arg.
 * @returns {Promise<{valid:boolean, computed_hash:string, claimed_hash:string|null}>}
 */
export async function verifyExecutionHash(artifact, override = {}) {
  const pp = override.policy_parameters ?? artifact?.policy_parameters;
  const op = override.output_payload ?? artifact?.output_payload;
  const claimed = override.claimed_hash ?? artifact?.execution_hash ?? null;
  if (pp === undefined || op === undefined) {
    throw new Error('verifyExecutionHash: need policy_parameters + output_payload (full artifact or explicit override).');
  }
  const computed_hash = await executionHash(pp, op);
  const valid = claimed != null && stripPrefix(computed_hash) === stripPrefix(claimed);
  return { valid, computed_hash, claimed_hash: claimed };
}

/**
 * §16 — verify an artifact's W3C Data Integrity signature (eddsa-jcs-2022).
 * Resolves the public key from artifact.audit_signature.proof.verificationMethod (did:key)
 * unless a CryptoKey is supplied. Returns false on any structural/crypto problem (never throws).
 * @param {object} artifact
 * @param {CryptoKey} [publicKey]  Optional pre-resolved Ed25519 public key.
 * @returns {Promise<boolean>}
 */
export async function verifySignature(artifact, publicKey = undefined) {
  const proof = artifact?.audit_signature?.proof;
  if (!proof) return false;
  let pk = publicKey;
  if (!pk) {
    try { pk = await didKeyToPublicKey(proof.verificationMethod); }
    catch { return false; }
  }
  return verifySignatureDI(artifact, pk);
}

/**
 * §18 — verify an artifact's compute-integrity proof (risc0 Groth16-BN254 seal).
 * Accepts either a full artifact (reads artifact.audit_signature.compute_proof) or a bare receipt.
 * @param {object} artifactOrReceipt
 * @returns {boolean}
 */
export function verifyComputeProof(artifactOrReceipt) {
  const receipt = artifactOrReceipt?.audit_signature?.compute_proof ?? artifactOrReceipt?.compute_proof ?? artifactOrReceipt;
  return verifySeal(receipt);
}
