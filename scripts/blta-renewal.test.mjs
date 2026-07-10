// blta-renewal.test.mjs — EXPORT-1 §E1.c: archive-timestamp renewal due-check + append/verify.
// Uses the SAME real committed FreeTSA rfc3161-tst token as the §20 anchor-binding gate fixture
// (scripts/fixtures/anchor-binding.fixture.json, copied verbatim from
// repo/chaingraph/kernels/fixtures/anchor-binding.fixture.json) — zero network calls, offline.
//
// The append-mechanics test below appends that SAME real token a second time to the artifact's
// anchor_bindings array. This is deliberate, not a shortcut: obtaining a SECOND, independently
// timestamped token requires a live TSA call, which is the explicitly FLAGGED, out-of-fence step
// (see _blta.mjs header). Reusing the real token still exercises exactly what appendArchiveTimestamp
// + verifyAllBindings need to prove — that append is purely additive and every entry (old and new)
// independently re-verifies via the SAME §20 verifier, with zero drift to the prior entry.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dueForRenewal, appendArchiveTimestamp, verifyAllBindings, DEFAULT_RENEWAL_HORIZON_MS } from '../_blta.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = JSON.parse(readFileSync(join(HERE, 'fixtures', 'anchor-binding.fixture.json'), 'utf8'));
const artifact = FIX.artifact;
// The fixture carries one entry per §20 anchor type (rfc3161-tst, c2sp-tlog-proof-v1,
// scitt-receipt-rfc9942) — this module only concerns the rfc3161-tst one.
const binding = artifact.anchor_bindings.find((b) => b.type === 'rfc3161-tst');
const bindingCount = artifact.anchor_bindings.length;

let fail = 0;
const ok = (c, m) => { if (!c) { fail++; console.error('  ✗ ' + m); } else console.log('  ✓ ' + m); };

console.log('§E1.c B-LTA archive-timestamp renewal (due-check + append/verify)\n');

// gen_time = 20260702220049Z -> 2026-07-02T22:00:49Z
const GEN_MS = Date.UTC(2026, 6, 2, 22, 0, 49);

// ── dueForRenewal ──────────────────────────────────────────────────────────────────────────────
{
  ok(!dueForRenewal(binding, { nowMs: GEN_MS + 24 * 60 * 60 * 1000 }), 'not due 1 day after gen_time');
  ok(!dueForRenewal(binding, { nowMs: GEN_MS + DEFAULT_RENEWAL_HORIZON_MS - 1 }), 'not due 1ms before the horizon');
  ok(dueForRenewal(binding, { nowMs: GEN_MS + DEFAULT_RENEWAL_HORIZON_MS }), 'due exactly at the horizon');
  ok(dueForRenewal(binding, { nowMs: GEN_MS + DEFAULT_RENEWAL_HORIZON_MS + 1000 }), 'due past the horizon');

  let threwNoNow = false;
  try { dueForRenewal(binding, {}); } catch { threwNoNow = true; }
  ok(threwNoNow, 'throws without a caller-supplied nowMs (no Date.now() inside the module)');

  let threwBadType = false;
  try { dueForRenewal({ type: 'opentimestamps', gen_time: binding.gen_time }, { nowMs: GEN_MS }); } catch { threwBadType = true; }
  ok(threwBadType, 'throws for a non-rfc3161-tst binding type');
}

// ── baseline: the shipped fixture still verifies via the SAME §20 verifier (zero drift) ──────────
{
  const before = verifyAllBindings(artifact);
  ok(before.length === bindingCount, 'verifyAllBindings reports one result per existing binding');
  ok(before.find((r) => r.type === 'rfc3161-tst')?.verified === true, 'the fixture rfc3161-tst binding verifies before any append');
}

// ── appendArchiveTimestamp: additive, prior entries undisturbed, all verify afterward ─────────────
{
  const renewed = appendArchiveTimestamp(artifact, binding);
  ok(renewed !== artifact, 'appendArchiveTimestamp returns a NEW artifact object (no in-place mutation)');
  ok(artifact.anchor_bindings.length === bindingCount, 'the original artifact.anchor_bindings is untouched');
  ok(renewed.anchor_bindings.length === bindingCount + 1, 'the new artifact carries every original binding plus the appended one');
  ok(renewed.execution_hash === artifact.execution_hash, 'execution_hash is untouched — anchor_bindings stays hash-EXCLUDED per §20');

  const after = verifyAllBindings(renewed);
  ok(after.length === bindingCount + 1, 'verifyAllBindings reports one result per binding after append');
  const rfc3161Results = after.filter((r) => r.type === 'rfc3161-tst');
  ok(rfc3161Results.length === 2, 'two rfc3161-tst entries after append (original + appended)');
  ok(rfc3161Results.every((r) => r.verified === true), 'both rfc3161-tst bindings independently verify — append introduced zero drift');
}

// ── appendArchiveTimestamp rejects a non-rfc3161-tst fresh binding ────────────────────────────────
{
  let threw = false;
  try { appendArchiveTimestamp(artifact, { type: 'opentimestamps' }); } catch { threw = true; }
  ok(threw, 'appendArchiveTimestamp rejects a freshBinding that is not rfc3161-tst');
}

// ── verifyAllBindings reports verified:null for out-of-scope types, verified:false on tamper ─────
{
  const otherType = { ...artifact, anchor_bindings: [{ type: 'opentimestamps' }] };
  const r1 = verifyAllBindings(otherType);
  ok(r1[0].verified === null, 'verifyAllBindings reports null (out of scope) for a non-rfc3161-tst binding');

  const tampered = { ...artifact, anchor_bindings: [{ ...binding, anchored_hash: 'sha256:' + '0'.repeat(64) }] };
  const r2 = verifyAllBindings(tampered);
  ok(r2[0].verified === false, 'verifyAllBindings reports false for a binding whose anchored_hash no longer matches the token');
}

console.log(fail ? `\n✗ ${fail} FAILED` : '\n✓ all B-LTA renewal assertions passed');
process.exit(fail ? 1 : 0);
