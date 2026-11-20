#!/usr/bin/env node
// kernel-invoke-refusal.test.mjs — KERNEL-REFUSAL-BOUNDARY-WORKER-1 done-criteria.
//
// The worker refuses unhashable INPUT before a kernel is called, with ONE result shape on all
// four registry call sites: the two tools/call handlers (emit_chaingraph_artifact and the
// per-node delegation tool), run_chain in worker.mjs, and the embedded runChain.
//
//   node --test tests/kernel-invoke-refusal.test.mjs
//
// The pinned execution_hash / artifact-byte digests below were measured on origin/master
// @ 4834411a in a detached worktree BEFORE this change, with only the wall-clock `generated_at`
// member normalised (it is hash-excluded by construction). They must not move.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { invokeKernel } from '../kernel-invoke.mjs';
import { buildServer, widgetGlue, stripCspMeta } from '../worker.mjs';
import { runChain as embeddedRunChain } from '../embed/runChain.mjs';
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
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'kernel-invoke-refusal-test', version: '1' } });
  await clientT.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  return {
    call: (name, args) => rpc('tools/call', { name, arguments: args }),
    close: () => clientT.close(),
  };
}

const deep = (n) => { let v = { leaf: 1 }; for (let i = 0; i < n; i++) v = { k: v }; return v; };
const JUNK = [
  ['NaN', NaN, 'REFUSED_INPUT_UNSAFE_NUMBER', 'non_finite'],
  ['-Infinity', -Infinity, 'REFUSED_INPUT_UNSAFE_NUMBER', 'non_finite'],
  ['1e300', 1e300, 'REFUSED_INPUT_UNSAFE_NUMBER', 'unsafe_integer'],
  ['unsafe-integer', 9007199254740993, 'REFUSED_INPUT_UNSAFE_NUMBER', 'unsafe_integer'],
  ['depth-600', deep(600), 'REFUSED_INPUT_HASH_LIMIT', 'too_deep'],
  ['more-than-1e6-values', Array.from({ length: 1000001 }, () => 1), 'REFUSED_INPUT_HASH_LIMIT', 'too_many_values'],
  ['BigInt', 10n, 'REFUSED_INPUT_UNSAFE_NUMBER', 'bigint'],
];

const CHAIN = '2052a-classify-daily';
const TOOL_ID = 'art-437-fr2052a-inflow-outflow-classifier';
const MCP_NAME = 'compute_fr2052a_inflow_outflow_classification';
const VALID_PP = data.chainFixtures[CHAIN][TOOL_ID];

// ── helper contract ─────────────────────────────────────────────────────────────────────────────

test('invokeKernel refuses every junk input WITHOUT calling the kernel, naming a path not the value', async () => {
  for (const [label, value, reason, suffix] of JUNK) {
    let called = 0;
    const spy = { buildArtifact: async () => { called++; return { ok: true }; } };
    const out = await invokeKernel(spy, { junk_field: value }, { now: 'fixed' });
    assert.equal(called, 0, label + ': kernel must not be called');
    assert.equal(out.refused, true, label);
    assert.equal(out.execution_hash, null, label);
    assert.equal(out.hash_refusal.reason, reason, label);
    assert.match(out.hash_refusal.detail, /^policy_parameters\.junk_field/, label);
    assert.ok(out.hash_refusal.detail.endsWith(': ' + suffix), label + ': ' + out.hash_refusal.detail);
    assert.ok(!JSON.stringify(out).includes(String(value)), label + ': value must not be echoed');
  }
});

test('invokeKernel calls the kernel with the unchanged input/options and returns its artifact', async () => {
  const artifact = { execution_hash: 'abc', output_payload: { ok: true } };
  let seen;
  const spy = { buildArtifact: async (pp, opts) => { seen = { pp, opts }; return artifact; } };
  const pp = { a: 1 }, opts = { now: 'fixed', chain_depth: 0 };
  assert.strictEqual(await invokeKernel(spy, pp, opts), artifact);
  assert.strictEqual(seen.pp, pp);
  assert.strictEqual(seen.opts, opts);
});

test('a kernel that already returns its own hash_refusal passes through untouched', async () => {
  const refused = { hash_refusal: { reason: 'REFUSED_INPUT_WRONG_TYPE', detail: 'policy_parameters.x: wrong_type' } };
  const spy = { buildArtifact: async () => refused };
  assert.strictEqual(await invokeKernel(spy, { x: 1 }, {}), refused);
});

test('any other throw from the kernel is rethrown unchanged', async () => {
  const boom = new Error('missing required field');
  const spy = { buildArtifact: async () => { throw boom; } };
  await assert.rejects(invokeKernel(spy, { x: 1 }, {}), (e) => e === boom);
});

// ── path A + B: the two tools/call handlers ────────────────────────────────────────────────────

for (const [path, tool, argsFor] of [
  ['A emit_chaingraph_artifact', 'emit_chaingraph_artifact', (pp) => ({ tool_id: TOOL_ID, policy_parameters: pp, compute: 'server' })],
  ['B per-node delegation tool', MCP_NAME, (pp) => ({ policy_parameters: pp, compute: 'server' })],
]) {
  test(path + ': every junk input returns one consistent tool.input_refused result', async () => {
    const client = await mcp(tool);
    try {
      for (const [label, value, reason, suffix] of JUNK) {
        const r = await client.call(tool, argsFor({ junk_field: value }));
        assert.equal(r.error, undefined, label + ': no RPC error');
        const res = r.result;
        assert.equal(res.isError, true, label);
        const sc = res.structuredContent;
        assert.equal(sc.error.name, 'tool.input_refused', label);
        assert.equal(sc.error.code, -32602, label);
        assert.equal(sc.error.data.reason, 'input_refused', label);
        assert.equal(sc.tool_id, TOOL_ID, label);
        assert.equal(sc.execution_hash, null, label);
        assert.equal(sc.hash_refusal.reason, reason, label);
        assert.ok(sc.hash_refusal.detail.endsWith(': ' + suffix), label + ': ' + sc.hash_refusal.detail);
        assert.ok(!JSON.stringify(sc).includes(String(value)), label + ': value must not be echoed');
      }
    } finally { client.close(); }
  });
}

// ── path C + D: the two run_chain engines ──────────────────────────────────────────────────────

test('C run_chain(worker): junk is refused_input with hash_refusal, never input_required', async () => {
  const client = await mcp('run_chain');
  try {
    for (const [label, value, reason, suffix] of JUNK) {
      const r = await client.call('run_chain', { chain: CHAIN, inputs: { [TOOL_ID]: { junk_field: value } } });
      assert.equal(r.error, undefined, label + ': no RPC error');
      const sc = r.result?.structuredContent ?? JSON.parse(r.result?.content?.[0]?.text ?? '{}');
      const step = sc.steps.find((s) => s.tool_id === TOOL_ID);
      assert.equal(step.status, 'refused_input', label);
      assert.equal(step.hash_refusal.reason, reason, label);
      assert.ok(step.hash_refusal.detail.endsWith(': ' + suffix), label);
      assert.equal(step.execution_hash, null, label);
    }
  } finally { client.close(); }
});

test('D run_chain(embed): junk is refused_input with hash_refusal, never input_required', async () => {
  for (const [label, value, reason, suffix] of JUNK) {
    const out = await embeddedRunChain(CHAIN, { [TOOL_ID]: { junk_field: value } });
    const step = out.steps.find((s) => s.tool_id === TOOL_ID);
    assert.equal(step.status, 'refused_input', label);
    assert.equal(step.hash_refusal.reason, reason, label);
    assert.ok(step.hash_refusal.detail.endsWith(': ' + suffix), label);
    assert.equal(step.execution_hash, null, label);
  }
});

// ── missing input is still input_required ──────────────────────────────────────────────────────

const MISSING_CHAIN = 'agent-commerce-conformance';
const MISSING_TOOL = 'art-01-ap2-mandate-chain-validator';

test('a missing input in run_chain is still input_required (worker and embed)', async () => {
  const client = await mcp('run_chain');
  try {
    const r = await client.call('run_chain', { chain: MISSING_CHAIN, inputs: { [MISSING_TOOL]: {} } });
    const sc = r.result?.structuredContent ?? JSON.parse(r.result?.content?.[0]?.text ?? '{}');
    assert.equal(sc.steps.find((s) => s.tool_id === MISSING_TOOL).status, 'input_required');
  } finally { client.close(); }
  const out = await embeddedRunChain(MISSING_CHAIN, { [MISSING_TOOL]: {} });
  assert.equal(out.steps.find((s) => s.tool_id === MISSING_TOOL).status, 'input_required');
});

// ── valid inputs are byte-identical to origin/master ──────────────────────────────────────────

const PINNED = [
  ['art-437-fr2052a-inflow-outflow-classifier', '76ec05589a21d47565e2b913cfb2a575620e48317ced5f6016b7f2d1fac8c038', '7d8ef2e5ad817f8c71568e8973de9409605cb667c5fd264b9537ab9bad23941c'],
  ['art-60-agent-economy-runtime-fit-diagnostic', '15cb34031f9e7cf99e9200ccf41d6bb802d616a7c5c1c4d96666dc1d9189a556', '5f17786a7fe1c96245b7686544afa3d44277134b23885b543d257563e7324466'],
  ['art-64-ai-act-highrisk-fit-diagnostic', '0dadfdae56e130861776eac131bc8386712f02d5a50b1f347c1cb94d101d7494', '76da13ed4d9fa532219949023fa21fb069a0a39ed0eb8616ccecd62224efd305'],
  ['art-286-anchored-extract-verifier', 'fef32118493ab6984f89947ed6758b88443555423873e659e9c333adc6966633', 'a9c234a290f754cf04db5092a30e029c37c24bbeeecfc1b7e9d825b5844cd244'],
  ['art-42-arc-fit-diagnostic', '9d67f24ecdc2097d2a78f9ada4aac4b58fd0a533f91345dd76344cb78fde08f5', '99540eafc8ec4645e7caecc34e51385321c863d1a5ee82abfe349ed9e8f9298d'],
];

test('5 valid tools keep the same execution_hash and the same artifact bytes', async () => {
  const client = await mcp('emit_chaingraph_artifact');
  try {
    for (const [tid, hash, digest] of PINNED) {
      const pp = Object.values(data.chainFixtures).find((byTool) => byTool?.[tid])[tid];
      const r = await client.call('emit_chaingraph_artifact', { tool_id: tid, policy_parameters: pp, compute: 'server' });
      assert.equal(r.result?.isError, undefined, tid + ': no tool error');
      const art = r.result.structuredContent.artifact;
      assert.equal(art.execution_hash, hash, tid + ': execution_hash moved');
      const stable = { ...art, generated_at: '<fixed>' };
      assert.equal(createHash('sha256').update(JSON.stringify(stable)).digest('hex'), digest, tid + ': artifact bytes moved');
    }
  } finally { client.close(); }
});

test('a refused step cannot poison chain-level hashing (no null execution_hash is hashed)', async () => {
  const client = await mcp('run_chain');
  try {
    const r = await client.call('run_chain', {
      chain: MISSING_CHAIN,
      inputs: { [MISSING_TOOL]: { junk_field: NaN } },
    });
    const sc = r.result?.structuredContent ?? JSON.parse(r.result?.content?.[0]?.text ?? '{}');
    assert.equal(sc.steps.find((s) => s.tool_id === MISSING_TOOL).status, 'refused_input');
    assert.ok(sc.composite_execution_hash && /^[0-9a-f]{64}$/.test(sc.composite_execution_hash));
    const compositeOutput = sc.composite_artifact?.output_payload;
    assert.ok(compositeOutput, 'composite artifact present');
    for (const step of compositeOutput.steps) {
      assert.ok(/^[0-9a-f]{64}$/.test(step.execution_hash), 'only ran steps, each with a real hash: ' + JSON.stringify(step));
    }
  } finally { client.close(); }
});
