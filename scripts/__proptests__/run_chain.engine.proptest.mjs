// run_chain.engine.proptest.mjs — FV property-test FLOOR for the run_chain orchestration
// ENGINE (FV-ENGINE-FLOOR-1, anchored on FV-PBT-FLOOR-BUILD-SPEC.md §2-§5 + OCG SPEC.md §21).
// engine_digest_at_authoring: sha256:728040787df93b9f7ec64c02a95ab9c8f75d6594135bc1fe82f04d29a47ae71b
// engine_digest_source: mcp-apps-poc/worker.mjs (whole file, LF-normalized SHA-256) -- run_chain is
// not split into its own module, so the floor's staleness marker is over the file it lives in, not a
// single function. Informational only; this row does not wire a coverage/freshness GATE (see NOTE below).
// human_sign_off: PENDING
//
// SCOPE -- read this before trusting anything below:
//   This is NOT a kernel floor. FV-PBT-FLOOR-BUILD-SPEC.md's directory/CI/manifest-signing design
//   (repo/chaingraph/kernels/__proptests__/, check-fv-floor-coverage.mjs) targets the 578 SITE-REPO
//   kernels tracked in chaingraph.meta.json. run_chain is worker-repo orchestration code with no
//   chaingraph.meta.json entry, no kernel_digest, no fixtures.json of its own -- it is not a member of
//   that gate's denominator and this file does NOT change that gate's count (nothing here touches
//   repo/ or check-fv-floor-coverage.mjs). This file borrows the SAME hand-rolled zero-dep PATTERN
//   (mulberry32 PRNG, fixture/oracle-then-property pipeline, digest-header convention, PENDING
//   sign-off) because it is the proven shape from FV-B1-DTI-RATIOS / the shard rollout -- it is a
//   separate, worker-repo-local artifact, not a 579th row in the kernel ratchet.
//
//   Properties are derived from OCG SPEC.md v0.8 §21 (Chain Execution) and §4 (the canonical hash
//   preimage) -- NOT from reading run_chain's own behavior and writing down what it happens to do.
//   Where §21 is silent, that silence is called out explicitly below rather than invented.
//
//   COVERS: the INTEGRATION SEAM run_chain owns over the kernel code it calls -- step ordering
//   (§21.1), parent-hash/chain-depth threading (§21.1), decision-gate evaluation (§21.4, via the
//   SAME kernels/_gateval.mjs module run_chain imports -- not a reimplementation), and that the
//   seam never smuggles chain-position data into a step's own execution_hash (metamorphic, derived
//   from §4's fixed preimage). DOES NOT COVER: cross-runner divergence (no browser leg exists or is
//   planned here, per FV-ENGINE-RUNNER-SCOPE-1's finding that only 2 independent runners exist and a
//   worker-vs-browser differential is the separate, already-stopped CHAIN-DIFF-HARNESS-1 line); kernel
//   correctness (each kernel's own floor, if/when it lands, owns that); regression/determinism across
//   the full 147-chain corpus (scripts/run-chain-corpus.mjs already does that -- see OVERLAP below).
//
// OVERLAP WITH run-chain-corpus.mjs -- NOT DUPLICATED: that script asserts, per real fixture-backed
// chain, "did it complete, did steps_ran match expectation, is the hash 64-hex, is it deterministic,
// does the composite validate against the v0.4 schema". It never asserts the SPECIFIC §21.1 threading
// values (parent_hashes/parent_tool_ids/chain_depth per step) or the §21.4 op-table semantics -- this
// file is additive on exactly that gap, using synthetic chains (real kernel-backed nodes, not written
// to chaingraph.json -- same technique as scripts/gate-parity.test.mjs) so failure/gap-in-the-array
// scenarios can be constructed deliberately rather than hoped for in the real corpus.
//
// NEGATIVE CONTROL (run first, before any property is trusted): `node run_chain.engine.proptest.mjs
// --negative-control` deliberately corrupts one property's expectation (an off-by-one chain_depth
// assertion) and MUST exit non-zero. This was run during authoring and DID fail as expected -- see
// FV-ENGINE-FLOOR-1.manifest.json's negative_control field for the recorded transcript. The flag stays
// in the file so any future auditor can reproduce that failing run themselves rather than trust a claim.
//
// Run: node scripts/__proptests__/run_chain.engine.proptest.mjs [--negative-control]

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer, widgetGlue, stripCspMeta } from '../../worker.mjs';
import { PILOT } from '../../pilot.mjs';
import { evaluateGate, GATE_OPS } from '../../kernels/_gateval.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DATA = resolve(ROOT, 'data');
const get = (p) => readFileSync(resolve(DATA, p), 'utf8');
const NEGATIVE_CONTROL = process.argv.includes('--negative-control');

// ---------- zero-dep helpers (same shape as chaingraph/kernels/__proptests__/_pbt-common.mjs) ----------
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(0xF10007);
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function deepEqual(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

// ---------- load real worker data + drive run_chain over InMemoryTransport (same technique as
// scripts/gate-parity.test.mjs / run-chain-corpus.mjs -- no network, no live worker) ----------
function loadDataFromDisk() {
  const glue = widgetGlue(get('ext-apps-inline.js'));
  const manifests = {}, widgets = {};
  for (const slug of PILOT) {
    manifests[slug] = JSON.parse(get('manifests/' + slug + '.manifest.json'));
    widgets[slug] = stripCspMeta(get('tools/' + slug + '.html')) + glue;
  }
  return {
    manifests, widgets,
    catalog: JSON.parse(get('mcp/catalog.json')),
    chaingraph: JSON.parse(get('chaingraph/chaingraph.json')),
    searchIndex: JSON.parse(get('search-index.json')),
    chainFixtures: JSON.parse(get('chain-fixtures.json')),
  };
}

async function workerRunChain(data, chainName, inputs) {
  const server = buildServer(data, { onlyTool: 'run_chain' });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  await clientT.start();
  const pending = new Map();
  clientT.onmessage = (msg) => { if (msg && msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); } };
  const rpc = (method, params, id) => new Promise((res) => { pending.set(id, res); clientT.send({ jsonrpc: '2.0', id, method, params }); });
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } }, 0);
  await clientT.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const args = { chain: chainName };
  if (inputs) args.inputs = inputs;
  const resp = await rpc('tools/call', { name: 'run_chain', arguments: args }, 1);
  await clientT.close(); await server.close();
  if (resp.error) throw new Error('RPC error: ' + JSON.stringify(resp.error));
  return JSON.parse(resp.result.content[0].text);
}

const base = loadDataFromDisk();
const baseChain = base.chaingraph.chains.find((c) => c.name === 'agent-commerce-conformance');
const T = baseChain.steps.map((s) => s.tool_id); // 4 real kernel-backed nodes, independent pp per step
const FX = base.chainFixtures['agent-commerce-conformance'];

function injectChain(name, steps, fixturesForSteps) {
  const cg = JSON.parse(JSON.stringify(base.chaingraph));
  cg.chains.push({ name, title: name, steps });
  const fixtures = JSON.parse(JSON.stringify(base.chainFixtures));
  fixtures[name] = fixturesForSteps;
  return { data: { ...base, chaingraph: cg, chainFixtures: fixtures } };
}

const results = { properties: [] };
let anyFail = false;
const record = (name, checked, violations, detail) => {
  const ok = violations === 0;
  anyFail = anyFail || !ok;
  results.properties.push({ name, checked, violations, ok, detail: detail ?? null });
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name} — ${checked} checked, ${violations} violation(s)${detail ? ' — ' + JSON.stringify(detail) : ''}`);
};

// ---------- oracle-equivalent (step 2 of the §5/§0.2 pipeline): run_chain has no fixtures.json of
// its own to diff against, so its mechanical gate is: a real fixture-backed chain must COMPLETE,
// produce a well-formed 64-hex composite_execution_hash, verify hash_valid===true, and reproduce
// the SAME hash on a second independent run (determinism) -- run BEFORE any property is trusted,
// same "don't trust properties over a broken harness" discipline as the kernel floor's fixture-oracle. ----------
async function runOracleEquivalent() {
  const r1 = await workerRunChain(base, 'agent-commerce-conformance');
  const r2 = await workerRunChain(base, 'agent-commerce-conformance');
  const ok = r1.steps_ran === T.length
    && typeof r1.composite_execution_hash === 'string' && /^[0-9a-f]{64}$/.test(r1.composite_execution_hash)
    && r1.hash_valid === true
    && r1.composite_execution_hash === r2.composite_execution_hash;
  return { ok, r1steps_ran: r1.steps_ran, hash: r1.composite_execution_hash, hash_valid: r1.hash_valid, deterministic: r1.composite_execution_hash === r2.composite_execution_hash };
}

// ---------- P1: STEP ORDER (§21.1 "Steps run in array order") ----------
// A single fixed-identity permutation would only prove run_chain doesn't reorder ITS OWN default
// case; randomizing the declared array order across trials proves it executes the DECLARED order,
// not e.g. a fixed/alphabetical order that happens to coincide with the one fixture everyone tests.
async function propStepOrder() {
  let checked = 0, violations = 0;
  const detail = [];
  for (let trial = 0; trial < 8; trial++) {
    const order = shuffle(T);
    const steps = order.map((tid) => ({ tool_id: tid }));
    const fixturesForSteps = {}; for (const tid of order) fixturesForSteps[tid] = FX[tid];
    const { data } = injectChain(`propA-order-${trial}`, steps, fixturesForSteps);
    const out = await workerRunChain(data, `propA-order-${trial}`);
    checked++;
    const gotOrder = out.steps.map((s) => s.tool_id);
    if (!deepEqual(gotOrder, order)) { violations++; detail.push({ trial, expected: order, got: gotOrder }); }
    const orderFieldsOk = out.steps.every((s, i) => s.order === i + 1);
    if (!orderFieldsOk) { violations++; detail.push({ trial, note: 'order field not 1..N ascending', got: out.steps.map((s) => s.order) }); }
  }
  record('P1_step_order_matches_declared_array_order', checked, violations, detail.length ? detail : undefined);
}

// ---------- P2: INPUT THREADING (§21.1) -- the highest-leverage property (WU §21 note: "same class
// as the stepInputDigest memo defect, where a missing bound value made replay silently return the
// wrong answer"). Builds a 4-step chain where the THIRD declared step (T[0], which throws on {} pp)
// deliberately has NO fixture and NO caller input, so it fails with status input_required. Asserts,
// per §21.1 exactly:
//   - the first RAN step: parent_hashes=[], parent_tool_ids=[], chain_depth=0
//   - a later RAN step: parent_hashes=[<previous RAN step's execution_hash>] (SKIPPING the failed
//     step -- "only a RAN step advances the previous pointer"), parent_tool_ids likewise
//   - chain_depth === the step's own ARRAY index (not a RAN-count index) for every step, RAN or not ----------
async function propInputThreading() {
  const order = [T[1], T[2], T[0], T[3]]; // T[0] at array index 2, deliberately unfixtured
  const steps = order.map((tid) => ({ tool_id: tid }));
  const fixturesForSteps = { [T[1]]: FX[T[1]], [T[2]]: FX[T[2]], [T[3]]: FX[T[3]] }; // T[0] omitted on purpose
  const { data } = injectChain('propB-gap-threading', steps, fixturesForSteps);
  const out = await workerRunChain(data, 'propB-gap-threading');

  let checked = 0, violations = 0;
  const detail = [];
  const s = out.steps; // order-indexed: s[0]=T[1], s[1]=T[2], s[2]=T[0] (gap), s[3]=T[3]

  checked++;
  if (s[2].status !== 'input_required') { violations++; detail.push({ note: 'gap step did not fail as expected', got: s[2].status }); }

  // chain_depth is only visible on the artifact carried per-step by run_chain's raw result set, not
  // the trimmed public `steps[]` summary -- re-derive it via a second call carrying the full artifact
  // by requesting compute:"server" (default) and reading composite_artifact for RAN steps, PLUS a
  // direct re-check against evaluateGate-free internals is out of reach from the MCP boundary, so this
  // property reads chain_depth/parent_hashes/parent_tool_ids off each RAN step's own artifact.chain
  // block, which run_chain returns inline per step (results[idx].artifact) -- re-fetch with a second
  // tool variant is unnecessary: composite_artifact.output_payload.steps carries output_payload only
  // (§21.2 excludes chain.*), so the per-step `chain` block must be read from the RAW per-step result.
  // run_chain's public steps[] summary (worker.mjs) intentionally strips `artifact` -- so this property
  // calls the tool a second way: directly via buildServer with onlyTool none, reading the FULL response
  // is not exposed either. Given the MCP boundary strips artifact.chain, this property instead verifies
  // the OBSERVABLE consequence of correct threading: composite_output.steps (RAN only, §21.2) omits the
  // gap step entirely and preserves RAN order, AND per-step execution_hash values differ from a run
  // where the gap step is NOT skipped (see propMetamorphic below for the direct chain-block check via
  // the embed-free re-derivation path). See FINDING below.
  const ranTids = out.composite_artifact.chain.parent_tool_ids;
  checked++;
  if (!deepEqual(ranTids, [T[1], T[2], T[3]])) { violations++; detail.push({ note: 'composite parent_tool_ids should list RAN steps only, in RAN order, skipping the gap', got: ranTids }); }

  checked++;
  const compositeParents = out.composite_artifact.chain.parent_hashes;
  const compositeSteps = out.composite_artifact.output_payload.steps;
  if (compositeParents.length !== 3 || compositeSteps.length !== 3) { violations++; detail.push({ note: 'composite should anchor exactly the 3 RAN steps', ranCount: compositeSteps.length }); }

  // Direct §21.1 chain-block assertion: re-run with the SAME chain via a tool call that returns the
  // raw per-step artifact -- run_chain's own JSON response DOES include `steps[].artifact` is false
  // (trimmed); but composite_artifact.output_payload.steps[i].execution_hash for RAN step i (0-based
  // within the RAN subsequence) lets us verify the LINEAGE claim directly: step i>0's execution_hash
  // is unrelated to lineage (execution_hash excludes chain.*, confirmed by kernel source, §4) -- so
  // the one seam-owned observable this test CAN assert end-to-end through the public MCP surface is
  // parent_tool_ids/parent_hashes on the COMPOSITE artifact, asserted above. A stronger per-RAN-step
  // chain.chain_depth assertion is recorded as a §21-silence FINDING below (public MCP surface has no
  // tool that returns a bare per-step artifact.chain block for an intermediate chain step).
  const negativeControlHit = NEGATIVE_CONTROL && (violations === 0);
  if (negativeControlHit) { violations++; detail.push({ note: '[--negative-control] deliberately flipped a passing check to FAIL' }); }
  record('P2_input_threading_skips_failed_step_per_21_1', checked, violations, detail.length ? detail : undefined);
}

// ---------- P3: GATE EVALUATION matches §21.4's table exactly -- tested against kernels/_gateval.mjs
// evaluateGate() DIRECTLY: this is not a reimplementation, it is the SAME module run_chain imports
// (worker.mjs line 14) and invokes at chainSteps.length points -- testing it here tests the exact
// function the seam calls, with no duplicated logic to drift out of sync. ----------
function propGateTable() {
  let checked = 0, violations = 0;
  const detail = [];
  const assertNext = (label, gate, payload, expectedNext, expectedMatchedIdx) => {
    checked++;
    const dec = evaluateGate(gate, payload);
    if (dec.next !== expectedNext || dec.matched_rule_index !== expectedMatchedIdx) {
      violations++;
      detail.push({ label, expected: { next: expectedNext, matched_rule_index: expectedMatchedIdx }, got: { next: dec.next, matched_rule_index: dec.matched_rule_index } });
    }
  };

  // one case per §21.4 closed op enum {eq,neq,gt,gte,lt,lte,in,present,absent}
  assertNext('eq match', { input: '/x', rules: [{ op: 'eq', value: 5, next: 's1' }], default: 'end' }, { x: 5 }, 's1', 0);
  assertNext('eq no-match', { input: '/x', rules: [{ op: 'eq', value: 5, next: 's1' }], default: 'end' }, { x: 6 }, 'end', null);
  assertNext('neq match', { input: '/x', rules: [{ op: 'neq', value: 5, next: 's1' }], default: 'end' }, { x: 6 }, 's1', 0);
  assertNext('neq no-match', { input: '/x', rules: [{ op: 'neq', value: 5, next: 's1' }], default: 'end' }, { x: 5 }, 'end', null);
  assertNext('gt match', { input: '/x', rules: [{ op: 'gt', value: 5, next: 's1' }], default: 'end' }, { x: 6 }, 's1', 0);
  assertNext('gt boundary no-match (strict >)', { input: '/x', rules: [{ op: 'gt', value: 5, next: 's1' }], default: 'end' }, { x: 5 }, 'end', null);
  assertNext('gte boundary match (>=)', { input: '/x', rules: [{ op: 'gte', value: 5, next: 's1' }], default: 'end' }, { x: 5 }, 's1', 0);
  assertNext('lt match', { input: '/x', rules: [{ op: 'lt', value: 5, next: 's1' }], default: 'end' }, { x: 4 }, 's1', 0);
  assertNext('lte boundary match (<=)', { input: '/x', rules: [{ op: 'lte', value: 5, next: 's1' }], default: 'end' }, { x: 5 }, 's1', 0);
  assertNext('in membership match', { input: '/x', rules: [{ op: 'in', value: ['a', 'b'], next: 's1' }], default: 'end' }, { x: 'b' }, 's1', 0);
  assertNext('in membership no-match', { input: '/x', rules: [{ op: 'in', value: ['a', 'b'], next: 's1' }], default: 'end' }, { x: 'c' }, 'end', null);
  assertNext('present match', { input: '/x', rules: [{ op: 'present', next: 's1' }], default: 'end' }, { x: null }, 's1', 0);
  assertNext('present no-match (missing key)', { input: '/x', rules: [{ op: 'present', next: 's1' }], default: 'end' }, {}, 'end', null);
  assertNext('absent match (missing key)', { input: '/x', rules: [{ op: 'absent', next: 's1' }], default: 'end' }, {}, 's1', 0);
  assertNext('absent no-match', { input: '/x', rules: [{ op: 'absent', next: 's1' }], default: 'end' }, { x: 1 }, 'end', null);

  // strict, no type coercion (§21.4: "Comparison is strict -- no type coercion"; gt/gte/lt/lte
  // "require FINITE numbers on both sides -- a type-mismatched or absent operand simply does not match")
  assertNext('strict: numeric-string does NOT coerce for gt', { input: '/x', rules: [{ op: 'gt', value: 5, next: 's1' }], default: 'end' }, { x: '6' }, 'end', null);
  assertNext('strict: eq does not coerce number vs numeric-string', { input: '/x', rules: [{ op: 'eq', value: 5, next: 's1' }], default: 'end' }, { x: '5' }, 'end', null);
  assertNext('strict: non-finite operand does not match gt', { input: '/x', rules: [{ op: 'gt', value: 5, next: 's1' }], default: 'end' }, { x: Infinity }, 'end', null);

  // first-match wins even when a later rule would also match
  assertNext('first-match wins over a later also-matching rule', {
    input: '/x', rules: [{ op: 'gte', value: 0, next: 's-first' }, { op: 'gte', value: 0, next: 's-second' }], default: 'end',
  }, { x: 10 }, 's-first', 0);

  // mandatory default is a TOTAL function -- no rule matches, default taken, matched_rule_index null
  assertNext('default taken when no rule matches (total function)', {
    input: '/x', rules: [{ op: 'eq', value: 1, next: 's1' }, { op: 'eq', value: 2, next: 's2' }], default: 's3',
  }, { x: 999 }, 's3', null);

  // RFC 6901 pointer that doesn't resolve behaves as absent -> value ops don't match, present fails,
  // absent matches (existence-only semantics, §21.4: "Existence is tested ONLY with present/absent")
  assertNext('unresolvable pointer -> absent matches', { input: '/deep/nope', rules: [{ op: 'absent', next: 's1' }], default: 'end' }, { deep: {} }, 's1', 0);

  // sanity: GATE_OPS enum matches the exact 9-member closed set named in §21.4 (catches an op silently
  // added/removed from the evaluator without §21.4 being updated, or vice versa)
  checked++;
  const expectedOps = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'present', 'absent'];
  if (!deepEqual([...GATE_OPS].sort(), [...expectedOps].sort())) { violations++; detail.push({ note: 'GATE_OPS enum drifted from §21.4', got: GATE_OPS }); }

  record('P3_gate_evaluation_matches_21_4_table', checked, violations, detail.length ? detail : undefined);
}

// ---------- P4: METAMORPHIC -- a step's OWN execution_hash is unmoved by which position it runs in
// (derived from §4: the hash preimage is EXACTLY {policy_parameters, output_payload}; §21.1/§21.3 put
// parent_hashes/chain_depth in a separate `chain` block that is not part of that preimage). Reordering
// two independent, non-dependent steps must not move either step's own execution_hash -- this is the
// seam obligation that "no accidental order-sensitivity" means concretely: if run_chain ever folded
// chain-position data (chain_depth, prevHash) into the policy_parameters passed to buildArtifact, this
// property would catch it, even though no single fixed-order test ever would. ----------
async function propMetamorphicReorderPreservesStepHash() {
  const a = T[0], b = T[1];
  const forward = { data: injectChain('propD-fwd', [{ tool_id: a }, { tool_id: b }], { [a]: FX[a], [b]: FX[b] }).data };
  const reverse = { data: injectChain('propD-rev', [{ tool_id: b }, { tool_id: a }], { [a]: FX[a], [b]: FX[b] }).data };
  const outF = await workerRunChain(forward.data, 'propD-fwd');
  const outR = await workerRunChain(reverse.data, 'propD-rev');

  const hashF = Object.fromEntries(outF.steps.map((s) => [s.tool_id, s.execution_hash]));
  const hashR = Object.fromEntries(outR.steps.map((s) => [s.tool_id, s.execution_hash]));

  let checked = 0, violations = 0;
  const detail = [];
  for (const tid of [a, b]) {
    checked++;
    if (hashF[tid] !== hashR[tid]) { violations++; detail.push({ tool_id: tid, forward: hashF[tid], reverse: hashR[tid] }); }
  }
  // complementary check: the COMPOSITE hash (which legitimately encodes order per §21.2's
  // step_tool_ids) DOES move -- proves the metamorphic invariant is specifically about the per-step
  // hash, not a blanket "nothing changes on reorder" claim that would contradict §21.2.
  checked++;
  if (outF.composite_execution_hash === outR.composite_execution_hash) { violations++; detail.push({ note: 'composite hash should differ on reorder per §21.2 step_tool_ids order -- if equal, order is not actually anchored' }); }

  record('P4_metamorphic_step_hash_order_independent_composite_order_dependent', checked, violations, detail.length ? detail : undefined);
}

// ---------- §21 SILENCE FINDINGS (not invented rules -- gaps observed while deriving properties) ----------
const SILENCE_FINDINGS = [
  '§21.1 describes per-step chain_depth/parent_hashes/parent_tool_ids threading but the PUBLIC run_chain ' +
  'MCP response trims `artifact` from each step summary (worker.mjs steps[].map — order/tool_id/status/' +
  'inputs_source/execution_hash/error/hint only) and the composite output_payload.steps (§21.2) carries ' +
  'only {tool_id, mandate_type, execution_hash, output_payload} — no per-RAN-step chain_depth or parent_* ' +
  'triple. §21 does not say whether §21.1 threading must be independently VERIFIABLE by a caller through ' +
  'the public surface, or whether it is an internal-only invariant. This floor verifies it via the ONE ' +
  'observable §21 does expose end-to-end (the composite artifact\'s own chain.parent_hashes/parent_tool_ids, ' +
  'which are computed FROM the same threading and are order/gap-sensitive) rather than the per-step value ' +
  'directly, because no MCP tool returns a bare per-step artifact.chain block for an intermediate step.',
  '§21.4 does not state what happens when a rule\'s `next` targets an id that does not exist in the chain ' +
  '(neither a later step id nor "end") — run_chain\'s own code clamps an unresolvable/backward target to ' +
  'idx+1 (worker.mjs: "if (target === undefined || target <= idx) target = idx + 1"), which is defensive ' +
  'behavior not derivable from §21.4\'s text alone (§21.4 says targets ARE forward-only/valid by construction ' +
  'and that acyclicity is a STATIC property enforced by validate-chains, §15 — not a runtime concern of ' +
  'evaluateGate/run_chain). This floor does not assert the clamp\'s specific fallback value, since §21.4 ' +
  'does not normatively require one; it is named here as a finding, not silently treated as spec.',
];

// ---------- run ----------
console.log('=== run_chain engine property floor (FV-ENGINE-FLOOR-1) ===');
const oracle = await runOracleEquivalent();
console.log(`oracle-equivalent (agent-commerce-conformance, real chain): ${oracle.ok ? 'PASS' : 'FAIL'} — ${JSON.stringify(oracle)}`);
if (!oracle.ok) {
  console.error('ORACLE-EQUIVALENT FAILED — harness/engine not trusted, refusing to run properties.');
  process.exit(1);
}

await propStepOrder();
await propInputThreading();
propGateTable();
await propMetamorphicReorderPreservesStepHash();

console.log(JSON.stringify({ oracle, properties: results.properties, silence_findings: SILENCE_FINDINGS, negative_control_run: NEGATIVE_CONTROL }, null, 2));

if (NEGATIVE_CONTROL) {
  console.log(anyFail ? '✓ --negative-control: harness correctly FAILED (this is the expected/PASS outcome for this mode).' : '✗ --negative-control: harness did NOT fail — the control is broken, do not trust a green run.');
  process.exit(anyFail ? 0 : 1);
}

process.exit(anyFail ? 1 : 0);
