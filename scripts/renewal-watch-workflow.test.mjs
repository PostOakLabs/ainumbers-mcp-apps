// renewal-watch-workflow.test.mjs — GAP-a §A.2/§A.3: exercises the durable Workflow's pure logic
// offline (the real `step.do`/`step.sleep` scaffolding only exists inside a live CF Workflows
// runtime — see workflows/renewal-watch-workflow.mjs header). Reuses the SAME real committed
// FreeTSA rfc3161-tst fixture as the §20 gate + EXPORT-1's blta-renewal.test.mjs — zero network.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkBindingsDue, buildSignedCheckpoint, RECHECK_INTERVAL_MS } from '../workflows/renewal-watch-logic.mjs';
import { verify, didKeyToPublicKey } from '../kernels/_proof.mjs';
import { DEFAULT_RENEWAL_HORIZON_MS } from '../_blta.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = JSON.parse(readFileSync(join(HERE, 'fixtures', 'anchor-binding.fixture.json'), 'utf8'));
const artifact = FIX.artifact;

let fail = 0;
const ok = (c, m) => { if (!c) { fail++; console.error('  ✗ ' + m); } else console.log('  ✓ ' + m); };

console.log('GAP-a RenewalWatchWorkflow — pure step logic + checkpoint signing\n');

// gen_time = 20260702220049Z -> 2026-07-02T22:00:49Z (same fixture as blta-renewal.test.mjs)
const GEN_MS = Date.UTC(2026, 6, 2, 22, 0, 49);

// ── §A.2: one receipted check = checkBindingsDue, deterministic over (artifact, nowMs) ──────────
{
  const notDue = checkBindingsDue(artifact, GEN_MS + 24 * 60 * 60 * 1000);
  ok(notDue.due.length === 1, 'reports exactly one rfc3161-tst binding for this fixture');
  ok(notDue.due[0].due === false, 'not due 1 day after gen_time');
  ok(notDue.verified.find((r) => r.type === 'rfc3161-tst')?.verified === true, 'the binding independently re-verifies (same §20 predicate)');

  const isDue = checkBindingsDue(artifact, GEN_MS + DEFAULT_RENEWAL_HORIZON_MS + 1000);
  ok(isDue.due[0].due === true, 'due past the horizon');

  const again = checkBindingsDue(artifact, GEN_MS + 24 * 60 * 60 * 1000);
  ok(JSON.stringify(again) === JSON.stringify(notDue), 'same (artifact, nowMs) -> byte-identical result (safe for step.do to retry)');
}

// ── §A.3: checkpoint-before-sleep produces a verifiable signed artifact ──────────────────────────
{
  const nowMs = GEN_MS + 24 * 60 * 60 * 1000;
  const checkResult = checkBindingsDue(artifact, nowMs);
  const { signed, verificationMethod } = await buildSignedCheckpoint(checkResult, artifact, nowMs);

  ok(signed.gap_a_checkpoint === 'renewal-watch/v1', 'checkpoint carries its schema tag');
  ok(signed.artifact_ref === artifact.execution_hash, 'checkpoint references the artifact by execution_hash (never re-signs the artifact itself)');
  ok(signed.next_check_not_before === new Date(nowMs + RECHECK_INTERVAL_MS).toISOString(), 'next_check_not_before = nowMs + RECHECK_INTERVAL_MS');
  ok(!!signed.audit_signature?.proof, 'checkpoint carries a §16-shaped audit_signature.proof');
  ok(verificationMethod.startsWith('did:key:z'), 'signer identified by an ephemeral did:key (same pattern as the shipped §16 VC flow)');

  const publicKey = await didKeyToPublicKey(verificationMethod);
  const verified = await verify(signed, publicKey);
  ok(verified === true, 'the checkpoint proof verifies via the SAME eddsa-jcs-2022 verifier the receipt layer uses');

  const tampered = { ...signed, next_check_not_before: new Date(0).toISOString() };
  const tamperedVerified = await verify(tampered, publicKey);
  ok(tamperedVerified === false, 'tampering with the checkpoint document invalidates its signature');
}

console.log(fail ? `\n✗ ${fail} FAILED` : '\n✓ all GAP-a RenewalWatchWorkflow assertions passed');
process.exit(fail ? 1 : 0);
