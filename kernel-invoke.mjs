// kernel-invoke.mjs — the worker's kernel-invocation boundary.
//
// A kernel's buildArtifact() hashes its input through ./kernels/_hash.mjs, which throws on a value
// that cannot round-trip (NaN/Infinity, an integer beyond 2^53, a BigInt, nesting past MAX_DEPTH,
// more values than MAX_ELEMENTS). Today the two tools/call handlers catch that throw as
// tool.compute_error and the two run_chain engines label it input_required — two inconsistent
// answers for the same junk input.
//
// This module checks the SAME limits BEFORE the kernel is called and returns ONE refusal shape.
// The limit numbers are IMPORTED from the SSOT, never copied by hand; the refusal reason/detail
// vocabulary matches the merged tool pages (e.g. data/chaingraph/pages/art-753-home-office-augusta.html
// and 783-emv-mpm-qr-validator.html): reason is REFUSED_INPUT_UNSAFE_NUMBER or
// REFUSED_INPUT_HASH_LIMIT, detail is the path plus a kind suffix — never the value itself.
//
// Only the INPUT is pre-checked. A kernel that returns its own hash_refusal passes through
// untouched, and any other throw is rethrown unchanged so every existing catch behaves as today.

import { MAX_DEPTH, MAX_ELEMENTS } from './kernels/_hash.mjs';

function findHashRefusal(value, path, depth, budget) {
  if (depth > budget.maxDepth) return { reason: 'REFUSED_INPUT_HASH_LIMIT', detail: path + ': too_deep' };
  if (++budget.n > budget.maxElements) return { reason: 'REFUSED_INPUT_HASH_LIMIT', detail: path + ': too_many_values' };
  if (typeof value === 'bigint') return { reason: 'REFUSED_INPUT_UNSAFE_NUMBER', detail: path + ': bigint' };
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return { reason: 'REFUSED_INPUT_UNSAFE_NUMBER', detail: path + ': non_finite' };
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) return { reason: 'REFUSED_INPUT_UNSAFE_NUMBER', detail: path + ': unsafe_integer' };
    return null;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const r = findHashRefusal(value[i], path + '[' + i + ']', depth + 1, budget);
      if (r !== null) return r;
    }
    return null;
  }
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    for (const key of keys) {
      const r = findHashRefusal(value[key], path + '.' + key, depth + 1, budget);
      if (r !== null) return r;
    }
  }
  return null;
}

// Invoke a kernel's buildArtifact with a pre-flight refusal check on the normalised input.
// `kernel` is the module (getKernel(tool_id) result), `policy_parameters` the normalised input
// object, `options` the build options the call site already assembled. Returns the artifact
// unchanged on success, or { refused: true, execution_hash: null, hash_refusal: {reason, detail} }
// when the input cannot be hashed — without ever calling the kernel.
export async function invokeKernel(kernel, policy_parameters, options) {
  const refusal = findHashRefusal(policy_parameters, 'policy_parameters', 1, {
    maxDepth: MAX_DEPTH,
    maxElements: MAX_ELEMENTS,
    n: 0,
  });
  if (refusal !== null) {
    return { refused: true, execution_hash: null, hash_refusal: refusal };
  }
  return await kernel.buildArtifact(policy_parameters, options);
}
