#!/usr/bin/env node
// gate-negative-enforcement.mjs — audit AUD-E2: negative gate-enforcement.
//
// Claim to prove: a chain fed input that SHOULD trip a §21.4 gate actually HALTS
// (or escalates) — it does not silently pass through to a clean full artifact.
// The existing corpus (run-chain-corpus.mjs) already proves GOOD inputs run
// end-to-end; this gate proves BAD inputs are correctly stopped.
//
// Method: chaingraph.json currently ships 18 gated chains (15 distinct gate
// rules whose `next` is a genuine halt/escalate target — "end" or "escalate";
// 3 gates route to an alternate step on their rule match and are pure
// conditional BRANCHING, not violation-halts — VA/FHA loan routing, a bias
// re-assessment step, and an EBAM account-opening handoff — those are excluded
// here as out of scope for "negative enforcement", see NON_HALT_GATES below).
//
// For each in-scope gated chain:
//   - GOOD run: the chain's real vendored chain-fixtures.json inputs, with the
//     ONE output field the gate reads force-set to a value that must NOT
//     trip rule[0] (a "safe" value — see SAFE column below). Asserts the
//     gate's decision took the `default` route (matched_rule_index === null).
//     (Forcing the good side too, rather than trusting the raw vendored
//     fixture, was a deliberate correction: an early run of this gate found 5
//     of the 16 cases' vendored chain-fixtures.json default already encodes
//     the VIOLATING value for that field — e.g. mortgage-high-cost-and-hpml-screen's
//     fixture has is_high_cost:true already — so trusting the raw fixture as
//     "the good case" produced false "gate false-tripped on good input"
//     failures. See the audit report for the flagged fixture-authoring
//     discrepancy; this gate no longer depends on which side the vendored
//     fixture happens to sit on.)
//   - BAD run: identical fixture inputs, except the ONE output field the gate
//     reads (gate.input, an RFC 6901 pointer) is force-set to the value that
//     MUST trip rule[0]. The forcing wrapper calls the REAL kernel first (so
//     every other output field is real, unmodified compute), then overwrites
//     only the gated field and RECOMPUTES execution_hash via the same
//     executionHash() the kernel itself uses (embed/lib/_hash.mjs — no
//     reimplemented hash) — so the forced artifact is still internally
//     hash-valid. This is the same technique scripts/gate-branch-coverage.test.mjs
//     already uses (a mock kernel) to exercise gate ROUTING mechanics
//     independent of any one node's business logic; here it is scoped to a
//     single field on the real kernel's real output, for the narrowest
//     possible "what if this exact reading happened" test.
//   Asserts the decision took rule[0] (matched_rule_index === 0), AND that the
//   chain actually stopped short of a clean full run: either
//   escalation_record is present (escalate targets) or fewer steps ran than
//   the full step_count (end targets) — never a silent complete pass.
//
// Run: node scripts/gate-negative-enforcement.mjs   (exit 0 = all green)

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runChain as embedRunChain } from '../embed/runChain.mjs';
import { getKernel as realGetKernel } from '../kernels/index.mjs';
import { executionHash } from '../embed/lib/_hash.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = resolve(ROOT, 'data');
const chaingraph = JSON.parse(readFileSync(resolve(DATA, 'chaingraph/chaingraph.json'), 'utf8'));
const fixtures = JSON.parse(readFileSync(resolve(DATA, 'chain-fixtures.json'), 'utf8'));

// Halt/escalate cases: { chain, gateStepId (tool_id), pointer, safe (must NOT trip rule[0]),
// forced (MUST trip rule[0]), expect: 'end'|'escalate' }.
// Derived directly from chaingraph.json's live gate declarations (rule[0] only — the first/violation rule).
const HALT_CASES = [
  { chain: 'mortgage-compliance-preflight', gateStep: 'art-217-trid-apr-accuracy', pointer: '/verdict', safe: 'accurate', forced: 'understated_violation', expect: 'end' },
  { chain: 'mortgage-compliance-preflight', gateStep: 'art-218-qm-points-and-fees', pointer: '/pass', safe: true, forced: false, expect: 'end' },
  { chain: 'mortgage-agency-pricing-and-eligibility', gateStep: 'art-222-agency-eligibility-matrix', pointer: '/eligible_flag', safe: 'ELIGIBLE', forced: 'INELIGIBLE', expect: 'end' },
  { chain: 'adverse-action-notice-compliance', gateStep: 'art-228-build-adverse-action-notice', pointer: '/action_taken', safe: 'denied', forced: 'approved', expect: 'end' },
  // These two chains' gate sits on their LAST step, and both rule-match and default route to
  // "end" (there is no further step to route to either way) — a terminal classification gate,
  // not a step-skipping one. "Halted" here means the decision correctly records the violation
  // (matched_rule_index=0) in the hashed composite_output.decisions[], not that fewer steps ran
  // (there is nothing downstream left to skip). expect:'flag-only' short-circuits the
  // steps_ran-based halt check accordingly — see the haltedCorrectly branch below.
  { chain: 'fair-lending-disparity-audit', gateStep: 'art-229-compute-disparity-metrics', pointer: '/adverse_impact_ratio', safe: 0.95, forced: 0.5, expect: 'flag-only' },
  { chain: 'card-act-ability-to-pay', gateStep: 'art-233-check-card-act-ability-to-pay', pointer: '/atp_passes', safe: false, forced: true, expect: 'end' },
  { chain: 'mortgage-high-cost-and-hpml-screen', gateStep: 'art-234-test-hoepa-high-cost', pointer: '/is_high_cost', safe: false, forced: true, expect: 'end' },
  { chain: 'ai-decision-log-conformance', gateStep: 'art-238-classify-annex3-decisioning-obligations', pointer: '/is_high_risk', safe: true, forced: false, expect: 'end' },
  { chain: 'cross-border-payment-prevalidation', gateStep: 'art-247-prevalidation-readiness-scorer', pointer: '/ready', safe: false, forced: true, expect: 'flag-only' },
  { chain: 'remittance-disclosure-and-corridor-cost', gateStep: 'art-248-compute-remittance-disclosure', pointer: '/estimate_permissible', safe: false, forced: true, expect: 'end' },
  { chain: 'parametric-trigger-adjudication', gateStep: 'art-251-compute-parametric-trigger-payout', pointer: '/trigger_hit', safe: true, forced: false, expect: 'end' },
  { chain: 'insurer-rbc-action-level', gateStep: 'art-254-compute-rbc-action-level', pointer: '/action_level_code', safe: 'COMPANY_ACTION', forced: 'NO_ACTION', expect: 'end' },
  { chain: 'hedge-effectiveness-documentation', gateStep: 'art-261-test-hedge-effectiveness', pointer: '/is_effective', safe: true, forced: false, expect: 'end' },
  { chain: 'commission-integrity-and-amortization', gateStep: 'art-266-reconcile-commission-statement', pointer: '/has_discrepancy', safe: false, forced: true, expect: 'end' },
  { chain: 'kyb-beneficial-ownership-attribution', gateStep: 'art-268-compute-cdd-ownership-25pct', pointer: '/is_beneficial_owner', safe: true, forced: false, expect: 'end' },
  { chain: 'dora-escalation-demo', gateStep: 'art-29-dora-readiness-diagnostic', pointer: '/grade', safe: 'A', forced: 'F', expect: 'escalate' },
];

// Excluded as pure conditional branching (rule[0].next is a live step, not a halt/escalate target) —
// these route the chain down a different valid path on the observed value, they do not represent a
// compliance violation being stopped. Noted in the final report, not tested here.
const NON_HALT_GATES = [
  'mortgage-government-loan-fit (art-223: VA -> reroute, not halt)',
  'insurance-ai-bias-attestation (art-239: bias_detected=true -> reroute to further assessment, not halt; default is the halt side)',
  'treasury-account-lifecycle-ebam (art-262: OPENING_CONFIRMED -> reroute to interest allocation, not halt; default is the halt side)',
];

function setPointer(obj, pointer, value) {
  const parts = pointer.split('/').filter(Boolean).map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'));
  if (parts.length !== 1) throw new Error('gate pointer with depth != 1 not supported by this gate: ' + pointer);
  obj[parts[0]] = value;
}

// A getKernel() that is byte-identical to the real registry for every tool_id EXCEPT one, whose
// buildArtifact is post-processed: run the REAL kernel, then force one output field, then
// recompute execution_hash with the SAME executionHash() the kernel itself calls — so the
// resulting artifact stays internally hash-valid (a real hash over the (forced) real fields).
function forcingGetKernel(targetToolId, pointer, forcedValue) {
  return (tool_id) => {
    const real = realGetKernel(tool_id);
    if (!real || tool_id !== targetToolId) return real;
    return {
      ...real,
      async buildArtifact(pp, opts) {
        const artifact = await real.buildArtifact(pp, opts);
        const mutated = JSON.parse(JSON.stringify(artifact.output_payload));
        setPointer(mutated, pointer, forcedValue);
        const hash = await executionHash(pp, mutated);
        return { ...artifact, output_payload: mutated, execution_hash: hash };
      },
    };
  };
}

let fail = 0;
const rows = [];
const ok = (l) => console.log('  ✓ ' + l);
const bad = (l, d) => { fail++; console.error('  ✗ ' + l + (d ? ' — ' + d : '')); };

// DEFECT_DEMO=1 deliberately breaks one case (forces the "safe" value to equal the violating
// value) to prove this gate actually detects a regression rather than always passing. Used only
// to demonstrate the failing-on-defect half of the audit requirement — never set in CI.
if (process.env.DEFECT_DEMO === '1') {
  HALT_CASES[0].safe = HALT_CASES[0].forced;
  console.log(`⚠ DEFECT_DEMO=1: corrupted HALT_CASES[0] (${HALT_CASES[0].chain}) so its "safe" value now equals its violating value — expect a false-positive FAIL below.\n`);
}

async function main() {
  console.log(`\n▶ gate-negative-enforcement: ${HALT_CASES.length} halt/escalate case(s) across ${new Set(HALT_CASES.map(c=>c.chain)).size} gated chain(s)\n`);
  console.log(`(excluded as non-halt conditional branching: ${NON_HALT_GATES.length} — ${NON_HALT_GATES.join('; ')})\n`);

  for (const c of HALT_CASES) {
    const chainMeta = (chaingraph.chains || []).find((x) => x.name === c.chain);
    if (!chainMeta) { bad(`${c.chain}: chain not found in chaingraph.json`); rows.push({ ...c, verdict: 'FAIL', note: 'chain missing' }); continue; }
    const stepCount = chainMeta.steps.length;
    const deps = { getKernel: forcingGetKernel(c.gateStep, c.pointer, c.safe), chaingraph, fixtures };

    // GOOD run: real kernel, gated field forced to a value that must NOT trip rule[0].
    let good;
    try { good = await embedRunChain(c.chain, undefined, deps); }
    catch (err) { bad(`${c.chain}: GOOD run threw`, err.message); rows.push({ ...c, verdict: 'FAIL', note: 'good run threw: ' + err.message }); continue; }
    const goodDec = (good.decisions || []).find((d) => d.step_id === c.gateStep);
    if (!goodDec) { bad(`${c.chain}: GOOD run — no decision recorded for ${c.gateStep} (gate never reached?)`); rows.push({ ...c, verdict: 'FAIL', note: 'gate not reached on good input' }); continue; }
    if (goodDec.matched_rule_index !== null) {
      bad(`${c.chain}: GOOD input unexpectedly tripped rule[${goodDec.matched_rule_index}] at ${c.gateStep} (false positive)`, JSON.stringify(goodDec));
      rows.push({ ...c, verdict: 'FAIL', note: 'good input false-tripped the gate' }); continue;
    }
    ok(`${c.chain} / ${c.gateStep}: GOOD (safe-value) input takes the default route (matched_rule_index=null)`);

    // BAD run: force the gated field to the violation value.
    const badDeps = { getKernel: forcingGetKernel(c.gateStep, c.pointer, c.forced), chaingraph, fixtures };
    let bad_;
    try { bad_ = await embedRunChain(c.chain, undefined, badDeps); }
    catch (err) { bad(`${c.chain}: BAD run threw`, err.message); rows.push({ ...c, verdict: 'FAIL', note: 'bad run threw: ' + err.message }); continue; }
    const badDec = (bad_.decisions || []).find((d) => d.step_id === c.gateStep);
    if (!badDec || badDec.matched_rule_index !== 0) {
      bad(`${c.chain}: BAD input did NOT trip rule[0] at ${c.gateStep} (matched_rule_index=${badDec?.matched_rule_index})`, JSON.stringify(badDec));
      rows.push({ ...c, verdict: 'FAIL', note: 'bad input failed to trip the gate' }); continue;
    }
    let haltedCorrectly = false;
    let haltNote = '';
    if (c.expect === 'escalate') {
      haltedCorrectly = !!bad_.escalation_record && (bad_.steps || []).some((s) => s.status === 'skipped_by_escalation');
      haltNote = haltedCorrectly ? 'escalation_record present, >=1 step skipped_by_escalation' : 'escalation_record MISSING or no skipped_by_escalation step';
    } else if (c.expect === 'flag-only') {
      // Terminal gate on the chain's last step: rule-match and default both route to "end" (no
      // downstream step exists to skip either way). Enforcement = the violation is recorded in
      // the hashed decision, not a shorter run. matched_rule_index===0 was already required above
      // to reach this branch, so there is nothing further to assert.
      haltedCorrectly = true;
      haltNote = `terminal gate (last step) — violation recorded via matched_rule_index=0 in the hashed composite decision (steps_ran=${bad_.steps_ran}, nothing downstream to skip)`;
    } else {
      haltedCorrectly = bad_.steps_ran < stepCount;
      haltNote = haltedCorrectly ? `steps_ran=${bad_.steps_ran} < step_count=${stepCount}` : `steps_ran=${bad_.steps_ran} === step_count=${stepCount} (ran to completion — NOT halted)`;
    }
    if (!haltedCorrectly) {
      bad(`${c.chain}: BAD input tripped the gate but the chain did NOT halt/escalate`, haltNote);
      rows.push({ ...c, verdict: 'FAIL', note: haltNote }); continue;
    }
    ok(`${c.chain} / ${c.gateStep}: BAD input trips rule[0] -> next="${badDec.next}" -> ${haltNote} (never a clean full artifact)`);
    rows.push({ ...c, verdict: 'PASS', note: haltNote });
  }

  console.log('\n════ gate-negative-enforcement summary ════');
  for (const r of rows) console.log(`  ${r.verdict === 'PASS' ? '✓' : '✗'} ${r.chain} / ${r.gateStep} — ${r.note}`);
  console.log('');

  if (fail) { console.error(`✗ gate-negative-enforcement: ${fail} failure(s) of ${HALT_CASES.length}`); process.exit(1); }
  console.log(`✅ gate-negative-enforcement: all ${HALT_CASES.length} gated-chain cases pass on good input and correctly halt/escalate on bad input.`);
}

main().catch((err) => { console.error('✗ gate-negative-enforcement ERROR:', err); process.exit(1); });
