#!/usr/bin/env node
// null-normalize.test.mjs — MR-R4-NULL-NORMALIZE-WORKER-1 done-criteria.
//
// Gates (from the row):
//   - normalizeNullMembers: zero-dep, unit coverage for depth, array-element preservation and
//     idempotence, input non-mutation, and the x_null_distinct manifest opt-out (one case).
//   - both worker call sites normalize before buildArtifact: a null-carrying tools/call and its
//     null-free twin return the IDENTICAL execution_hash, driven through the real MCP surface
//     (buildServer + InMemoryTransport) on BOTH dispatch paths — the per-node delegation tool
//     (worker.mjs ~5100) and emit_chaingraph_artifact Mode 4 (worker.mjs ~3264).
//
// The probe tool is art-215-reg-z-appendix-j-apr: the design note's severe shape, where an explicit
// `periods_per_year: null` silently turned a disclosed 11.9961 % APR into 0.9997 % with
// "converged":true still asserted (Number(null)===0 passes the finiteness check).
//
// Usage: node --test tests/null-normalize.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { normalizeNullMembers } from '../_null_normalize.mjs';
import { buildServer, widgetGlue, stripCspMeta } from '../worker.mjs';
import { PILOT } from '../pilot.mjs';

// ---------------------------------------------------------------------------
// Unit: the helper contract
// ---------------------------------------------------------------------------

test('removes null-valued object members at every depth', () => {
  const input = { a: 1, b: null, c: { d: null, e: 2, f: { g: null, h: 3 } } };
  assert.deepEqual(normalizeNullMembers(input), { a: 1, c: { e: 2, f: { h: 3 } } });
});

test('PRESERVES null array elements — they are positional', () => {
  const input = { arr: [1, null, { a: null, b: 2 }, null, 3] };
  assert.deepEqual(normalizeNullMembers(input), { arr: [1, null, { b: 2 }, null, 3] });
});

test('null array elements survive at the top level and inside nested arrays', () => {
  assert.deepEqual(normalizeNullMembers([null, { x: [null, null] }]), [null, { x: [null, null] }]);
});

test('never mutates the input', () => {
  const input = { a: null, b: { c: null, d: [{ e: null }] } };
  const snapshot = JSON.stringify(input);
  normalizeNullMembers(input);
  assert.equal(JSON.stringify(input), snapshot);
});

test('idempotent: its own output is a fixed point', () => {
  const input = { a: null, b: { c: null, d: [1, null, { e: null }] }, f: 2 };
  const once = normalizeNullMembers(input);
  const twice = normalizeNullMembers(once);
  assert.deepEqual(twice, once);
  assert.equal(twice, once); // unchanged subtree returns the SAME reference — a true fixed point
});

test('returns the original reference when nothing changes; passes through scalars and null', () => {
  const o = { a: 1, b: { c: 'x' } };
  assert.equal(normalizeNullMembers(o), o);
  const arr = [1, [2], { q: 3 }];
  assert.equal(normalizeNullMembers(arr), arr);
  assert.equal(normalizeNullMembers(null), null);
  assert.equal(normalizeNullMembers(7), 7);
  assert.equal(normalizeNullMembers('s'), 's');
});

test('x_null_distinct opt-out: a manifest property declaring it keeps null as a third state', () => {
  const schema = {
    type: 'object',
    properties: {
      disclosure_status: { type: 'string', x_null_distinct: true }, // null = "explicitly N/A"
      periods_per_year: { type: 'integer' },
    },
  };
  const input = { disclosure_status: null, periods_per_year: null };
  assert.deepEqual(normalizeNullMembers(input, schema), { disclosure_status: null });
});

test('x_null_distinct is honoured at depth via nested properties', () => {
  const schema = {
    type: 'object',
    properties: {
      nested: {
        type: 'object',
        properties: { flag: { type: 'string', x_null_distinct: true }, other: { type: 'number' } },
      },
    },
  };
  const input = { nested: { flag: null, other: null } };
  assert.deepEqual(normalizeNullMembers(input, schema), { nested: { flag: null } });
});

test('with no schema (or no properties entry) nulls are removed everywhere', () => {
  assert.deepEqual(normalizeNullMembers({ a: null }, undefined), {});
  assert.deepEqual(normalizeNullMembers({ a: null }, {}), {});
  assert.deepEqual(normalizeNullMembers({ a: null }, { properties: {} }), {});
});

// ---------------------------------------------------------------------------
// Integration: both worker call sites, through the real MCP surface
// ---------------------------------------------------------------------------

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = resolve(ROOT, 'data');

// art-215 inputs: explicit Appendix J schedule. TWIN_A omits `periods_per_year` (the kernel's
// correct "not supplied" path); TWIN_B sends the explicit null an LLM client emits for the same
// intent. Pre-fix these two diverged: 11.9961 % APR vs 0.9997 % APR.
const SCHEDULE = {
  advances: [{ amount: 10000, full_periods: 0, fraction: 0 }],
  payments: Array.from({ length: 12 }, (_, i) => ({ amount: 900, full_periods: i + 1, fraction: 0 })),
};
const TWIN_A = { ...SCHEDULE };
const TWIN_B = { ...SCHEDULE, periods_per_year: null };

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

async function withCallTool(onlyTool, fn) {
  const server = buildServer(loadDataFromDisk(), { onlyTool });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  await clientT.start();
  let nextId = 2;
  const rpc = (method, params, id) => new Promise((res) => {
    const pending = (msg) => { if (msg && msg.id === id) { clientT.onmessage = null; res(msg); } };
    clientT.onmessage = pending;
    clientT.send({ jsonrpc: '2.0', id, method, params });
  });
  await rpc('initialize', {
    protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'null-normalize-test', version: '1' },
  }, 1);
  await clientT.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const callTool = async (name, args) => {
    const resp = await rpc('tools/call', { name, arguments: args }, nextId++);
    if (resp.error) throw new Error('RPC error: ' + JSON.stringify(resp.error));
    if (resp.result?.isError) throw new Error('Tool error: ' + resp.result?.content?.[0]?.text);
    return JSON.parse(resp.result?.content?.[0]?.text);
  };
  try {
    return await fn(callTool);
  } finally {
    await clientT.close();
    await server.close();
  }
}

const ART215_MCP_NAME = 'compute_reg_z_appendix_j_apr';
const ART215_TOOL_ID = 'art-215-reg-z-appendix-j-apr';

test('per-node delegation (worker.mjs ~5100): null-carrying call and null-free twin share ONE execution_hash', async () => {
  await withCallTool(ART215_MCP_NAME, async (callTool) => {
    const absent = await callTool(ART215_MCP_NAME, { policy_parameters: TWIN_A });
    const nullForm = await callTool(ART215_MCP_NAME, { policy_parameters: TWIN_B });
    assert.equal(absent.execution_hash, nullForm.execution_hash,
      'normalized twin must converge on the null-free execution_hash');
    assert.deepEqual(nullForm.policy_parameters, TWIN_A,
      'the artifact records the NORMALIZED parameters, never the null');
    assert.deepEqual(nullForm.output_payload, absent.output_payload);
    // The severe shape is actually fixed: a real APR is disclosed, not 0.9997.
    assert.ok(absent.output_payload.apr_pct > 10, 'absent twin discloses a real APR');
  });
});

test('emit_chaingraph_artifact Mode 4 (worker.mjs ~3264): null-carrying call and null-free twin share ONE execution_hash', async () => {
  await withCallTool('emit_chaingraph_artifact', async (callTool) => {
    const call = (pp) => callTool('emit_chaingraph_artifact', { tool_id: ART215_TOOL_ID, policy_parameters: pp });
    const absentEnv = await call(TWIN_A);
    const nullEnv = await call(TWIN_B);
    assert.equal(absentEnv.mode, 'server_compute'); // envelope sanity: we are on the Mode 4 path
    assert.equal(absentEnv.hash_valid, true);
    const { artifact: absent } = absentEnv;
    const { artifact: nullForm } = nullEnv;
    assert.equal(absent.execution_hash, nullForm.execution_hash);
    assert.deepEqual(nullForm.policy_parameters, TWIN_A);
    assert.deepEqual(nullForm.output_payload, absent.output_payload);
  });
});

test('null in a NESTED member is also normalized before compute (depth coverage on the live path)', async () => {
  await withCallTool(ART215_MCP_NAME, async (callTool) => {
    const nestedNull = { ...SCHEDULE, payment: { schedule: null, periods_per_year: null } };
    const plain = { ...SCHEDULE, payment: {} };
    const a = await callTool(ART215_MCP_NAME, { policy_parameters: plain });
    const b = await callTool(ART215_MCP_NAME, { policy_parameters: nestedNull });
    assert.equal(a.execution_hash, b.execution_hash);
    assert.deepEqual(b.policy_parameters, { ...plain });
  });
});
