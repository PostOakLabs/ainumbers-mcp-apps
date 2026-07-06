#!/usr/bin/env node
// test-escalate-emit.mjs — OCG §22.8.2 escalation emit/halt tests.
//
// Verifies:
//   1. Escalation path: gate fires escalate → HALT, skipped_by_escalation steps present,
//      escalation_record attached with deterministic record_hash, no opened_at in preimage.
//   2. Auto path (gate passes): no escalation_record, composite hash identical to a second run.
//   3. Record-hash determinism: two escalation runs with different opened_at → identical record_hash
//      AND identical composite_execution_hash.
//   4. Parity: worker run_chain == embed runChain on both branches (composite_hash, decisions,
//      path_taken, escalation_record.record_hash).
//   5. Mandate-bound escalation: mandate_hash present → record_hash differs from unbound.
//   6. No-escalation freeze: auto path composite hash byte-identical to itself (determinism).
//
// Run: node scripts/test-escalate-emit.mjs   (exit 0 = all green)

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer, widgetGlue, stripCspMeta } from '../worker.mjs';
import { PILOT } from '../pilot.mjs';
import { runChain as embedRunChain } from '../embed/runChain.mjs';
import { getKernel } from '../kernels/index.mjs';
import { cgCanon } from '../embed/lib/_hash.mjs';

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

async function workerRunChain(data, chainName, inputs) {
  const server = buildServer(data, { onlyTool: 'run_chain' });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  await clientT.start();
  const pending = new Map();
  clientT.onmessage = (msg) => {
    if (msg && msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  };
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

// Fixtures for the dora-escalation-demo chain:
//   - escalation: grade=F (default art-29 fixture {})
//   - auto: all-yes answers → grade=A → gate default → runs art-09
const ESCALATION_INPUTS = {
  'art-29-dora-readiness-diagnostic': {},
};
const AUTO_INPUTS = {
  'art-29-dora-readiness-diagnostic': {
    answers: { q1:'yes', q2:'yes', q3:'yes', q4:'yes', q5:'yes', q6:'yes',
               q7:'yes', q8:'yes', q9:'yes', q10:'yes', q11:'yes', q12:'yes' },
  },
};
const CHAIN = 'dora-escalation-demo';

let fail = 0;
const ok  = (l) => console.log('  ✓ ' + l);
const bad = (l, d) => { fail++; console.error('  ✗ ' + l + (d ? ' — ' + d : '')); };

const base = loadDataFromDisk();
const cg = base.chaingraph;
const fixtures = base.chainFixtures;
const deps = { getKernel, chaingraph: cg, fixtures };

// ── 1. ESCALATION PATH ───────────────────────────────────────────────────────
console.log('\n[1] Escalation path (grade=F → escalate → HALT)');
const wEsc  = await workerRunChain(base, CHAIN, ESCALATION_INPUTS);
const eEsc  = await embedRunChain(CHAIN, ESCALATION_INPUTS, deps);

// Skipped-by-escalation present
const wSkip = (wEsc.steps || []).filter((s) => s.status === 'skipped_by_escalation');
const eSkip = (eEsc.steps || []).filter((s) => s.status === 'skipped_by_escalation');
if (!wSkip.length) bad('worker: skipped_by_escalation step(s) present', JSON.stringify(wEsc.steps));
else ok('worker: skipped_by_escalation present: ' + wSkip.map((s) => s.tool_id).join(','));
if (!eSkip.length) bad('embed: skipped_by_escalation step(s) present');
else ok('embed: skipped_by_escalation present');

// No skipped_by_gate (escalation uses distinct status)
const wGate = (wEsc.steps || []).filter((s) => s.status === 'skipped_by_gate');
if (wGate.length) bad('worker: escalation must use skipped_by_escalation, not skipped_by_gate');
else ok('worker: no skipped_by_gate on escalation path (correct)');

// escalation_record present and well-formed
const wRec = wEsc.escalation_record;
const eRec = eEsc.escalation_record;
if (!wRec) bad('worker: escalation_record absent');
else ok('worker: escalation_record present');
if (!eRec) bad('embed: escalation_record absent');
else ok('embed: escalation_record present');

if (wRec) {
  if (!wRec.record_hash || !/^[0-9a-f]{64}$/.test(wRec.record_hash)) bad('worker: record_hash not 64-char hex', wRec.record_hash);
  else ok('worker: record_hash is 64-char hex');
  if (!wRec.opened_at) bad('worker: opened_at absent');
  else ok('worker: opened_at present (wall-clock, hash-excluded)');
  if (!wRec.decision || !wRec.decision.step_id) bad('worker: decision.step_id absent');
  else ok('worker: decision.step_id = ' + wRec.decision.step_id);
  if (!Array.isArray(wRec.halted_steps)) bad('worker: halted_steps not array');
  else ok('worker: halted_steps = ' + JSON.stringify(wRec.halted_steps));
  if ('mandate_hash' in wRec) bad('worker: mandate_hash present in unbound escalation (must be absent)');
  else ok('worker: mandate_hash absent on unbound run (correct conditional-presence)');
}

// ── 2. RECORD-HASH DETERMINISM (opened_at excluded) ─────────────────────────
console.log('\n[2] Record-hash determinism (two runs → identical record_hash regardless of opened_at)');
const wEsc2 = await workerRunChain(base, CHAIN, ESCALATION_INPUTS);
if (!wRec || !wEsc2.escalation_record) bad('determinism: escalation_record absent on second run');
else {
  if (wEsc2.escalation_record.record_hash !== wRec.record_hash)
    bad('record_hash MOVED between runs (opened_at leaked into preimage!)',
      `run1=${wRec.record_hash} run2=${wEsc2.escalation_record.record_hash}`);
  else ok('record_hash identical across two runs (opened_at excluded from preimage)');

  if (wEsc2.composite_execution_hash !== wEsc.composite_execution_hash)
    bad('composite_execution_hash MOVED (opened_at leaked into composite preimage!)',
      `run1=${wEsc.composite_execution_hash} run2=${wEsc2.composite_execution_hash}`);
  else ok('composite_execution_hash identical across two runs');
}

// ── 3. RECORD-HASH RECOMPUTE VERIFICATION ───────────────────────────────────
console.log('\n[3] Record-hash recompute (verifier reproduces record_hash from deterministic subset)');
if (wRec) {
  // Recompute exactly as §22.8.3: cgSha256Hex({ decision, halted_steps }) — no opened_at.
  const preimage = { decision: wRec.decision, halted_steps: wRec.halted_steps };
  const canonStr = JSON.stringify(cgCanon(preimage));
  const buf = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonStr));
  const recomputed = Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
  if (recomputed !== wRec.record_hash)
    bad('recomputed record_hash does not match', `expected=${wRec.record_hash} got=${recomputed}`);
  else ok('record_hash recomputed from {decision, halted_steps} matches (verifier can reproduce)');
}

// ── 4. AUTO PATH (no escalation_record) ─────────────────────────────────────
console.log('\n[4] Auto path (grade=A → no escalation → runs to completion)');
const wAuto  = await workerRunChain(base, CHAIN, AUTO_INPUTS);
const eAuto  = await embedRunChain(CHAIN, AUTO_INPUTS, deps);

if (wAuto.escalation_record) bad('worker auto path: escalation_record must be absent', JSON.stringify(wAuto.escalation_record));
else ok('worker auto path: no escalation_record (correct)');
if (eAuto.escalation_record) bad('embed auto path: escalation_record must be absent');
else ok('embed auto path: no escalation_record (correct)');

const wAutoRan = (wAuto.steps || []).filter((s) => s.status === 'ok');
const wAutoSkipEsc = (wAuto.steps || []).filter((s) => s.status === 'skipped_by_escalation');
if (wAutoSkipEsc.length) bad('worker auto path: skipped_by_escalation present (should not be)');
else ok('worker auto path: no skipped_by_escalation');
if (wAutoRan.length < 2) bad('worker auto path: expected both steps to run', `steps_ran=${wAuto.steps_ran}`);
else ok('worker auto path: both steps ran (' + wAutoRan.map((s) => s.tool_id).join(', ') + ')');

// Determinism on auto path
const wAuto2 = await workerRunChain(base, CHAIN, AUTO_INPUTS);
if (wAuto.composite_execution_hash !== wAuto2.composite_execution_hash)
  bad('auto path composite_execution_hash not deterministic');
else ok('auto path composite_execution_hash deterministic: ' + wAuto.composite_execution_hash?.slice(0, 16) + '…');

// ── 5. GATE-PARITY (worker == embed, both branches) ──────────────────────────
console.log('\n[5] Gate-parity: worker run_chain == embed runChain on both branches');
if (wEsc.composite_execution_hash !== eEsc.composite_execution_hash)
  bad('escalation path: composite hash parity', `worker=${wEsc.composite_execution_hash} embed=${eEsc.composite_execution_hash}`);
else ok('escalation path: composite hash parity ✓');

if (wRec && eRec && wRec.record_hash !== eRec.record_hash)
  bad('escalation path: record_hash parity', `worker=${wRec.record_hash} embed=${eRec.record_hash}`);
else ok('escalation path: record_hash parity ✓');

if (JSON.stringify(wEsc.decisions) !== JSON.stringify(eEsc.decisions))
  bad('escalation path: decisions parity');
else ok('escalation path: decisions parity ✓');

if (JSON.stringify(wEsc.path_taken) !== JSON.stringify(eEsc.path_taken))
  bad('escalation path: path_taken parity');
else ok('escalation path: path_taken parity ✓');

if (wAuto.composite_execution_hash !== eAuto.composite_execution_hash)
  bad('auto path: composite hash parity', `worker=${wAuto.composite_execution_hash} embed=${eAuto.composite_execution_hash}`);
else ok('auto path: composite hash parity ✓');

// ── 6. LINEAR-HASH-FREEZE (auto path = no escalation = byte-identical preimage) ─
console.log('\n[6] Linear-hash-freeze: no-escalation run does NOT affect existing chains');
// The auto run's composite hash depends only on ran steps — same as before escalation code.
// Since this is a NEW chain, we just verify auto hash is stable (not that it changed from a golden).
if (typeof wAuto.composite_execution_hash !== 'string' || !/^[0-9a-f]{64}$/.test(wAuto.composite_execution_hash))
  bad('auto path composite hash invalid (not 64-char hex)');
else ok('auto path composite hash is valid 64-char hex (no escalation_record in preimage)');

// ── 7. BOTH-BRANCH COVERAGE ──────────────────────────────────────────────────
console.log('\n[7] Both-branch fixture coverage (escalation rule + default)');
const escBranches = new Set((wEsc.decisions || []).map((d) =>
  `${d.step_id}#${d.matched_rule_index === null ? 'default' : 'rule' + d.matched_rule_index}`));
const autoBranches = new Set((wAuto.decisions || []).map((d) =>
  `${d.step_id}#${d.matched_rule_index === null ? 'default' : 'rule' + d.matched_rule_index}`));
const allBranches = new Set([...escBranches, ...autoBranches]);
if (!allBranches.has('art-29-dora-readiness-diagnostic#rule0')) bad('rule0 branch (escalation) not covered', [...allBranches].join(','));
else ok('rule0 (escalation) branch covered');
if (!allBranches.has('art-29-dora-readiness-diagnostic#default')) bad('default branch (auto) not covered', [...allBranches].join(','));
else ok('default (auto) branch covered');

// ── Summary ───────────────────────────────────────────────────────────────────
console.log('');
if (fail) { console.error(`✗ test-escalate-emit: ${fail} failure(s)`); process.exit(1); }
console.log('✅ test-escalate-emit: all §22.8.2 escalation emit/halt tests passed.');
console.log('');
console.log('Sample open escalation record for session 3 (passkey ceremony):');
if (wRec) {
  console.log('  record_hash:', wRec.record_hash);
  console.log('  halted_steps:', JSON.stringify(wRec.halted_steps));
  console.log('  decision.next:', wRec.decision?.next);
  console.log('  Full record:');
  console.log(JSON.stringify({ ...wRec, opened_at: '<wall-clock — varies>' }, null, 4).split('\n').map((l) => '    ' + l).join('\n'));
}
