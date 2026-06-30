#!/usr/bin/env node
// test-run-chain-fixtures.mjs — e2e verification of OCGR Phase A (vendor fixture defaults).
//
// Drives run_chain via InMemoryTransport with NO inputs for a fully kernel-backed chain.
// Asserts:
//   - steps_ran === step_count  (all steps executed)
//   - every step inputs_source === "fixture"
//   - composite_execution_hash is a non-null hex string
//   - two runs produce the SAME composite_execution_hash (determinism)
//
// Usage: node scripts/test-run-chain-fixtures.mjs [chain-name]
//   default chain: agent-commerce-conformance

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer, widgetGlue, stripCspMeta } from '../worker.mjs';
import { PILOT } from '../pilot.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = resolve(ROOT, 'data');

// Mirror precompute-discovery.mjs loadDataFromDisk — must include chainFixtures.
function loadDataFromDisk() {
  const get = (p) => readFileSync(resolve(DATA, p), 'utf8');
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

async function runChain(data, chainName) {
  const server = buildServer(data, { onlyTool: 'run_chain' });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  await clientT.start();

  const pending = new Map();
  clientT.onmessage = (msg) => {
    if (msg && msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  };
  const rpc = (method, params, id) => new Promise((resolve) => {
    pending.set(id, resolve);
    clientT.send({ jsonrpc: '2.0', id, method, params });
  });

  await rpc('initialize', {
    protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e-test', version: '1' },
  }, 0);
  await clientT.send({ jsonrpc: '2.0', method: 'notifications/initialized' });

  const resp = await rpc('tools/call', {
    name: 'run_chain',
    arguments: { chain: chainName },  // NO inputs
  }, 1);

  await clientT.close();
  await server.close();

  if (resp.error) throw new Error('RPC error: ' + JSON.stringify(resp.error));
  if (resp.result?.isError) throw new Error('Tool error: ' + resp.result?.content?.[0]?.text);

  const text = resp.result?.content?.[0]?.text;
  if (!text) throw new Error('Empty response');
  return JSON.parse(text);
}

async function main() {
  const chainName = process.argv[2] ?? 'agent-commerce-conformance';
  console.log(`\n▶ e2e test: run_chain("${chainName}") with NO inputs\n`);

  const data = loadDataFromDisk();

  // Verify the chain is in chain-fixtures
  if (!data.chainFixtures?.[chainName]) {
    console.error(`✗ chain "${chainName}" not found in data/chain-fixtures.json`);
    process.exit(1);
  }

  // Run 1
  console.log('  Run 1…');
  const r1 = await runChain(data, chainName);

  // Run 2
  console.log('  Run 2…');
  const r2 = await runChain(data, chainName);

  let failed = 0;

  // Assert steps_ran === step_count
  const check = (label, pass, detail) => {
    if (pass) { console.log(`  ✓ ${label}`); }
    else { console.error(`  ✗ ${label}${detail ? ': ' + detail : ''}`); failed++; }
  };

  check('steps_ran === step_count (run 1)', r1.steps_ran === r1.step_count,
    `steps_ran=${r1.steps_ran} step_count=${r1.step_count}`);

  // Assert all steps inputs_source === "fixture"
  const nonFixture1 = (r1.steps ?? []).filter((s) => s.inputs_source !== 'fixture');
  check('all steps inputs_source "fixture" (run 1)', nonFixture1.length === 0,
    nonFixture1.map((s) => `${s.tool_id}:${s.inputs_source}`).join(', '));

  // Assert composite hash is non-null hex
  const hashOk = typeof r1.composite_execution_hash === 'string' && /^[0-9a-f]{64}$/.test(r1.composite_execution_hash);
  check('composite_execution_hash is 64-char hex', hashOk, r1.composite_execution_hash ?? 'null');

  // Assert determinism
  check('two runs produce identical composite_execution_hash',
    r1.composite_execution_hash === r2.composite_execution_hash,
    `run1=${r1.composite_execution_hash} run2=${r2.composite_execution_hash}`);

  // Summary
  console.log(`\n  chain: ${chainName}`);
  console.log(`  steps: ${r1.steps_ran}/${r1.step_count}`);
  console.log(`  hash:  ${r1.composite_execution_hash}`);
  console.log(`  steps detail:`);
  for (const s of r1.steps ?? []) {
    console.log(`    [${s.order}] ${s.tool_id}: status=${s.status} inputs_source=${s.inputs_source} hash=${s.execution_hash?.slice(0,16)}…`);
  }

  if (failed) {
    console.error(`\n✗ ${failed} assertion(s) FAILED`);
    process.exit(1);
  }
  console.log(`\n✅ all assertions passed — Phase A fixture defaults working`);
}

main().catch((err) => {
  console.error('✗ e2e test ERROR:', err);
  process.exit(1);
});
