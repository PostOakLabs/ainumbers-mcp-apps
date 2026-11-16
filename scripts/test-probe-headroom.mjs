// test-probe-headroom.mjs — HEADROOM-MCP-1 acceptance + H5 controls for probe_headroom's core
// (headroom-probe.mjs) against the REAL vendored declarations (data/mcp/headroom-declarations.json)
// and the REAL bundled kernels (kernels/index.mjs). No network, no worker runtime needed: the core
// is a pure async function of {tool_id, policy_parameters, pointers, declarations, getKernel}.
//
// Proven here:
//   H5 RED    — a probe pointer declared private under SPEC §25 private_inputs is refused with a
//               structured { status:'refused', code:'private-input' } entry and is NEVER evaluated
//               (proved with a counting compute: the refused probe moves the counter zero steps).
//   H5 GREEN  — the identical declaration without the private_inputs entry runs to a flip.
//   ACCEPTANCE (art-816 spend gate) — largest additional spend before deny: '+' flip at distance
//               "500" (authorization value 1000 -> 1001), both witness hashes recomputable by
//               rebuilding each witness input from the base inputs + one grid step and re-deriving
//               policyParametersHash/executionHash through kernels/_hash.mjs alone.
//   SANITY (art-218 QM points-and-fees) — fees '+' flip at distance "1500.00" (13500.00 -> 13500.01,
//               declared-monotone), loan '-' flip at "50000" (400000 -> 399999, bracketed).
//   Step-0 timing — wall time of the art-218 search (~114 evaluations) printed; the worker scan cap
//               (500) stays unless this degrades on the deployed isolate.
import { readFileSync } from 'node:fs';
import { probeHeadroomCore, HEADROOM_SCAN_CAP_WORKER } from '../headroom-probe.mjs';
import { getKernel } from '../kernels/index.mjs';
import { policyParametersHash, executionHash } from '../kernels/_hash.mjs';
import { probeValue, getPointer, setPointer, runClass } from '../kernels/_headroom.mjs';

const decls = JSON.parse(
  readFileSync(new URL('../data/mcp/headroom-declarations.json', import.meta.url), 'utf8'),
).declarations;

let fails = 0;
const fail = (m) => { console.error('FAIL: ' + m); fails++; };
const ok = (cond, m) => { if (!cond) fail(m); };
const clone = (o) => JSON.parse(JSON.stringify(o));

// Base inputs = the estate's base fixtures (art-816 HAPPY_full_policy_spend; art-218 qm_pass_large_loan).
const PP816 = {
  authorization: {
    variant: 'transfer',
    from: '0x1111111111111111111111111111111111111111',
    to: '0x2222222222222222222222222222222222222222',
    value: '500',
    validAfter: '1700000000',
    validBefore: '1700003600',
    nonce: '0x' + 'ab'.repeat(32), // exact 32-byte EIP-3009 nonce; the kernel byte-length-checks it
  },
  domain: {
    name: 'USD Coin',
    version: '2',
    chain_id: '84532',
    verifying_contract: '0x31c8eacbff8e47cfbefd98d63ab04cbaff51c9cc',
  },
  policy: {
    agent_address: '0x1111111111111111111111111111111111111111',
    allowed_chain_ids: ['84532'],
    allowed_tokens: ['0x31c8eacbff8e47cfbefd98d63ab04cbaff51c9cc'],
    payee_allowlist: ['0x2222222222222222222222222222222222222222'],
    payee_denylist: ['0x4444444444444444444444444444444444444444'],
    per_tx_cap: '1000',
    window_caps: [{ window_seconds: 3600, cap: '2000' }],
    velocity: [{ window_seconds: 600, max_count: 3 }],
    max_validity_seconds: 7200,
    max_future_start_seconds: 300,
    duplicate_window_seconds: 1800,
    require_receive_for: [],
  },
  ledger: [],
  now_unix: 1700000100,
};
const PP218 = { loan_amount: 450000, points_and_fees: 12000, year: 2026 };

const ART816 = 'art-816-eip3009-agent-spend-gate';
const ART218 = 'art-218-qm-points-and-fees';

ok(Array.isArray(decls[ART816]?.probes) && decls[ART816].probes.length > 0, 'vendored declarations missing ' + ART816 + ' probes');
ok(Array.isArray(decls[ART218]?.probes) && decls[ART218].probes.length > 0, 'vendored declarations missing ' + ART218 + ' probes');

// ---- witness recompute: rebuild each witness input from base + one grid step, re-derive hashes ----
async function witnessRecomputes(toolId, pp, e) {
  const probe = decls[toolId].probes.find((p) => p.pointer === e.pointer);
  const baseValue = getPointer(pp, probe.pointer);
  const sign = e.direction === '+' ? 1 : -1;
  ok(e.hi - e.lo === 1, toolId + ' ' + e.pointer + ' ' + e.direction + ': witness pair not one grid step apart (' + e.lo + ', ' + e.hi + ')');
  for (const [slotName, n] of [['last_same', e.lo], ['first_other', e.hi]]) {
    const slot = e.witness[slotName];
    const typed = probeValue(probe, baseValue, sign * n);
    // the library publishes the witness value as gridValue's text ("13500.00"); typed like the base
    // value it must equal probeValue's re-typing (number base -> numeric compare)
    const same = typeof baseValue === 'string' ? String(slot.value) === String(typed) : Number(slot.value) === Number(typed);
    if (!same) fail(toolId + ' ' + e.pointer + ' ' + e.direction + ' witness ' + slotName + ': value ' + slot.value + ' is not grid step ' + n + ' of ' + baseValue + ' (recomputed ' + typed + ')');
    const q = clone(pp);
    setPointer(q, probe.pointer, typed);
    const pph = await policyParametersHash(q);
    if (pph !== slot.policy_parameters_hash) fail(toolId + ' ' + e.pointer + ' ' + e.direction + ' witness ' + slotName + ': policy_parameters_hash does not recompute from the witness input');
    const r = await runClass(getKernel(toolId).compute, q, (payload) => 'unclassified');
    if (!r.payload) fail(toolId + ' witness ' + slotName + ': kernel threw on the witness input (' + r.thrown + ')');
    else {
      const eh = await executionHash(q, r.payload);
      if (eh !== slot.execution_hash) fail(toolId + ' ' + e.pointer + ' ' + e.direction + ' witness ' + slotName + ': execution_hash does not recompute from the witness input');
    }
  }
}

const entry = (report, pointer, dir) => report.entries.find((x) => x.pointer === pointer && x.direction === dir);

// ---- H5 RED control: a §25-declared private pointer is refused, never evaluated ----
{
  let evalCount = 0;
  const realCompute = getKernel(ART816).compute;
  const countingKernel = { compute: async (pp) => { evalCount++; return realCompute(pp); } };
  const redDecl = { ...clone(decls[ART816]), private_inputs: ['/authorization'] };
  const before = evalCount;
  const red = await probeHeadroomCore({
    tool_id: ART816, policy_parameters: PP816, pointers: ['/authorization/value'],
    declarations: { [ART816]: redDecl }, getKernel: () => countingKernel,
  });
  const e = red.entries[0];
  ok(e && e.status === 'refused', 'H5 red: expected a refused entry, got ' + JSON.stringify(e));
  ok(e && e.code === 'private-input', 'H5 red: refusal code is not private-input: ' + (e && e.code));
  ok(e && typeof e.detail === 'string' && e.detail.includes('/authorization/value'), 'H5 red: refusal detail does not name the refused pointer');
  ok(red.evaluations === 0, 'H5 red: report counts evaluations for a refused probe (' + red.evaluations + ')');
  // exactly ONE compute call beyond `before` is legitimate: the report's own base run. A refused
  // probe must add ZERO probe-side evaluations - any more is the leak probe_headroom exists to refuse.
  ok(evalCount === before + 1, 'H5 red: compute ran ' + (evalCount - before) + ' times; expected exactly 1 (the base run only) - the refused probe WAS evaluated');
}

// ---- H5 GREEN control: the same declaration without private_inputs runs to a flip ----
{
  let evalCount = 0;
  const realCompute = getKernel(ART816).compute;
  const countingKernel = { compute: async (pp) => { evalCount++; return realCompute(pp); } };
  const greenDecl = { ...clone(decls[ART816]), private_inputs: [] };
  const before = evalCount;
  const green = await probeHeadroomCore({
    tool_id: ART816, policy_parameters: PP816, pointers: ['/authorization/value'],
    declarations: { [ART816]: greenDecl }, getKernel: () => countingKernel,
  });
  const e = entry(green, '/authorization/value', '+');
  ok(e && e.status === 'flip', 'H5 green: expected a flip entry, got ' + (e && e.status));
  ok(evalCount > before, 'H5 green: probe did not evaluate the kernel');
}

// ---- ACCEPTANCE: art-816 spend gate — largest additional spend before deny ----
{
  const t0 = Date.now();
  const rep = await probeHeadroomCore({ tool_id: ART816, policy_parameters: PP816, declarations: decls, getKernel });
  ok(rep.profile === 'ocg-headroom-report@1', 'art-816: wrong report profile ' + rep.profile);
  ok(rep.base.verdict === 'SPEND' && rep.base.class === 'positive', 'art-816: base is not SPEND/positive: ' + rep.base.verdict + '/' + rep.base.class);
  ok(typeof rep.base.execution_hash === 'string' && rep.base.execution_hash.length > 0, 'art-816: base execution_hash missing');
  const up = entry(rep, '/authorization/value', '+');
  ok(up && up.status === 'flip', 'art-816: expected a + flip on /authorization/value, got ' + (up && up.status));
  if (up && up.status === 'flip') {
    ok(up.distance === '500', 'art-816: largest additional spend before deny is ' + up.distance + ', expected "500" (per_tx cap 1000 on base 500)');
    ok(up.steps_to_flip === 500, 'art-816: steps_to_flip ' + up.steps_to_flip + ', expected 500');
    ok(up.witness.last_same.value === '1000' && up.witness.first_other.value === '1001', 'art-816: witness pair ' + up.witness.last_same.value + ' -> ' + up.witness.first_other.value + ', expected "1000" -> "1001"');
    ok(up.witness.last_same.verdict === 'SPEND' && up.witness.first_other.verdict === 'OVER_LIMIT', 'art-816: witness verdicts ' + up.witness.last_same.verdict + ' -> ' + up.witness.first_other.verdict + ', expected SPEND -> OVER_LIMIT');
    await witnessRecomputes(ART816, PP816, up);
  }
  const down = entry(rep, '/authorization/value', '-');
  ok(down && down.status === 'no_flip_within_range', 'art-816: - direction should find no flip within range, got ' + (down && down.status));
  ok(rep.evaluations > 0, 'art-816: report counts zero evaluations');
  console.log('art-816 probe: ' + rep.evaluations + ' evals in ' + (Date.now() - t0) + ' ms (worker scan cap ' + HEADROOM_SCAN_CAP_WORKER + ')');
}

// ---- SANITY: art-218 QM points-and-fees + step-0 timing of the ~114-evaluation search ----
{
  const t0 = Date.now();
  const rep = await probeHeadroomCore({ tool_id: ART218, policy_parameters: PP218, declarations: decls, getKernel });
  const ms = Date.now() - t0;
  ok(rep.base.class === 'positive', 'art-218: base class is not positive: ' + rep.base.class);
  const feesUp = entry(rep, '/points_and_fees', '+');
  ok(feesUp && feesUp.status === 'flip', 'art-218: expected a + flip on /points_and_fees, got ' + (feesUp && feesUp.status));
  if (feesUp && feesUp.status === 'flip') {
    ok(feesUp.distance === '1500.00', 'art-218: fees headroom ' + feesUp.distance + ', expected "1500.00" (limit 13500 on base 12000, step 0.01)');
    ok(feesUp.steps_to_flip === 150000, 'art-218: fees steps_to_flip ' + feesUp.steps_to_flip + ', expected 150000');
    ok(feesUp.basis === 'declared-monotone', 'art-218: fees basis ' + feesUp.basis + ', expected declared-monotone');
    ok(feesUp.witness.last_same.value === '13500.00' && feesUp.witness.first_other.value === '13500.01', 'art-218: fees witness ' + feesUp.witness.last_same.value + ' -> ' + feesUp.witness.first_other.value + ', expected "13500.00" -> "13500.01"');
    await witnessRecomputes(ART218, PP218, feesUp);
  }
  const feesDown = entry(rep, '/points_and_fees', '-');
  ok(feesDown && feesDown.status === 'no_flip_within_range', 'art-218: fees - should not flip within range, got ' + (feesDown && feesDown.status));
  const loanDown = entry(rep, '/loan_amount', '-');
  ok(loanDown && loanDown.status === 'flip', 'art-218: expected a - flip on /loan_amount, got ' + (loanDown && loanDown.status));
  if (loanDown && loanDown.status === 'flip') {
    ok(loanDown.distance === '50000', 'art-218: loan - distance ' + loanDown.distance + ', expected "50000"');
    ok(loanDown.basis === 'bracketed', 'art-218: loan - basis ' + loanDown.basis + ', expected bracketed');
    ok(loanDown.witness.last_same.value === '400000' && loanDown.witness.first_other.value === '399999', 'art-218: loan witness ' + loanDown.witness.last_same.value + ' -> ' + loanDown.witness.first_other.value + ', expected "400000" -> "399999"');
    await witnessRecomputes(ART218, PP218, loanDown);
  }
  const loanUp = entry(rep, '/loan_amount', '+');
  ok(loanUp && loanUp.status === 'no_flip_within_range', 'art-218: loan + should not flip within range, got ' + (loanUp && loanUp.status));
  ok(rep.evaluations >= 100, 'art-218: suspiciously few evaluations (' + rep.evaluations + '); the declared-grid search should bracket past 100 here');
  ok(ms < 5000, 'art-218 search took ' + ms + ' ms - does not fit one worker request; LOWER HEADROOM_SCAN_CAP_WORKER');
  console.log('art-218 probe: ' + rep.evaluations + ' evals in ' + ms + ' ms (worker scan cap ' + HEADROOM_SCAN_CAP_WORKER + ')');
}

// ---- skips are structured, never throws ----
{
  const noDecl = await probeHeadroomCore({ tool_id: 'no-such-node', policy_parameters: {}, declarations: decls, getKernel });
  ok(noDecl.skipped && noDecl.skipped.includes('no headroom declaration'), 'unknown tool_id: expected the no-declaration skip, got ' + JSON.stringify(noDecl.skipped));
  const noKernel = await probeHeadroomCore({ tool_id: ART816, policy_parameters: PP816, declarations: decls, getKernel: () => null });
  ok(noKernel.skipped && noKernel.skipped.includes('no vendored compute kernel'), 'missing kernel: expected the no-kernel skip, got ' + JSON.stringify(noKernel.skipped));
  const noProbe = await probeHeadroomCore({ tool_id: ART816, policy_parameters: PP816, pointers: ['/not/declared'], declarations: decls, getKernel });
  ok(noProbe.entries.some((x) => x.pointer === '/not/declared' && x.status === 'skipped'), 'undeclared pointer: expected a skipped entry, got ' + JSON.stringify(noProbe.entries));
}

if (fails) { console.error('✗ test-probe-headroom FAILED (' + fails + ')'); process.exit(1); }
console.log('✓ probe_headroom: H5 refusal (never evaluated) + green control, art-816 distance 500 with recomputable witness hashes, art-218 declared-grid sanity, structured skips');
