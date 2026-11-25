// hash-sweep-classify.mjs — HASH-SWEEP-REFUSAL-CODE-1.
//
// hash-sweep.mjs calls a random sample of 40 live nodes after each deploy, and
// most get no fixture (kernels/fixtures is not vendored into this repo), so they
// run on empty inputs. An error on empty inputs is a "needs input", not a
// broken kernel, and the sweep recognised that only by English words in the
// message ("required", "missing", "must ", ...).
//
// The fail-closed kernel sweep on the site made many kernels refuse with a bare
// machine code instead, e.g. art-809's `throw new Error('UNIT')`, which reaches
// the sweep as "Kernel compute error: UNIT". With no English word to match, it
// was counted as a failure, so master's post-deploy CI went red whenever the
// random sample drew such a node (2026-11-25, run 45683212304: art-809).
//
// A refusal code on empty inputs now counts as needs-input too. A call that HAD
// a fixture still fails on any error, and hash_valid=false is never touched.

/** A kernel refusal carried as a bare upper-case code, optionally followed by `: detail`. */
export const REFUSAL_CODE = /(?:^|[Kk]ernel compute error:\s*)([A-Z][A-Z0-9_]{1,63})(?::|\s*$)/;

/** English phrasing that has always meant "this node needs real inputs". */
export const NEEDS_INPUT_WORDS = /required|missing|provide|non-?finite|nan|must |expected|undefined/i;

/**
 * Classify a tool error from the sweep.
 * @param {string} errorText the tool's error text
 * @param {boolean} usingFixture whether the call carried fixture inputs
 * @returns {'needs-input'|'fail'}
 */
export function classifyToolError(errorText, usingFixture) {
  if (usingFixture) return 'fail';
  const t = String(errorText || '').trim();
  if (NEEDS_INPUT_WORDS.test(t)) return 'needs-input';
  if (REFUSAL_CODE.test(t)) return 'needs-input';
  return 'fail';
}
