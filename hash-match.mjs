// hash-match.mjs — the one comparison every recompute-and-compare check in the worker uses.
//
// HASH-NULL-NEVER-MATCHES-1. The site SSOT hasher (kernels/_hash.mjs, vendored) is moving from
// "throw when a preimage cannot be canonicalized" to "return null" (site HASH-REFUSAL-SHARED-1),
// and a kernel artifact built from such a payload then carries `execution_hash: null`. A bare
// `recomputed === artifact.execution_hash` would read that as a MATCH (null === null), so a
// receipt nobody could hash would be reported as verified. A recomputed hash that is not a
// non-empty string is "no hash", and "no hash" never matches anything, including another null.
//
// This file compares two digests; it computes none. The only execution-hash implementation the
// worker uses is still the SSOT executionHash() imported from ./kernels/_hash.mjs.

/**
 * True only when `recomputed` is a non-empty string and is byte-identical to `claimed`.
 * null, undefined, '' or any non-string on the recomputed side is never a match.
 * @param {unknown} recomputed  the hash this process just computed (may be null on refusal)
 * @param {unknown} claimed     the hash the artifact or receipt carries
 * @returns {boolean}
 */
export function hashesMatch(recomputed, claimed) {
  return typeof recomputed === 'string' && recomputed.length > 0 && recomputed === claimed;
}
