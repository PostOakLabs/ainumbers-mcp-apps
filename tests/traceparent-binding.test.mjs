#!/usr/bin/env node
// traceparent-binding.test.mjs — TRACEPARENT-BINDING-1 done-criteria.
//
// MCP spec 2026-07-28 reserves traceparent / tracestate / baggage in the tools/call request
// `params._meta` for OpenTelemetry compatibility. This row binds the CALLER's W3C trace context
// into the emitted receipt: a valid `traceparent` makes the run_chain OTel span document (the
// MCP-OTEL-LINK-1 resource_link) carry the caller's trace id on every span — the invoke_agent
// span joins the caller's trace instead of minting an estate-local one — and echoes the parsed
// ids + tracestate/baggage as `out.trace_context` response metadata beside `out.otel_span_link`.
//
// Asserts (the row's four cases):
//   1. a valid header IS bound: every span's traceId equals the caller's; trace_context mirrors
//      trace_id / parent_span_id / tracestate / baggage; attribute names stay pinned in
//      tests/fixtures/otel-attributes.json (the fixture is NEVER edited to pass);
//   2. a malformed header is IGNORED: no error, no trace_context, fresh estate-local trace id —
//      exactly today's shape (covers bad version, bad lengths, uppercase, all-zero trace id,
//      all-zero span id, non-string);
//   3. an ABSENT header gives today's output: no trace_context field anywhere, otel_span_link
//      present, single shared random trace id, no root parentSpanId;
//   4. hash invariance: for the same inputs, composite_execution_hash, every step's
//      execution_hash and dedupe.input_hash are IDENTICAL with no header, a valid header and a
//      malformed header — the binding is response metadata only and never touches the artifact.
//
// Usage: node tests/traceparent-binding.test.mjs (or node --test tests/)

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer, widgetGlue, stripCspMeta } from '../worker.mjs';
import { PILOT } from '../pilot.mjs';
import { parseW3cTraceparent } from '../otelspan.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = resolve(ROOT, 'data');

const CHAIN = 'agent-commerce-conformance';

const ATTRS = JSON.parse(readFileSync(resolve(ROOT, 'tests/fixtures/otel-attributes.json'), 'utf8'));
const PINNED = new Set([...ATTRS.invoke_agent_span, ...ATTRS.execute_tool_span, ...ATTRS.resource]);

// The caller-side W3C trace context used for the valid-header case (W3C Trace Context Level 1:
// version 00, 32-hex trace id, 16-hex span id, 2-hex flags).
const CALLER_TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736'; // the W3C spec's example trace id
const CALLER_SPAN_ID = '00f067aa0ba902b7';                 // the W3C spec's example parent id
const CALLER_TRACEPARENT = `00-${CALLER_TRACE_ID}-${CALLER_SPAN_ID}-01`;
const CALLER_TRACESTATE = 'acmeVendor=1sibling,rojo=00f067aa0ba902b7';
const CALLER_BAGGAGE = 'tenant=acmeCorp,session=id-42';

// Deliberately malformed traceparent values (each must be IGNORED, never error, never bind).
const MALFORMED = [
  ['wrong version', 'ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'],
  ['short trace id', '00-4bf92f3577b34da6-00f067aa0ba902b7-01'],
  ['short span id', '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa-01'],
  ['missing flags', '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7'],
  ['uppercase hex', '00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01'],
  ['all-zero trace id', `00-${'0'.repeat(32)}-00f067aa0ba902b7-01`],
  ['all-zero span id', `00-4bf92f3577b34da6a3ce929d0e0e4736-${'0'.repeat(16)}-01`],
  ['non-hex garbage', '00-not-hex-not-hex-not-hex!-also-not-hex!-zz'],
  ['empty string', ''],
  ['non-string', 42],
];

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
    protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'traceparent-binding-test', version: '1' },
  }, 0);
  await clientT.send({ jsonrpc: '2.0', method: 'notifications/initialized' });

  // Same as otel-resource-link.test.mjs's callTool, plus the row's point: the caller may attach
  // `params._meta` (traceparent / tracestate / baggage) to the tools/call request itself.
  const callTool = async (name, args, _meta) => {
    const params = { name, arguments: args };
    if (_meta !== undefined) params._meta = _meta;
    const resp = await rpc('tools/call', params, nextId++);
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
  const json = decodeURIComponent(escape(atob(link.uri.slice('data:application/json;base64,'.length))));
  return { link, doc: JSON.parse(json) };
}

const spanAttrs = (span) => Object.fromEntries(span.attributes.map((a) => [a.key, a.value.stringValue]));
const allSpans = (doc) => doc.trace.resourceSpans.flatMap((rs) => rs.scopeSpans.flatMap((ss) => ss.spans));

// Attribute drift gate (same discipline as otel-resource-link.test.mjs): every attribute name in
// the doc is one of the names pinned in tests/fixtures/otel-attributes.json. The binding must be
// achieved WITHOUT new attribute names — the fixture is never edited to pass.
function assertAttrsPinned(doc, label) {
  for (const rs of doc.trace.resourceSpans) {
    for (const a of rs.resource.attributes) assert.ok(ATTRS.resource.includes(a.key), label + ': resource attr pinned: ' + a.key);
    for (const ss of rs.scopeSpans) for (const span of ss.spans) for (const a of span.attributes) {
      assert.ok(PINNED.has(a.key), label + ': span attribute name pinned in fixture: ' + a.key);
    }
  }
}

// Today's shape: every span in the doc carries ONE trace id, it is a fresh estate-local one
// (valid W3C shape), and the root invoke_agent span has no parentSpanId.
function assertEstateLocalShape(doc, label) {
  const spans = allSpans(doc);
  const ids = new Set(spans.map((s) => s.traceId));
  assert.equal(ids.size, 1, label + ': all spans share one trace id');
  const traceId = [...ids][0];
  assert.match(traceId, /^[0-9a-f]{32}$/, label + ': trace id is 32 lowercase hex');
  const root = spans.find((s) => spanAttrs(s)['gen_ai.operation.name'] === 'invoke_agent');
  assert.ok(root, label + ': invoke_agent parent span present');
  assert.equal(root.parentSpanId, undefined, label + ': root invoke_agent span has no parentSpanId');
  return traceId;
}

async function main() {
  const data = loadDataFromDisk();

  console.log('\n▶ TRACEPARENT-BINDING-1: caller W3C trace context bound into the run_chain span doc\n');

  // (0) parser unit table — the row's pinned W3C shape, all-zero ids rejected.
  assert.deepEqual(parseW3cTraceparent(CALLER_TRACEPARENT), { traceId: CALLER_TRACE_ID, spanId: CALLER_SPAN_ID }, 'parser accepts the spec-shaped traceparent');
  for (const [label, value] of MALFORMED) {
    assert.equal(parseW3cTraceparent(value), null, 'parser rejects: ' + label);
  }
  console.log('  ✓ parser: 1 accept, ' + MALFORMED.length + ' rejects (bad version/lengths/case, all-zero ids, non-string)');

  // (1) valid header bound — trace id joins the caller's trace; tracestate/baggage echoed.
  const bound = await withServer(data, async (callTool) => {
    const result = await callTool('run_chain', { chain: CHAIN }, {
      traceparent: CALLER_TRACEPARENT,
      tracestate: CALLER_TRACESTATE,
      baggage: CALLER_BAGGAGE,
    });
    assert.ok(!result.isError, 'valid-header run: run_chain succeeded');
    const out = JSON.parse(result.content[0].text);
    const { doc } = decodeResourceLink(result);

    const spans = allSpans(doc);
    for (const s of spans) assert.equal(s.traceId, CALLER_TRACE_ID, 'every span traceId equals the caller trace id');
    const root = spans.find((s) => spanAttrs(s)['gen_ai.operation.name'] === 'invoke_agent');
    assert.ok(root, 'invoke_agent parent span present');
    assert.equal(spanAttrs(root)['ocg.composite_execution_hash'], out.composite_execution_hash, 'parent span still carries the composite hash');
    const okSteps = out.steps.filter((s) => s.status === 'ok');
    assert.equal(spans.length - 1, okSteps.length, 'execute_tool span count parity unchanged');

    assert.deepEqual(out.trace_context, {
      trace_id: CALLER_TRACE_ID,
      parent_span_id: CALLER_SPAN_ID,
      tracestate: CALLER_TRACESTATE,
      baggage: CALLER_BAGGAGE,
    }, 'trace_context mirrors the caller trace context exactly');
    assert.equal(out.trace_context.trace_id, doc.trace.resourceSpans.flatMap((rs) => rs.scopeSpans.flatMap((ss) => ss.spans))[0].traceId, 'trace_context.trace_id equals the doc trace id');

    assertAttrsPinned(doc, 'valid-header run');
    return out;
  });
  console.log('  ✓ valid header: all spans under caller trace ' + CALLER_TRACE_ID.slice(0, 8) + '…, trace_context echoes ids + tracestate + baggage, attrs pinned');

  // (2) malformed header ignored — no error, no trace_context, estate-local trace id.
  for (const [label, value] of MALFORMED) {
    await withServer(data, async (callTool) => {
      const result = await callTool('run_chain', { chain: CHAIN }, { traceparent: value });
      assert.ok(!result.isError, `malformed (${label}): run_chain succeeded`);
      const out = JSON.parse(result.content[0].text);
      assert.equal(out.trace_context, undefined, `malformed (${label}): no trace_context field`);
      const { doc } = decodeResourceLink(result);
      const traceId = assertEstateLocalShape(doc, `malformed (${label})`);
      assert.notEqual(traceId, String(value), `malformed (${label}): malformed value never becomes a trace id`);
      assertAttrsPinned(doc, `malformed (${label})`);
    });
  }
  console.log('  ✓ malformed headers (' + MALFORMED.length + ' shapes): ignored — today\'s estate-local span doc, no new field, no error');

  // (3) absent header — output is today's: no trace_context anywhere, unchanged doc shape.
  const absent = await withServer(data, async (callTool) => {
    const result = await callTool('run_chain', { chain: CHAIN });
    assert.ok(!result.isError, 'absent-header run: run_chain succeeded');
    const out = JSON.parse(result.content[0].text);
    assert.equal(out.trace_context, undefined, 'absent header: no trace_context field');
    assert.ok(out.otel_span_link, 'absent header: otel_span_link present as today');
    const { doc } = decodeResourceLink(result);
    assertEstateLocalShape(doc, 'absent header');
    assertAttrsPinned(doc, 'absent header');
    return out;
  });
  console.log('  ✓ absent header: no trace_context, otel_span_link as today, estate-local trace id, no root parentSpanId');

  // (4) hash invariance — the binding never moves a hashed byte. Same inputs, three header
  // states: none / valid / malformed. composite_execution_hash, per-step execution_hash and
  // dedupe.input_hash must be IDENTICAL across all three.
  const withValid = await withServer(data, async (callTool) =>
    JSON.parse((await callTool('run_chain', { chain: CHAIN }, {
      traceparent: CALLER_TRACEPARENT, tracestate: CALLER_TRACESTATE, baggage: CALLER_BAGGAGE,
    })).content[0].text));
  const withMalformed = await withServer(data, async (callTool) =>
    JSON.parse((await callTool('run_chain', { chain: CHAIN }, { traceparent: '00-not-a-w3c-traceparent-header' })).content[0].text));

  assert.equal(absent.composite_execution_hash, withValid.composite_execution_hash, 'composite_execution_hash identical: absent vs valid header');
  assert.equal(absent.composite_execution_hash, withMalformed.composite_execution_hash, 'composite_execution_hash identical: absent vs malformed header');
  assert.deepEqual(absent.dedupe, withValid.dedupe, 'dedupe identical: absent vs valid header');
  const stepsAbsent = Object.fromEntries(absent.steps.map((s) => [s.tool_id, s.execution_hash]));
  for (const [label, run] of [['valid', withValid], ['malformed', withMalformed]]) {
    assert.equal(run.steps.length, absent.steps.length, label + ': same step count');
    for (const step of run.steps) {
      assert.equal(step.execution_hash, stepsAbsent[step.tool_id], label + ': execution_hash identical for ' + step.tool_id);
    }
  }
  console.log('  ✓ hash invariance: composite_execution_hash ' + absent.composite_execution_hash.slice(0, 12) + '… and every step execution_hash identical with no/valid/malformed header');

  console.log('\nAll TRACEPARENT-BINDING-1 assertions passed.\n');
}

main().catch((err) => { console.error(err); process.exit(1); });
