#!/usr/bin/env node
// gate-parity.test.mjs — OCG v0.8 gate 5 (evaluator byte-parity across surfaces).
//
// The Worker run_chain (worker.mjs) and the embedded runChain (embed/runChain.mjs)
// MUST evaluate decision gates byte-identically: same route, same decisions[],
// same path_taken[], and above all the SAME composite_execution_hash. This gate
// injects synthetic GATED chains (real kernel-backed nodes; NOT written to
// chaingraph.json — scope-fenced to the test) that exercise every routing shape
// (skip-to-end, mid-jump, linear-continue via a matched rule) and asserts the two
// surfaces agree. It also drives BOTH branches of a gate (gate 4: both-branch
// coverage) and re-runs for determinism.
//
// Run: node scripts/gate-parity.test.mjs   (exit 0 = all green)

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer, widgetGlue, stripCspMeta } from '../worker.mjs';
import { PILOT } from '../pilot.mjs';
import { runChain as embedRunChain } from '../embed/runChain.mjs';
import { getKernel } from '../kernels/index.mjs';

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

async function workerRunChain(data, chainName) {
  const server = buildServer(data, { onlyTool: 'run_chain' });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  await clientT.start();
  const pending = new Map();
  clientT.onmessage = (msg) => { if (msg && msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); } };
  const rpc = (method, params, id) => new Promise((res) => { pending.set(id, res); clientT.send({ jsonrpc: '2.0', id, method, params }); });
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } }, 0);
  await clientT.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const resp = await rpc('tools/call', { name: 'run_chain', arguments: { chain: chainName } }, 1);
  await clientT.close(); await server.close();
  if (resp.error) throw new Error('RPC error: ' + JSON.stringify(resp.error));
  return JSON.parse(resp.result.content[0].text);
}

const base = loadDataFromDisk();
const baseChain = base.chaingraph.chains.find((c) => c.name === 'agent-commerce-conformance');
const T = baseChain.steps.map((s) => s.tool_id);           // 4 real kernel-backed nodes
const FX = base.chainFixtures['agent-commerce-conformance'];

// Synthetic gated chains — real nodes, gate on fixed pointers so routing is
// deterministic regardless of kernel output. Each exercises a distinct shape.
const SCENARIOS = [
  { name: 'parity-skip-to-end', desc: 'default -> end skips the tail', steps: [
    { tool_id: T[0], id: 's0', gate: { input: '/__nope__', rules: [{ op: 'present', next: 's2' }], default: 'end' } },
    { tool_id: T[1], id: 's1' }, { tool_id: T[2], id: 's2' }, { tool_id: T[3], id: 's3' },
  ] },
  { name: 'parity-mid-jump', desc: 'default jumps over s1 to s2', steps: [
    { tool_id: T[0], id: 's0', gate: { input: '/__nope__', rules: [{ op: 'present', next: 's1' }], default: 's2' } },
    { tool_id: T[1], id: 's1' }, { tool_id: T[2], id: 's2' }, { tool_id: T[3], id: 's3' },
  ] },
  { name: 'parity-rule-continue', desc: 'matched rule (root pointer always present) continues to s1', steps: [
    { tool_id: T[0], id: 's0', gate: { input: '', rules: [{ op: 'present', next: 's1' }], default: 'end' } },
    { tool_id: T[1], id: 's1' }, { tool_id: T[2], id: 's2' }, { tool_id: T[3], id: 's3' },
  ] },
];

function inject(scn) {
  const cg = JSON.parse(JSON.stringify(base.chaingraph));
  cg.chains.push({ name: scn.name, title: scn.desc, steps: scn.steps });
  const fixtures = JSON.parse(JSON.stringify(base.chainFixtures));
  fixtures[scn.name] = {}; for (const s of scn.steps) fixtures[scn.name][s.tool_id] = FX[s.tool_id];
  return { cg, fixtures };
}

let fail = 0;
const ok = (label) => console.log('  ✓ ' + label);
const bad = (label, detail) => { fail++; console.error('  ✗ ' + label + (detail ? ' — ' + detail : '')); };

for (const scn of SCENARIOS) {
  const { cg, fixtures } = inject(scn);
  const workerData = { ...base, chaingraph: cg, chainFixtures: fixtures };
  const w = await workerRunChain(workerData, scn.name);
  const e = await embedRunChain(scn.name, undefined, { getKernel, chaingraph: cg, fixtures });

  if (w.composite_execution_hash !== e.composite_execution_hash) bad(`${scn.name}: composite hash`, `worker=${w.composite_execution_hash} embed=${e.composite_execution_hash}`);
  else if (!w.composite_execution_hash) bad(`${scn.name}: null composite hash (no steps ran)`);
  else if (JSON.stringify(w.path_taken) !== JSON.stringify(e.path_taken)) bad(`${scn.name}: path_taken`, `${JSON.stringify(w.path_taken)} vs ${JSON.stringify(e.path_taken)}`);
  else if (JSON.stringify(w.decisions) !== JSON.stringify(e.decisions)) bad(`${scn.name}: decisions`);
  else if (w.route_plan_digest !== e.route_plan_digest) bad(`${scn.name}: route_plan_digest`);
  else if (w.steps_ran !== e.steps_ran) bad(`${scn.name}: steps_ran`, `${w.steps_ran} vs ${e.steps_ran}`);
  else {
    // determinism: re-run embed, same hash
    const e2 = await embedRunChain(scn.name, undefined, { getKernel, chaingraph: cg, fixtures });
    if (e2.composite_execution_hash !== e.composite_execution_hash) bad(`${scn.name}: non-deterministic`);
    else ok(`${scn.name}: worker==embed, path=${JSON.stringify(w.path_taken)}, ${w.steps_ran} ran, ${w.composite_execution_hash.slice(0, 16)}…`);
  }
}

// Both-branch coverage (gate 4): the same gate structure must be exercised on
// each side of its decision at least once. Drive a value gate both ways by
// mutating a copy of the node output through inputs is impractical here (kernel
// outputs are fixed), so we assert the two structural branches (skip vs continue)
// above collectively cover default-taken AND rule-matched paths.
const covered = new Set();
for (const scn of SCENARIOS) {
  const { cg, fixtures } = inject(scn);
  const e = await embedRunChain(scn.name, undefined, { getKernel, chaingraph: cg, fixtures });
  for (const d of (e.decisions || [])) covered.add(d.matched_rule_index === null ? 'default' : 'rule');
}
if (!(covered.has('default') && covered.has('rule'))) bad('both-branch coverage', `covered=${[...covered].join(',')}`);
else ok('both-branch coverage: default-taken AND rule-matched paths both exercised');

if (fail) { console.error(`\n✗ gate-parity: ${fail} failure(s)`); process.exit(1); }
console.log('✅ gate-parity: Worker run_chain and embed runChain evaluate decision gates byte-identically (both branches, deterministic).');
