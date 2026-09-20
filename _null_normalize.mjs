// _null_normalize.mjs — MR-R4-NULL-NORMALIZE-WORKER-1.
// Shared zero-dep null-member normalizer for the MCP worker boundary (node: builtins only).
//
// WHY: a destructuring default (`= {}`, `= 12`) fires on `undefined` and never on `null`, and
// `Number(null) === 0` passes finiteness checks. An MCP client emitting `{"periods_per_year": null}`
// for "not supplied" therefore reaches kernels with a value their own "not supplied" path never
// sees — measured 171 published tools diverge or throw on it (MR-R4-NULL-CLASS-DESIGN-2026-09-20).
// Every kernel already handles the ABSENT side correctly, so the caller removes the null members
// and hands the kernel the input it already handles. Normalization runs BEFORE compute, and the
// SAME normalized object feeds the execution_hash preimage — never fold this into _hash.mjs:
// a hash-only fold would give a null-carrying call and a null-free call IDENTICAL receipts while
// they still compute DIFFERENT answers.
//
// Contract (SPEC.md §4-safe; the normalizer is idempotent, so the recorded normalized parameters
// are their own fixed point and a replayer recomputes the identical hash):
//   - recursively REMOVE object members whose value is `null`, at every depth;
//   - PRESERVE `null` array elements unchanged — array nulls are positional and dropping one
//     shifts every later index;
//   - never mutate the input; idempotent (its own output is a fixed point);
//   - `schema` is the tool manifest's JSON-Schema-ish `input_schema` (optional). An input property
//     declaring `x_null_distinct: true` is EXCLUDED from normalization at that depth — null is a
//     meaningful third state there. Nested `properties` are honoured recursively, `items` for
//     arrays. Measured 2026-09-20: 0 properties declare it; this is forward-compatibility.
//
// Input domain is the JSON the MCP transport parses (no cycles, no class instances); values that
// are neither arrays, objects, nor null are returned unchanged.
export function normalizeNullMembers(value, schema) {
  if (Array.isArray(value)) {
    let changed = false;
    const out = new Array(value.length);
    for (let i = 0; i < value.length; i++) {
      const el = value[i];
      if (el === null) { out[i] = null; continue; } // positional — never dropped
      const n = normalizeNullMembers(el, schema?.items);
      if (n !== el) changed = true;
      out[i] = n;
    }
    return changed ? out : value;
  }
  if (value !== null && typeof value === 'object') {
    const props = schema?.properties;
    const out = {};
    let changed = false;
    for (const k of Object.keys(value)) {
      const v = value[k];
      if (v === null) {
        if (props?.[k]?.x_null_distinct) { out[k] = null; continue; } // declared opt-out honoured
        changed = true; // drop the member; its absence IS the kernel's "not supplied"
        continue;
      }
      const n = normalizeNullMembers(v, props?.[k]);
      if (n !== v) changed = true;
      out[k] = n;
    }
    return changed ? out : value;
  }
  return value;
}
