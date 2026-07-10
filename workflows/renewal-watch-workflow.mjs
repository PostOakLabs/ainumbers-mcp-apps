// renewal-watch-workflow.mjs — GAP-a §A.2/§A.3/§A.4: the first durable CF Workflows process.
//
// Picks the B-LTA renewal-timer candidate named in GAP-A-DESIGN-DOC.md §A.4 (the reserve-attestation
// re-verify loop is the other candidate; this one was already half-wired — worker.mjs's queue()
// consumer for `co.ainumbers.anchor.renewal_check` events has, since EXPORT-1 (#66), carried the
// comment "a future producer (e.g. a GAP-a workflow step) enqueues the event" — this WU is that
// producer's durable counterpart).
//
// §A.2 mapping: ONE step.do = ONE receipted check. `checkBindingsDue` (renewal-watch-logic.mjs)
// re-verifies every §20 rfc3161-tst binding on the artifact via the SAME predicate the §20 gate
// uses (_blta.mjs verifyAllBindings/dueForRenewal — no second implementation) and is deterministic
// over its inputs (artifact, nowMs), so a `step.do` retry re-derives a byte-identical result — no
// double-effect.
//
// §A.3 checkpoint rule: this process's natural cadence (renewal horizon = 5 YEARS, see
// _blta.mjs DEFAULT_RENEWAL_HORIZON_MS) is nowhere close to a single Workflows sleep window, so
// before any `step.sleep` that could outlive the free-plan 3-day state-retention window, the
// resumption state is written as a SIGNED checkpoint (eddsa-jcs-2022 via kernels/_proof.mjs — the
// SAME signer the receipt layer uses, ephemeral did:key per run, same pattern as the shipped §16
// VC flow) rather than trusted to Workflows-internal memory. If Workflows garbage-collects this
// instance's state, the checkpoint is the durable record of "last checked / next check not before".
// Fresh timestamp tokens are never minted here — obtaining one is FLAGGED, out-of-fence (see
// _blta.mjs header); this Workflow only detects + reports due renewals for a human/anchor-suite
// follow-up, exactly like the reactive path it upgrades.
//
// SPEC.md / chaingraph.json are UNTOUCHED by this file — no new MCP tool, no tool-registry touch,
// no `/mcp` behavior change (§A.1 invariant: durability sits UNDER the receipt layer, never becomes
// the source of truth for a result).
//
// The pure step logic lives in renewal-watch-logic.mjs (no `cloudflare:workers` import there) so it
// can be unit-tested under plain Node — see scripts/renewal-watch-workflow.test.mjs.

// `cloudflare:workers` is a Workers-runtime-only virtual module (workerd/wrangler dev/deploy).
// Local CI gates and test harnesses import worker.mjs directly under PLAIN Node (see
// scripts/test-malformed-body-fastfail.mjs, scripts/test-worker.mjs) to exercise the fetch
// handler without spinning up workerd — that path has no `cloudflare:workers` to resolve. Since
// worker.mjs re-exports this class (wrangler requires the bound class to be exported from the
// entrypoint script), a static top-level import here would crash every plain-Node harness that
// merely loads worker.mjs, never touching Workflows at all. Fall back to a minimal stub base
// class in that case — it only affects module loading, never a real deploy (wrangler dry-run
// bundling + `wrangler deploy` both run under workerd, where the dynamic import resolves for real).
let WorkflowEntrypoint;
try {
  ({ WorkflowEntrypoint } = await import('cloudflare:workers'));
} catch {
  WorkflowEntrypoint = class {};
}
import { checkBindingsDue, buildSignedCheckpoint, RECHECK_INTERVAL_MS } from './renewal-watch-logic.mjs';

export class RenewalWatchWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    const artifact = event.payload?.artifact;
    if (!artifact) throw new Error('RenewalWatchWorkflow requires payload.artifact (an OCG artifact carrying §20 anchor_bindings)');

    // §A.2: one step.do = one receipted check. Deterministic over (artifact, nowMs) -> safe to retry.
    const checkResult = await step.do('verify-and-check-due', async () =>
      checkBindingsDue(artifact, Date.now())
    );

    const anyDue = checkResult.due.some((d) => d.due);
    if (anyDue) {
      // Detect + report only — minting a fresh TSA token is explicitly out-of-fence (_blta.mjs header).
      await step.do('flag-renewal-due', async () => {
        console.log('[gap-a] renewal DUE, flagging for anchor-suite follow-up:', JSON.stringify(checkResult));
        return { flagged: true };
      });
      return { status: 'renewal-due', checkResult };
    }

    // §A.3: about to sleep well past the free-plan 3-day retention window — checkpoint the
    // resumption state as a signed artifact BEFORE sleeping.
    const checkpoint = await step.do('checkpoint-before-sleep', async () =>
      buildSignedCheckpoint(checkResult, artifact, Date.now())
    );
    console.log('[gap-a] checkpoint signed:', JSON.stringify(checkpoint.signed));

    await step.sleep('wait-until-next-check', RECHECK_INTERVAL_MS);

    // On resume, a re-triggered instance treats the checkpoint (not Workflows-internal memory) as
    // its source of truth for "when was this last checked" — the checkpoint's own
    // `next_check_not_before` field is what a future caller reads, not this instance's continued
    // existence. This instance's own step.do calls above already remain memoized within the run,
    // but the checkpoint is what survives if Workflows GC's the instance at day 3.
    return { status: 'rechecked-later', checkpoint };
  }
}
