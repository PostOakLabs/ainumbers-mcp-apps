#!/usr/bin/env node
// gate-decision-trail-boundary.mjs — DECISIONTRAIL-1: per-step decision reason codes on
// run_chain results and the PREIMAGE BOUNDARY that carries them.
//
// WHY: run chains are deterministic (no model choice), so a step's "why" is route/gate/
// escalation rationale, not model intent. DECISIONTRAIL-1 adds a per-step decision_trail
// (closed reason_code enum: ran | gate_routed | skipped_by_gate | skipped_by_escalation |
// input_required | unknown_node | gpu_browser_only | no_kernel_browser_only, with gate
// rule id, escalation attribution and input_required cause) — and the W0-WORKERHEALTH-1
// standing verdict treats "fields riding the hashed preimage" as the LIVESMOKE hazard
// class: additive reason codes MUST live OUTSIDE the execution_hash preimage. This gate
// is the standing proof of exactly that, adversarial about the one thing that must not
// move: the composite execution_hash.
//
//   1. PREIMAGE BOUNDARY (the row's proof) — STRUCTURAL, not coincidental: re-hashing the
//      composite payload with the decision_trail member REMOVED reproduces the published
//      composite_execution_hash; leaving it IN yields a different hash (mutation control,
//      SO #34 — without it "the hash didn't move" would pass for a gate that computes nothing).
//   2. PER-STEP + CLOSED ENUM — the trail covers every considered step, in order, statuses
//      mirroring steps[], reason_code drawn only from the closed enum.
//   3. RECOMPUTABLE — every gate_routed entry's gate_rule_id/next is recomputable from the
//      HASH-BOUND decisions[] alone (step_id + "#r<index>" | "#default"): the trail is a
//      rendering of hash-bound state, never a second source of truth.
//   4. ESCALATION — a chain that routes to "escalate" carries skipped_by_escalation entries
//      with the triggering rule id + decided_by, cross-checked against decisions[].
//   5. INPUT_REQUIRED — a step the kernel refuses carries input_required_cause (the kernel
//      error), matching steps[].error.
//   6. CONDITIONAL PRESENCE — a plain all-ok linear run emits NO decision_trail member on
//      the response or in the composite payload (nothing to explain; the flags posture).
//   7. DETERMINISM / REPLAY — re-running the same chains reproduces the composite
//      execution_hash AND a byte-identical trail.
//
// Drives the WORKER run_chain via InMemoryTransport (the surface that assembles the trail;
// embed/runChain.mjs is untouched by DECISIONTRAIL-1). Zero-dep, no network.
//
// Usage: node scripts/gate-decision-trail-boundary.mjs

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer, widgetGlue, stripCspMeta } from '../worker.mjs';
import { PILOT } from '../pilot.mjs';
import { executionHash } from '../embed/lib/_hash.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = resolve(ROOT, 'data');
const get = (p) => readFileSync(resolve(DATA, p), 'utf8');

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

async function withRunChain(data, fn) {
  const server = buildServer(data, { onlyTool: 'run_chain' });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  await clientT.start();
  const pending = new Map();
  clientT.onmessage = (msg) => {
    if (msg && msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  };
  let nextId = 2;
  const rpc = (method, params, id) => new Promise((res) => { pending.set(id, res); clientT.send({ jsonrpc: '2.0', id, method, params }); });
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'decisiontrail-gate', version: '1' } }, 0);
  await clientT.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const run = async (args) => {
    const resp = await rpc('tools/call', { name: 'run_chain', arguments: args }, nextId++);
    if (resp.error) throw new Error('RPC error: ' + JSON.stringify(resp.error));
    if (resp.result?.isError) throw new Error('tool error: ' + resp.result?.content?.[0]?.text);
    return JSON.parse(resp.result.content[0].text);
  };
  try { return await fn(run); } finally { await clientT.close(); await server.close(); }
}

// The gate's own recomputation of a decision's rule id (mirrors worker.mjs trailRuleId —
// deliberately written out here so agreement is a PROOF, not an import).
const ruleId = (d) => d.step_id + (d.matched_rule_index === null ? '#default' : '#r' + d.matched_rule_index);
const REASON_CODES = new Set(['ran', 'gate_routed', 'skipped_by_gate', 'skipped_by_escalation', 'input_required', 'unknown_node', 'gpu_browser_only', 'no_kernel_browser_only']);

let failed = 0;
const fail = (m) => { console.error(`  ✗ ${m}`); failed++; };
const ok = (m) => console.log(`  ✓ ${m}`);

function checkTrailShape(res, label) {
  const steps = res.steps ?? [];
  const trail = res.decision_trail;
  if (!Array.isArray(trail)) { fail(`${label}: no decision_trail on the run_chain response`); return null; }
  if (!Array.isArray(res.composite_artifact?.output_payload?.decision_trail)) {
    fail(`${label}: composite_output.decision_trail missing (response-only carriage is not enough for an auditor holding the artifact)`);
  } else if (JSON.stringify(res.composite_artifact.output_payload.decision_trail) !== JSON.stringify(trail)) {
    fail(`${label}: response trail != composite_output trail`);
  } else {
    ok(`${label}: trail on response AND composite_output, byte-identical (${trail.length} entries)`);
  }
  if (trail.length !== steps.length) fail(`${label}: trail has ${trail.length} entries for ${steps.length} steps — not per-step`);
  for (let i = 0; i < trail.length; i++) {
    const t = trail[i], s = steps[i];
    if (t.order !== s.order || t.tool_id !== s.tool_id || t.status !== s.status) {
      fail(`${label}: trail[${i}] {${t.order},${t.tool_id},${t.status}} does not mirror steps[${i}] {${s.order},${s.tool_id},${s.status}}`);
    }
    if (!REASON_CODES.has(t.reason_code)) fail(`${label}: trail[${i}] reason_code "${t.reason_code}" outside the closed enum`);
  }
  return trail;
}

function recomputeGateEntries(res, label) {
  const trail = res.decision_trail ?? [];
  const decs = res.decisions ?? [];
  const byStep = new Map(decs.map((d) => [d.step_id, d]));
  const routed = trail.filter((t) => t.reason_code === 'gate_routed' || t.reason_code === 'skipped_by_gate' || t.reason_code === 'skipped_by_escalation');
  if (!routed.length) { fail(`${label}: no gate-attributed entries to recompute`); return 0; }
  for (const t of routed) {
    const sourceStep = t.reason_code === 'gate_routed' ? t.tool_id : t.decided_by;
    const d = byStep.get(sourceStep);
    if (!d) { fail(`${label}: entry ${t.tool_id} cites "${sourceStep}" but decisions[] has no such step`); continue; }
    if (t.gate_rule_id !== ruleId(d)) fail(`${label}: ${t.tool_id} gate_rule_id ${t.gate_rule_id} != recomputed ${ruleId(d)}`);
    if (t.reason_code === 'gate_routed' && t.next !== d.next) fail(`${label}: ${t.tool_id} next ${t.next} != decision next ${d.next}`);
    if (t.reason_code === 'skipped_by_escalation' && d.next !== 'escalate') fail(`${label}: ${t.tool_id} cites escalation by ${sourceStep} whose decision next is ${d.next}, not "escalate"`);
  }
  ok(`${label}: all ${routed.length} gate-attributed entries recompute from the HASH-BOUND decisions[]`);
  return routed.length;
}

async function main() {
  console.log('\n▶ DECISIONTRAIL-1: decision-trail preimage boundary + carriage\n');
  const data = loadDataFromDisk();

  // ── 1+2+3+7. GATED chain: boundary proof, per-step shape, recomputability, determinism ──
  const GATED = 'adverse-action-notice-compliance';
  const res = await withRunChain(data, (run) => run({ chain: GATED }));
  const art = res.composite_artifact;
  if (!art) { console.error(`✗ ${GATED} produced no composite artifact — gate cannot proceed.`); process.exit(1); }
  console.log(`  chain under test: ${GATED}  (composite_execution_hash ${art.execution_hash})`);

  const trail = checkTrailShape(res, GATED);
  if (trail) recomputeGateEntries(res, GATED); else failed++;

  // 1. PREIMAGE BOUNDARY — structural, with a mutation control (the row's core proof).
  const payload = art.output_payload;
  if (!('decision_trail' in payload)) fail(`${GATED}: composite payload carries no decision_trail member`);
  const frozen = JSON.parse(JSON.stringify(payload));
  delete frozen.decision_trail;
  const withoutTrail = await executionHash(art.policy_parameters, frozen);
  const withTrail = await executionHash(art.policy_parameters, payload);
  if (withoutTrail !== art.execution_hash) {
    fail(`PREIMAGE BROKEN — hash over the payload minus decision_trail is ${withoutTrail}, published hash is ${art.execution_hash}. The reason codes entered the hashed preimage.`);
  } else {
    ok(`preimage boundary: removing decision_trail reproduces the published composite_execution_hash exactly — the trail is hash-excluded adjacent metadata`);
  }
  if (withTrail === art.execution_hash) {
    fail('MUTATION CONTROL FAILED — leaving decision_trail in the preimage yields the SAME hash, so this check proves nothing.');
  } else {
    ok(`mutation control: leaving the trail in yields ${withTrail.slice(0, 16)}… ≠ published hash — exclusion is real, not vacuous`);
  }

  // 7. DETERMINISM / REPLAY — same chain again: same hash, byte-identical trail.
  const res2 = await withRunChain(data, (run) => run({ chain: GATED }));
  if (res2.composite_execution_hash !== res.composite_execution_hash) fail(`${GATED}: composite_execution_hash moved on replay`);
  else if (JSON.stringify(res2.decision_trail) !== JSON.stringify(res.decision_trail)) fail(`${GATED}: decision_trail not byte-identical on replay`);
  else ok(`determinism replay: composite hash ${res.composite_execution_hash.slice(0, 16)}… and trail byte-identical across runs`);

  // ── 4. ESCALATION — a chain whose gate routes to "escalate". ────────────────────────────
  const ESC = 'dora-escalation-demo';
  const escRes = await withRunChain(data, (run) => run({ chain: ESC }));
  if (!escRes.escalation_record) fail(`${ESC}: no escalation_record — cannot prove escalation attribution`);
  else {
    console.log(`\n  escalation chain: ${ESC}`);
    const escTrail = checkTrailShape(escRes, ESC);
    if (escTrail) recomputeGateEntries(escRes, ESC);
    if (!(escTrail ?? []).some((t) => t.reason_code === 'skipped_by_escalation')) fail(`${ESC}: escalation ran but the trail has no skipped_by_escalation entry`);
    else ok(`${ESC}: escalation attribution present (rule id + decided_by on every halted step)`);
  }

  // ── 5. INPUT_REQUIRED — a step the kernel refuses for missing inputs. ───────────────────
  const IR_CHAIN = 'agent-commerce-conformance';
  const IR_STEP = 'art-01-ap2-mandate-chain-validator';
  const irRes = await withRunChain(data, (run) => run({ chain: IR_CHAIN, inputs: { [IR_STEP]: {} } }));
  console.log(`\n  input_required case: ${IR_CHAIN} with inputs["${IR_STEP}"] = {}`);
  const irTrail = checkTrailShape(irRes, IR_CHAIN);
  const irEntry = (irTrail ?? []).find((t) => t.tool_id === IR_STEP);
  const irStep = (irRes.steps ?? []).find((s) => s.tool_id === IR_STEP);
  if (!irEntry || irEntry.reason_code !== 'input_required') fail(`${IR_STEP}: trail entry is not input_required (${JSON.stringify(irEntry)})`);
  else if (!irEntry.input_required_cause || irEntry.input_required_cause !== irStep?.error) fail(`${IR_STEP}: input_required_cause missing or != steps[].error`);
  else ok(`${IR_STEP}: input_required_cause carried and matches steps[].error ("${irEntry.input_required_cause}")`);

  // ── 6. CONDITIONAL PRESENCE — plain all-ok linear run: NO member anywhere. ──────────────
  const linRes = await withRunChain(data, (run) => run({ chain: IR_CHAIN }));
  const linearAllOk = !(linRes.decisions ?? []).length && (linRes.steps ?? []).every((s) => s.status === 'ok');
  if (!linearAllOk) console.log('  ⚠ control chain not all-ok/linear this run — absence half unexercised.');
  else if ('decision_trail' in linRes || 'decision_trail' in (linRes.composite_artifact?.output_payload ?? {})) {
    fail(`${IR_CHAIN}: all-ok linear run carries a decision_trail member — conditional presence broken`);
  } else ok(`${IR_CHAIN}: all-ok linear run emits NO decision_trail on response or artifact (conditional presence)`);

  console.log('');
  if (failed) { console.error(`✗ decision-trail boundary FAILED — ${failed} assertion(s) red.`); process.exit(1); }
  console.log('✅ decision-trail boundary: reason codes carried per-step, recomputable from the hash-bound decisions[], and structurally OUTSIDE the execution_hash preimage.');
}

main().catch((err) => { console.error('✗ gate ERROR:', err); process.exit(1); });
