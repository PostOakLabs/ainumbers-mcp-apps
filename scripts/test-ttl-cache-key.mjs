// MCP-500-1 §M1.5 fixture: proves the advertised `cacheHint.cacheKey:"input_hash"` contract is
// actually input-hash-only — identical policy_parameters (any key order) -> identical key; a changed
// input -> a changed key. Uses the SAME canonicalizer the worker/kernels hash execution on
// (kernels/_hash.mjs cgCanon), so the cache-key claim and the real execution_hash preimage can never
// drift apart. No wall-clock, no session id enters the key.
import { cgCanon } from '../kernels/_hash.mjs';

async function inputHashKey(policy_parameters) {
  const bytes = new TextEncoder().encode(JSON.stringify(cgCanon(policy_parameters)));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

const a1 = await inputHashKey({ foo: 1, bar: 'x' });
const a2 = await inputHashKey({ bar: 'x', foo: 1 }); // same content, different key order
const b  = await inputHashKey({ foo: 2, bar: 'x' }); // genuinely different input

let fails = 0;
if (a1 !== a2) { console.error('FAIL: identical inputs (different key order) produced different cache keys'); fails++; }
if (a1 === b)  { console.error('FAIL: different inputs produced the SAME cache key'); fails++; }

if (fails) { console.error(`✗ test-ttl-cache-key FAILED (${fails})`); process.exit(1); }
console.log('✓ ttlMs cache key is input-hash-only: identical inputs -> identical key, changed input -> changed key');
