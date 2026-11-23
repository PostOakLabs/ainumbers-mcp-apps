#!/usr/bin/env node
// hash-refusal-null-hash-guards.test.mjs — HASH-REFUSAL-WORKER-GUARDS-1 done-criteria.
//
// HASH-REFUSAL-SHARED-1 will make executionHash return null on unhashable input (e.g. a
// BigInt output payload) instead of throwing. A kernel whose buildArtifact then returns
// execution_hash: null must be REFUSED everywhere — never served as hash-verified, never
// recorded ok, never threaded as a parent hash:
//   - both Mode 4 tools/call handlers (emit_chaingraph_artifact + the per-node delegation
//     tool) report hash_valid: false. Muse's simulation of the old line under the new
//     hasher: `recomputed === artifact.execution_hash` evaluates null === null → true.
//   - both run_chain engines (worker.mjs + embed/runChain.mjs) record the step as
//     refused_input (carrying hash_refusal when the artifact has one), never ok; the null
//     hash never joins the composite (steps, parent_hashes) and the chain still continues.
//
// With TODAY's throwing _hash.mjs these guards are inert on real kernels (buildArtifact can
// only produce a real hash or throw), so each case drives a STUB kernel whose buildArtifact
// returns execution_hash: null with hashable content — the exact artifact shape the new
// hasher would produce. Worker-side stubs are patched into the KERNELS registry and restored
// in finally; embed-side stubs arrive through the injectable deps.getKernel (no mutation).
//
//   node --test tests/hash-refusal-null-hash-guards.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer, widgetGlue, stripCspMeta } from '../worker.mjs';
import { runChain as embeddedRunChain } from '../embed/runChain.mjs';
import { KERNELS, getKernel as realGetKernel } from '../kernels/index.mjs';
import { PILOT } from '../pilot.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = resolve(ROOT, 'data');
const get = (p) => readFileSync(resolve(DATA, p), 'utf8');
const glue = widgetGlue(get('ext-apps-inline.js'));
function loadData() {
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
const data = loadData();

async function mcp(onlyTool) {
  const server = buildServer(data, { onlyTool });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  await clientT.start();
  let id = 1;
  const rpc = (method, params) => new Promise((res) => {
    const cur = id++;
    clientT.onmessage = (msg) => { if (msg && msg.id === cur) { clientT.onmessage = null; res(msg); } };
    clientT.send({ jsonrpc: '2.0', id: cur, method, params });
  });
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'hash-refusal-null-hash-guards-test', version: '1' } });
  await clientT.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  return {
    call: (name, args) => rpc('tools/call', { name, arguments: args }),
    close: () => clientT.close(),
  };
}

const CHAIN = '2052a-classify-daily';
const TOOL_ID = 'art-437-fr2052a-inflow-outflow-classifier';
const MCP_NAME = 'compute_fr2052a_inflow_outflow_classification';
const VALID_PP = data.chainFixtures[CHAIN][TOOL_ID];

const MULTI_CHAIN = 'agent-commerce-conformance';
const MULTI_T = data.chaingraph.chains.find((c) => c.name === MULTI_CHAIN).steps.map((s) => s.tool_id);

// Null-hash stub: hashable policy_parameters/output_payload (passes the kernel-invoke input
// pre-check; nothing throws under today's hasher) but the artifact's own hash is null — the
// exact shape a buildArtifact produces once executionHash returns null on its output.
function nullHashStub(extra = {}) {
  return {
    buildArtifact: async (pp, opts) => ({
      '@context': 'https://ainumbers.co/chaingraph/context/v0.3/context.jsonld',
      chaingraph_version: '0.4.0',
      mandate_type: 'compliance_control',
      tool_id: TOOL_ID,
      tool_version: '1.0.0',
      generated_at: '1970-01-01T00:00:00.000Z',
      execution_hash: null,
      chain: { parent_hashes: opts?.parent_hashes ?? [], parent_tool_ids: opts?.parent_tool_ids ?? [], chain_depth: opts?.chain_depth ?? 0 },
      policy_parameters: pp,
      output_payload: { echo: 'unhashable-under-hash-refusal-shared-1' },
      compliance_flags: [],
      audit_signature: null,
      ...extra,
    }),
  };
}

async function withStubbedKernel(toolId, stub, fn) {
  const real = KERNELS[toolId];
  KERNELS[toolId] = stub;
  try { return await fn(); } finally { if (real === undefined) delete KERNELS[toolId]; else KERNELS[toolId] = real; }
}

// ── Mode 4 handler #1: emit_chaingraph_artifact ────────────────────────────────────────────────

test('Mode 4 emit_chaingraph_artifact: a null-hash kernel artifact reports hash_valid false', async () => {
  const client = await mcp('emit_chaingraph_artifact');
  try {
    await withStubbedKernel(TOOL_ID, nullHashStub(), async () => {
      const r = await client.call('emit_chaingraph_artifact', { tool_id: TOOL_ID, policy_parameters: VALID_PP, compute: 'server' });
      assert.equal(r.error, undefined, 'no RPC error');
      const sc = r.result.structuredContent;
      assert.equal(sc.mode, 'server_compute', 'reached the server-compute path');
      assert.equal(sc.artifact.execution_hash, null, 'stub artifact served with a null hash');
      assert.equal(sc.hash_valid, false, 'null execution_hash must never verify (null === null trap)');
      assert.notEqual(sc.computed_hash, null, 'recomputed hash of the hashable payload is a real digest');
    });
  } finally { client.close(); }
});

// ── Mode 4 handler #2: the per-node delegation tool ────────────────────────────────────────────

test('Mode 4 delegation tool: a null-hash kernel artifact reports hash_valid false', async () => {
  const client = await mcp(MCP_NAME);
  try {
    await withStubbedKernel(TOOL_ID, nullHashStub(), async () => {
      const r = await client.call(MCP_NAME, { policy_parameters: VALID_PP, compute: 'server' });
      assert.equal(r.error, undefined, 'no RPC error');
      const sc = r.result.structuredContent;
      assert.equal(sc.compute_mode, 'server', 'reached the server-compute path');
      assert.equal(sc.artifact.execution_hash, null, 'stub artifact served with a null hash');
      assert.equal(sc.hash_valid, false, 'null execution_hash must never verify (null === null trap)');
    });
  } finally { client.close(); }
});

// ── run_chain (worker): null-hash step is refused_input, never ok ─────────────────────────────

test('run_chain(worker): a null-hash step is refused_input with its hash_refusal, and the chain still continues', async () => {
  const client = await mcp('run_chain');
  try {
    const stub = nullHashStub({ hash_refusal: { reason: 'REFUSED_INPUT_UNSAFE_NUMBER', detail: 'output_payload.total: bigint' } });
    await withStubbedKernel(MULTI_T[0], stub, async () => {
      const r = await client.call('run_chain', { chain: MULTI_CHAIN });
      assert.equal(r.error, undefined, 'no RPC error');
      const sc = r.result?.structuredContent ?? JSON.parse(r.result?.content?.[0]?.text ?? '{}');
      const step0 = sc.steps.find((s) => s.tool_id === MULTI_T[0]);
      assert.equal(step0.status, 'refused_input', 'null-hash step must be refused_input, never ok');
      assert.equal(step0.execution_hash, null);
      assert.deepEqual(step0.hash_refusal, { reason: 'REFUSED_INPUT_UNSAFE_NUMBER', detail: 'output_payload.total: bigint' });
      // the run continues on the remaining steps (fixture inputs), none poisoned by the null
      assert.equal(sc.steps_ran, MULTI_T.length - 1, 'only the real-hash steps ran');
      assert.equal(sc.steps.filter((s) => s.status === 'ok').length, MULTI_T.length - 1);
      assert.ok(sc.composite_execution_hash && /^[0-9a-f]{64}$/.test(sc.composite_execution_hash), 'composite hash is a real digest');
      assert.ok(!sc.composite_artifact.chain.parent_hashes.includes(null), 'no null parent hash in the composite');
      for (const s of sc.composite_artifact.output_payload.steps) {
        assert.ok(/^[0-9a-f]{64}$/.test(s.execution_hash), 'composite step carries a real hash: ' + s.tool_id);
      }
    });
  } finally { client.close(); }
});

test('run_chain(worker): a null-hash step whose artifact carries no hash_refusal records none', async () => {
  const client = await mcp('run_chain');
  try {
    await withStubbedKernel(TOOL_ID, nullHashStub(), async () => {
      const r = await client.call('run_chain', { chain: CHAIN, inputs: { [TOOL_ID]: VALID_PP } });
      const sc = r.result?.structuredContent ?? JSON.parse(r.result?.content?.[0]?.text ?? '{}');
      const step = sc.steps.find((s) => s.tool_id === TOOL_ID);
      assert.equal(step.status, 'refused_input');
      assert.equal(step.execution_hash, null);
      assert.equal('hash_refusal' in step, false, 'no hash_refusal invented for an artifact without one');
      assert.equal(sc.steps_ran, 0, 'nothing ran');
      assert.equal(sc.composite_execution_hash, null, 'no composite over zero ran steps');
    });
  } finally { client.close(); }
});

// ── run_chain (embed): mirror of the worker engine ─────────────────────────────────────────────

test('run_chain(embed): a null-hash step is refused_input with its hash_refusal, and the chain still continues', async () => {
  const stub = nullHashStub({ hash_refusal: { reason: 'REFUSED_INPUT_UNSAFE_NUMBER', detail: 'output_payload.total: bigint' } });
  const deps = {
    getKernel: (tid) => (tid === MULTI_T[0] ? stub : realGetKernel(tid)),
    chaingraph: data.chaingraph,
    fixtures: data.chainFixtures,
  };
  const out = await embeddedRunChain(MULTI_CHAIN, undefined, deps);
  const step0 = out.steps.find((s) => s.tool_id === MULTI_T[0]);
  assert.equal(step0.status, 'refused_input', 'null-hash step must be refused_input, never ok');
  assert.equal(step0.execution_hash, null);
  assert.deepEqual(step0.hash_refusal, { reason: 'REFUSED_INPUT_UNSAFE_NUMBER', detail: 'output_payload.total: bigint' });
  assert.equal(out.steps_ran, MULTI_T.length - 1, 'only the real-hash steps ran');
  assert.ok(out.composite_execution_hash && /^[0-9a-f]{64}$/.test(out.composite_execution_hash), 'composite hash is a real digest');
  assert.ok(!out.composite_artifact.chain.parent_hashes.includes(null), 'no null parent hash in the composite');
  for (const s of out.composite_artifact.output_payload.steps) {
    assert.ok(/^[0-9a-f]{64}$/.test(s.execution_hash), 'composite step carries a real hash: ' + s.tool_id);
  }
});

test('run_chain(embed): a null-hash step whose artifact carries no hash_refusal records none', async () => {
  const deps = {
    getKernel: (tid) => (tid === TOOL_ID ? nullHashStub() : realGetKernel(tid)),
    chaingraph: data.chaingraph,
    fixtures: data.chainFixtures,
  };
  const out = await embeddedRunChain(CHAIN, { [TOOL_ID]: VALID_PP }, deps);
  const step = out.steps.find((s) => s.tool_id === TOOL_ID);
  assert.equal(step.status, 'refused_input');
  assert.equal(step.execution_hash, null);
  assert.equal('hash_refusal' in step, false, 'no hash_refusal invented for an artifact without one');
  assert.equal(out.steps_ran, 0, 'nothing ran');
  assert.equal(out.composite_execution_hash, null, 'no composite over zero ran steps');
});
