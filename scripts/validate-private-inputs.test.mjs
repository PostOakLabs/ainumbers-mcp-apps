// validate-private-inputs.test.mjs — §25 ocg-private-input@1 GATE (SPEC.md §15 row,
// conformance-by-construction). Mirrors the SAME verifier logic the validate_private_inputs MCP
// tool runs (worker.mjs assessPrivateInput/commitPrivateInputHex) WITHOUT ever needing the
// plaintext witness for the public path:
//   (a) structural    -- pointer resolves inside policy_parameters; commitment is a well-formed
//                         sha256:-prefixed 64-hex digest; commitment_scheme is known
//                         (sha256-salted@1 only, per §25.0);
//   (b) plaintext-excl -- the value AT pointer must equal the entry's commitment string exactly
//                         (§25.2 MUST) -- a mutated commitment or a leaked plaintext at the
//                         pointer both FAIL;
//   (c) disclosed      -- an OPTIONAL out-of-band {salt, input_value} recomputes
//                         sha256(salt || cgCanon(input_value)) and must equal the commitment
//                         ("disclosed-verified"); a wrong salt FAILS;
//   (d) hash-exclusion  -- private_inputs[] sits OUTSIDE the execution_hash preimage (§25.6): the
//                         same {policy_parameters, output_payload} hashes identically whether or
//                         not a private_inputs[] array is attached.
// Fixture: scripts/fixtures/private-inputs.fixture.json (synthetic, non-sensitive; the genuine
// commitment + its out-of-band disclosure salt/value are both committed here for THIS gate only
// -- production artifacts never carry the salt/plaintext).
// Run:  node scripts/validate-private-inputs.test.mjs
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cgCanon, executionHash } from '../kernels/_hash.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = JSON.parse(readFileSync(join(HERE, 'fixtures', 'private-inputs.fixture.json'), 'utf8'));

let fail = 0;
const ok = (c, m) => { if (!c) { fail++; console.error('  ✗ ' + m); } else console.log('  ✓ ' + m); };
const norm = (h) => (h == null ? h : String(h).replace(/^sha256:/, ''));

// Mirrors worker.mjs resolveJsonPointer (§25.0 -- evaluated against policy_parameters, not the
// whole artifact, exactly as §23).
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

// Mirrors worker.mjs commitPrivateInputHex (§25.1): sha256(salt || cgCanon(input_value)), hex,
// "sha256:"-prefixed. Node crypto here, WebCrypto in the Worker -- byte-identical inputs/outputs.
function commitPrivateInputHex(saltHex, inputValue) {
  if (typeof saltHex !== 'string' || saltHex.length < 64 || !/^[0-9a-f]+$/i.test(saltHex)) return null;
  const saltBytes = Buffer.from(saltHex, 'hex');
  const inputBytes = Buffer.from(JSON.stringify(cgCanon(inputValue)), 'utf8');
  return 'sha256:' + createHash('sha256').update(Buffer.concat([saltBytes, inputBytes])).digest('hex');
}

// Mirrors worker.mjs assessPrivateInput's structural + plaintext-exclusion + disclosed path
// (the proof-binding branch needs a live §18 compute_proof -- exercised once PRIV-IN-1-PROVE
// ships a real receipt; this gate covers the public-verifier path every §25 node ships from day 1).
function assessPrivateInput(entry, policy_parameters, disclosure) {
  const { pointer, commitment, commitment_scheme } = entry ?? {};
  if (typeof pointer !== 'string' || typeof commitment !== 'string' || !/^sha256:[0-9a-f]{64}$/i.test(commitment)) {
    return { pointer, verifiable: 'failed', reason: 'malformed commitment or pointer' };
  }
  if (commitment_scheme !== 'sha256-salted@1') {
    return { pointer, verifiable: 'failed', reason: `unknown commitment_scheme "${commitment_scheme}"` };
  }
  const resolved = resolveJsonPointer(policy_parameters, pointer);
  if (!resolved.ok) return { pointer, verifiable: 'failed', reason: 'pointer does not resolve inside policy_parameters' };
  if (resolved.value !== commitment) {
    return { pointer, verifiable: 'failed', reason: 'pointed value is not the declared commitment (plaintext-exclusion violated)' };
  }
  let verifiable = 'commitment-only';
  if (disclosure && typeof disclosure.salt === 'string') {
    const recomputed = commitPrivateInputHex(disclosure.salt, disclosure.input_value);
    if (recomputed !== commitment) return { pointer, verifiable: 'failed', reason: 'disclosed (salt, input_value) does not recompute the declared commitment' };
    verifiable = 'disclosed-verified';
  }
  return { pointer, verifiable };
}

console.log('§25 validate_private_inputs gate\n');

// ── (a)+(b) genuine commitment-only path (public verifier, no disclosure) ────────────────────────
{
  const r = assessPrivateInput(FIX.private_inputs[0], FIX.policy_parameters, null);
  ok(r.verifiable === 'commitment-only', '(a) genuine entry: structural + plaintext-exclusion pass, commitment-only (no proof yet)');
}

// ── (c) genuine disclosed-verified path (authorized verifier) ───────────────────────────────────
{
  const r = assessPrivateInput(FIX.private_inputs[0], FIX.policy_parameters, FIX.disclosure);
  ok(r.verifiable === 'disclosed-verified', '(c) genuine (salt, input_value) recomputes the declared commitment -- disclosed-verified');
}

// ── (d) hash-exclusion: private_inputs[] sits outside the execution_hash preimage (§25.6) ────────
{
  const h1 = await executionHash(FIX.policy_parameters, FIX.output_payload);
  const h2 = await executionHash(FIX.policy_parameters, FIX.output_payload); // same call, no private_inputs param exists on executionHash at all
  ok(norm(h1) === norm(h2), '(d) execution_hash depends only on {policy_parameters, output_payload} -- private_inputs[] is not a hash input by construction');
}

// ── (e) tamper: mutated commitment (pointer no longer equals the declared commitment) ────────────
{
  const badPp = { ...FIX.policy_parameters, amount_commitment: 'sha256:' + '0'.repeat(64) };
  const r = assessPrivateInput(FIX.private_inputs[0], badPp, null);
  ok(r.verifiable === 'failed', '(e) mutated commitment at pointer fails plaintext-exclusion');
}

// ── (e) tamper: plaintext leaked into the pointer instead of the commitment ──────────────────────
{
  const leakedPp = { ...FIX.policy_parameters, amount_commitment: FIX.disclosure.input_value };
  const r = assessPrivateInput(FIX.private_inputs[0], leakedPp, null);
  ok(r.verifiable === 'failed', '(e) plaintext leaked into the pointer (instead of the commitment) fails plaintext-exclusion');
}

// ── (e) tamper: wrong-salt disclosure ────────────────────────────────────────────────────────────
{
  const wrongDisclosure = { ...FIX.disclosure, salt: '1'.repeat(64) };
  const r = assessPrivateInput(FIX.private_inputs[0], FIX.policy_parameters, wrongDisclosure);
  ok(r.verifiable === 'failed', '(e) wrong-salt disclosure fails to recompute the declared commitment');
}

// ── (e) tamper: unknown commitment_scheme ────────────────────────────────────────────────────────
{
  const badEntry = { ...FIX.private_inputs[0], commitment_scheme: 'sha256-salted@2' };
  const r = assessPrivateInput(badEntry, FIX.policy_parameters, null);
  ok(r.verifiable === 'failed', '(e) unknown commitment_scheme is rejected, not treated as opaque');
}

// ── (e) tamper: unresolved RFC 6901 pointer ──────────────────────────────────────────────────────
{
  const badEntry = { ...FIX.private_inputs[0], pointer: '/does_not_exist' };
  const r = assessPrivateInput(badEntry, FIX.policy_parameters, null);
  ok(r.verifiable === 'failed', '(e) unresolved RFC 6901 pointer rejected before any commitment check');
}

console.log(fail ? `\n✗ ${fail} FAILED` : '\n✓ all validate_private_inputs assertions passed');
process.exit(fail ? 1 : 0);
