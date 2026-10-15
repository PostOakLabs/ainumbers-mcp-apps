#!/usr/bin/env node
// test-verify-composite.mjs — PR-W1: verify_execution_hash is composite-aware (SPEC §21.2/§21.4).
//
// Proves, through the real worker (InMemoryTransport):
//   1. a SERVED run_chain composite_artifact (carrying hash-excluded decision_trail /
//      step_compliance_flags / non_live_steps / escalation_record) verifies valid, rule composite-§21.2;
//   2. tampering a step's output_payload flips it to invalid;
//   3. a plain node artifact still verifies under rule node-§6 (path unchanged);
//   4. a node artifact that merely carries a `steps` array but no chain markers stays on §6.
// NOTE (not a gate change): non_live_steps / decision_trail are served adjacent metadata and are
// dropped by the allowlist; the composite-flag carry gate is intentionally untouched here.
//
// Usage: node scripts/test-verify-composite.mjs

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

async function withServer(data, fn) {
  const server = buildServer(data);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  await clientT.start();
  const pending = new Map();
  clientT.onmessage = (msg) => {
    if (msg && msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  };
  let nextId = 2;
  const rpc = (method, params, id) => new Promise((res) => { pending.set(id, res); clientT.send({ jsonrpc: '2.0', id, method, params }); });
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'verify-composite-test', version: '1' } }, 0);
  await clientT.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const call = async (name, args) => {
    const resp = await rpc('tools/call', { name, arguments: args }, nextId++);
    if (resp.error) throw new Error('RPC error: ' + JSON.stringify(resp.error));
    if (resp.result?.isError) throw new Error('tool error: ' + resp.result?.content?.[0]?.text);
    return JSON.parse(resp.result.content[0].text);
  };
  try { return await fn(call); } finally { await clientT.close(); await server.close(); }
}

let failed = 0;
const check = (cond, msg) => { if (cond) console.log(`  ✓ ${msg}`); else { console.error(`  ✗ ${msg}`); failed++; } };

const data = loadDataFromDisk();
await withServer(data, async (call) => {
  // Linear chain and a gated chain with escalation (adjacent metadata present).
  for (const chain of ['agent-commerce-conformance', 'adverse-action-notice-compliance', 'dora-escalation-demo']) {
    const res = await call('run_chain', { chain });
    const art = res.composite_artifact;
    if (!art) { check(false, `${chain}: no composite_artifact`); continue; }
    const extras = ['decision_trail', 'step_compliance_flags', 'non_live_steps', 'escalation_record'].filter((k) => k in art.output_payload);
    console.log(`  chain ${chain}: adjacent members served in payload: [${extras.join(', ')}]`);
    const v = await call('verify_execution_hash', { artifact: art });
    check(v.valid === true && v.rule === 'composite-§21.2', `${chain}: served composite verifies (rule ${v.rule})`);

    // Tamper a step's output_payload.
    const bad = JSON.parse(JSON.stringify(art));
    bad.output_payload.steps[0].output_payload = { ...bad.output_payload.steps[0].output_payload, __tamper: 1 };
    const vb = await call('verify_execution_hash', { artifact: bad });
    check(vb.valid === false && vb.rule === 'composite-§21.2', `${chain}: tampered step flips to invalid`);
  }

  // Node artifact stays on §6.
  const pp = { a: 1, b: [2, 3] }, op = { result: 'x', n: 5 };
  const h = await executionHash(pp, op);
  const vn = await call('verify_execution_hash', { artifact: { policy_parameters: pp, output_payload: op, execution_hash: h } });
  check(vn.valid === true && vn.rule === 'node-§6', 'node artifact verifies under node-§6');

  // A node whose payload merely has a steps array (no chain markers in policy) is NOT composite.
  const pp2 = { a: 1 }, op2 = { steps: [1, 2], extra: 'kept' };
  const h2 = await executionHash(pp2, op2);
  const vn2 = await call('verify_execution_hash', { policy_parameters: pp2, output_payload: op2, claimed_hash: h2 });
  check(vn2.valid === true && vn2.rule === 'node-§6', 'node payload with a steps array but no chain markers stays on node-§6');

  // String `chain` + `steps` array but no step_tool_ids: NOT composite, stays on node-§6.
  const pp3 = { chain: 'x', a: 1 }, op3 = { chain: 'x', steps: [1], extra: 'kept' };
  const h3 = await executionHash(pp3, op3);
  const vn3 = await call('verify_execution_hash', { policy_parameters: pp3, output_payload: op3, claimed_hash: h3 });
  check(vn3.valid === true && vn3.rule === 'node-§6', 'string chain + steps array without step_tool_ids stays on node-§6');
});

if (failed) { console.error(`\n✗ ${failed} check(s) failed`); process.exit(1); }
console.log('\n✓ verify_execution_hash composite-aware: all checks passed');
