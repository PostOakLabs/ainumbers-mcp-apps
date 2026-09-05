#!/usr/bin/env node
// otel-resource-link.test.mjs — MCP-OTEL-LINK-1 done-criteria.
//
// Drives run_chain via InMemoryTransport (same harness as tests/build-evidence-pack.test.mjs).
// Asserts:
//   - each server-mode result carries a `resource_link` content block whose URI is a
//     data:application/json;base64 of the OTel span document (no new route, no storage);
//   - execute_tool span count equals the executed (status:"ok") step count, and a chain run
//     with an input_required step produces NO span for that step;
//   - every execute_tool span's ocg.execution_hash equals that step's execution_hash;
//   - the parent invoke_agent span carries the composite_execution_hash and the chain name;
//   - every attribute name in the document is one of the names pinned in
//     tests/fixtures/otel-attributes.json (Development-status conventions: drift is a failure).
//
// Usage: node --test tests/ or node tests/otel-resource-link.test.mjs

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer, widgetGlue, stripCspMeta } from '../worker.mjs';
import { PILOT } from '../pilot.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = resolve(ROOT, 'data');

const CHAIN = 'agent-commerce-conformance';
const FIRST_STEP = 'art-01-ap2-mandate-chain-validator'; // kernel throws on missing required inputs

const ATTRS = JSON.parse(readFileSync(resolve(ROOT, 'tests/fixtures/otel-attributes.json'), 'utf8'));
const PINNED = new Set([...ATTRS.invoke_agent_span, ...ATTRS.execute_tool_span, ...ATTRS.resource]);

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

async function withServer(data, fn) {
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
  let nextId = 2;
  const rpc = (method, params, id) => new Promise((res) => {
    pending.set(id, res);
    clientT.send({ jsonrpc: '2.0', id, method, params });
  });

  await rpc('initialize', {
    protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'otel-link-test', version: '1' },
  }, 0);
  await clientT.send({ jsonrpc: '2.0', method: 'notifications/initialized' });

  const callTool = async (name, args) => {
    const resp = await rpc('tools/call', { name, arguments: args }, nextId++);
    if (resp.error) throw new Error('RPC error: ' + JSON.stringify(resp.error));
    return resp.result;
  };

  try {
    return await fn(callTool);
  } finally {
    await clientT.close();
    await server.close();
  }
}

function decodeResourceLink(result) {
  const link = result?.content?.find((c) => c.type === 'resource_link');
  assert.ok(link, 'resource_link content block present on run_chain result');
  assert.match(link.uri, /^data:application\/json;base64,/, 'resource_link URI is a base64 JSON data URI');
  assert.equal(link.mimeType, 'application/json');
  const json = decodeURIComponent(escape(atob(link.uri.slice('data:application/json;base64,'.length))));
  return { link, doc: JSON.parse(json) };
}

const spanAttrs = (span) => Object.fromEntries(span.attributes.map((a) => [a.key, a.value.stringValue]));
const byOp = (doc, op) => doc.trace.resourceSpans[0].scopeSpans[0].spans.filter((s) => spanAttrs(s)['gen_ai.operation.name'] === op);

async function runAndCheck(callTool, inputs, label) {
  const result = await callTool('run_chain', inputs === undefined ? { chain: CHAIN } : { chain: CHAIN, inputs });
  assert.ok(!result.isError, label + ': run_chain succeeded');
  const out = JSON.parse(result.content[0].text);
  const { doc } = decodeResourceLink(result);

  assert.equal(doc.chain, CHAIN, label + ': doc chain name');
  const agentSpans = byOp(doc, 'invoke_agent');
  assert.equal(agentSpans.length, 1, label + ': exactly one invoke_agent parent span');
  const parentAttrs = spanAttrs(agentSpans[0]);
  assert.equal(parentAttrs['gen_ai.agent.name'], CHAIN, label + ': parent span carries chain name');
  assert.equal(parentAttrs['ocg.composite_execution_hash'], out.composite_execution_hash, label + ': parent span carries the composite hash');

  const okSteps = out.steps.filter((s) => s.status === 'ok');
  const toolSpans = byOp(doc, 'execute_tool');
  assert.equal(toolSpans.length, okSteps.length, label + ': execute_tool span count equals executed-step count');
  const spanByTool = Object.fromEntries(toolSpans.map((s) => [spanAttrs(s)['gen_ai.tool.name'], s]));
  for (const step of okSteps) {
    const span = spanByTool[step.tool_id];
    assert.ok(span, label + ': span present for executed step ' + step.tool_id);
    const attrs = spanAttrs(span);
    assert.equal(attrs['ocg.execution_hash'], step.execution_hash, label + ': execution_hash parity for ' + step.tool_id);
    assert.ok(attrs['ocg.kernel_digest'], label + ': kernel_digest stamped for ' + step.tool_id);
  }
  for (const step of out.steps.filter((s) => s.status !== 'ok')) {
    assert.ok(!spanByTool[step.tool_id], label + ': NO span for non-executed step ' + step.tool_id + ' (status ' + step.status + ')');
  }
  // attribute drift gate: every name in the doc is one of the pinned fixture names
  for (const rs of doc.trace.resourceSpans) {
    for (const a of rs.resource.attributes) assert.ok(PINNED.has(a.key) || ATTRS.resource.includes(a.key), 'resource attr pinned: ' + a.key);
    for (const ss of rs.scopeSpans) for (const span of ss.spans) for (const a of span.attributes) {
      assert.ok(PINNED.has(a.key), label + ': span attribute name is pinned in fixture: ' + a.key);
    }
  }
  return out;
}

async function main() {
  const data = loadDataFromDisk();

  console.log('\n▶ MCP-OTEL-LINK-1: run_chain OTel span resource_link\n');

  // (1) fully fixture-backed run: every step ok, every step spanned
  const out1 = await withServer(data, (call) => runAndCheck(call, undefined, 'all-ok run'));
  assert.equal(out1.steps_ran, out1.step_count, 'all-ok run: every step executed');
  console.log('  ✓ all-ok run: ' + out1.steps_ran + ' steps, ' + out1.steps_ran + ' execute_tool spans, composite hash on parent span');

  // (2) run with the first step forced input_required: NO span for that step, parity for the rest
  const out2 = await withServer(data, (call) => runAndCheck(call, { [FIRST_STEP]: {} }, 'input_required run'));
  const irStep = out2.steps.find((s) => s.tool_id === FIRST_STEP);
  assert.equal(irStep.status, 'input_required', 'input_required run: first step reported input_required');
  assert.ok(out2.steps_ran < out2.step_count, 'input_required run: not all steps ran');
  console.log('  ✓ input_required run: step ' + FIRST_STEP + ' produced NO execute_tool span; ' + out2.steps_ran + '/' + out2.step_count + ' spanned');

  console.log('\nAll MCP-OTEL-LINK-1 assertions passed.\n');
}

main().catch((err) => { console.error(err); process.exit(1); });
