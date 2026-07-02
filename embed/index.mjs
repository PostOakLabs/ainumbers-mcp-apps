// @postoaklabs/ocgr-embed — public entry point.
//
// Run AINumbers' verified compliance logic inside your own environment, and verify
// any OpenChainGraph execution_hash offline against the public OCG standard, without
// calling us. Zero telemetry, zero network calls. License: CC BY 4.0.
//
// Exports:
//   runChain              — execute a whole chain locally -> ONE composite execution_hash
//                           (byte-identical to the live Worker's run_chain).
//   verifyExecutionHash   — §4  recompute + compare an artifact's execution_hash.
//   verifySignature       — §16 W3C Data Integrity (eddsa-jcs-2022) signature check.
//   verifyComputeProof    — §18 risc0 Groth16-BN254 compute-integrity seal check.
//   getKernels            — the deterministic kernel registry (lazy; needs vendored kernels/).
//   plus low-level primitives (executionHash, sign, verifySeal, ...) re-exported verbatim.

export { runChain, default as default } from './runChain.mjs';
export {
  verifyExecutionHash,
  verifySignature,
  verifyComputeProof,
  executionHash,
  cgCanon,
  sign,
  verifySignatureRaw,
  verifySeal,
  verifyBinding,
  rawPubkeyToDidKey,
  didKeyToPublicKey,
  PROOF_CRYPTOSUITE,
  RECOMMENDED_RECEIPT_FORMAT,
  SEAL_VERIFICATION,
} from './verify.mjs';

// Lazy accessor for the deterministic kernel registry (kept out of the verifier surface
// so verify.mjs stays dependency-free). Resolves against the vendored ../kernels/ tree.
export async function getKernels() {
  return import('../kernels/index.mjs');
}
