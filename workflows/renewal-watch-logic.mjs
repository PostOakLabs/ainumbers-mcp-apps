// renewal-watch-logic.mjs — GAP-a §A.2/§A.3 pure logic, split out of renewal-watch-workflow.mjs so
// it can be unit-tested under plain Node (`cloudflare:workers`, imported only by the Workflow class
// file, is a Workers-runtime-only virtual module and cannot load under `node scripts/*.test.mjs`).
// See renewal-watch-workflow.mjs for the full design rationale (§A.2 receipted-step mapping, §A.3
// checkpoint-before-sleep rule).

import { dueForRenewal, verifyAllBindings, DEFAULT_RENEWAL_HORIZON_MS } from '../_blta.mjs';
import { sign, rawPubkeyToDidKey } from '../kernels/_proof.mjs';

// Re-check cadence once a binding is confirmed NOT yet due. Deliberately > 3 days so this
// Workflow actually exercises the §A.3 checkpoint-before-sleep rule rather than a same-instance
// sleep short enough that free-plan state retention would never matter.
export const RECHECK_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// One receipted check: re-verify every rfc3161-tst binding + compute its due status.
// nowMs is caller-supplied (matches _blta.mjs's "never sampled inside the module" contract) —
// callers pass Date.now() from inside the step.do body, not from module scope.
export function checkBindingsDue(artifact, nowMs, horizonMs = DEFAULT_RENEWAL_HORIZON_MS) {
  const verified = verifyAllBindings(artifact);
  const due = (artifact.anchor_bindings || [])
    .filter((b) => b?.type === 'rfc3161-tst')
    .map((b, index) => ({ index, gen_time: b.gen_time, due: dueForRenewal(b, { nowMs, horizonMs }) }));
  return { verified, due, checked_at: new Date(nowMs).toISOString() };
}

// Build the signed §A.3 checkpoint: a fresh ephemeral did:key signs a small resumption document
// (never the artifact itself — the artifact's execution_hash is referenced, not re-signed) via the
// same eddsa-jcs-2022 pipeline kernels/_proof.mjs uses for §16 proofs.
export async function buildSignedCheckpoint(checkResult, artifact, nowMs, recheckIntervalMs = RECHECK_INTERVAL_MS) {
  const keyPair = await globalThis.crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const verificationMethod = await rawPubkeyToDidKey(keyPair.publicKey);
  const created = new Date(nowMs).toISOString();
  const doc = {
    gap_a_checkpoint: 'renewal-watch/v1',
    artifact_ref: artifact.execution_hash ?? null,
    last_checked_result: checkResult,
    next_check_not_before: new Date(nowMs + recheckIntervalMs).toISOString(),
    // Pre-declare audit_signature (empty) BEFORE signing: sign()/verify() strip-then-restore this
    // key via securedDocument(), so it must already exist pre-signing or the stripped/re-hashed
    // "secured document" shape drifts from the pre-signature original and verification fails.
    // Matches how a real OCG artifact already carries this top-level field before it is signed.
    audit_signature: {},
  };
  const signed = await sign(doc, { verificationMethod, created, privateKey: keyPair.privateKey });
  return { signed, verificationMethod };
}
