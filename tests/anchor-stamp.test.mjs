#!/usr/bin/env node
// anchor-stamp.test.mjs — AGENTGLUE-BUILD-2 done-criteria (AGENT-GLUE-BUILD-SPEC.md §(b)).
//
// Test-network choice (spec §(b) doctrine step 7): MOCKED upstream response, not a live call to
// anchor.ainumbers.co. anchor_stamp's own logic under test is (a) request shaping to anchor_hash /
// anchor_batch, (b) the self-checked anchored_hash/merkle_inclusion.leaf equality gate, and (c) the
// NEVER-FAKE-A-RECEIPT failure contract — none of that requires a real TSA round-trip, and a live
// dependency here would make this repo's CI red on a transient anchor-suite outage that is not this
// repo's regression. globalThis.fetch is monkey-patched to return canned JSON-RPC bodies shaped
// exactly like anchor-suite's real tools/call responses (see anchor-suite/src/worker.mjs
// toolAnchorHash / toolAnchorBatch / stampWithAuthorities).
//
// Asserts:
//   - success path returns {ok:true, anchor_binding} with the literal §20 shape, anchored_hash
//     equal to the caller-supplied execution_hash.
//   - anchor-suite unreachable (fetch throws) -> {ok:false, unanchored:true, reason}, never a binding.
//   - anchor-suite returns a binding whose anchored_hash does NOT match the caller's execution_hash ->
//     {ok:false, unanchored:true, reason}, never a binding (the equality self-check must fire even
//     when anchor-suite's own response looks well-formed).
//   - batch (array) input calls anchor_batch (not N anchor_hash calls) and shapes a per-hash
//     anchor_bindings[] array carrying that hash's own merkle_inclusion.
//   - malformed execution_hash is rejected before any network call is attempted.
//
// Usage: node tests/anchor-stamp.test.mjs

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer, widgetGlue, stripCspMeta } from '../worker.mjs';
import { PILOT } from '../pilot.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = resolve(ROOT, 'data');

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

async function withServer(data, onlyTool, fn) {
  const server = buildServer(data, { onlyTool });
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
    protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e-test', version: '1' },
  }, 0);
  await clientT.send({ jsonrpc: '2.0', method: 'notifications/initialized' });

  const callTool = async (name, args) => {
    const resp = await rpc('tools/call', { name, arguments: args }, nextId++);
    if (resp.error) throw new Error('RPC error: ' + JSON.stringify(resp.error));
    return resp.result;
  };

  const result = await fn(callTool);

  await clientT.close();
  await server.close();
  return result;
}

function parse(result) {
  if (result?.isError) throw new Error('Tool error: ' + result?.content?.[0]?.text);
  const text = result?.content?.[0]?.text;
  if (!text) throw new Error('Empty response');
  return JSON.parse(text);
}

let failed = 0;
const check = (label, pass, detail) => {
  if (pass) { console.log(`  ✓ ${label}`); }
  else { console.error(`  ✗ ${label}${detail ? ': ' + detail : ''}`); failed++; }
};

// Mocks a single anchor-suite tools/call JSON-RPC response body, MCP-shaped exactly like
// anchor-suite/src/worker.mjs's mcpResult wrapping (content[0].text = JSON.stringify(payload)).
function mockAnchorSuiteResponse(payload) {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } }),
    { status: 200, headers: { 'Content-Type': 'application/json' } });
}

const HASH_A = '11'.repeat(32);
const HASH_B = '22'.repeat(32);
const originalFetch = globalThis.fetch;

async function main() {
  console.log('\n▶ AGENTGLUE-BUILD-2: anchor_stamp\n');
  const data = loadDataFromDisk();

  // ── (1) success path: literal §20 binding, anchored_hash equals caller's execution_hash ──
  globalThis.fetch = async () => mockAnchorSuiteResponse({
    anchor_bindings: [{ type: 'rfc3161-tst', anchored_hash: 'sha256:' + HASH_A, log_origin: 'https://timestamp.sigstore.dev', proof: 'ZGVy', policy_oid: '1.2.3', serial: '1', gen_time: '2026-08-03T00:00:00Z', signer_cert_chain_b64: [] }],
    failures: [],
  });
  const ok1 = await withServer(data, 'anchor_stamp', (call) =>
    call('anchor_stamp', { execution_hash: 'sha256:' + HASH_A }).then(parse));
  check('success: ok:true', ok1.ok === true, JSON.stringify(ok1));
  check('success: anchor_binding.anchored_hash equals caller execution_hash',
    ok1.anchor_binding?.anchored_hash === 'sha256:' + HASH_A, JSON.stringify(ok1.anchor_binding));
  check('success: anchor_binding carries the §20 type field', ok1.anchor_binding?.type === 'rfc3161-tst', JSON.stringify(ok1.anchor_binding));

  // ── (2) anchor-suite unreachable -> {ok:false, unanchored:true, reason}, never a binding ──
  globalThis.fetch = async () => { throw new Error('simulated network failure'); };
  const unreachable = await withServer(data, 'anchor_stamp', (call) =>
    call('anchor_stamp', { execution_hash: 'sha256:' + HASH_A }).then(parse));
  check('unreachable: ok:false', unreachable.ok === false, JSON.stringify(unreachable));
  check('unreachable: unanchored:true', unreachable.unanchored === true, JSON.stringify(unreachable));
  check('unreachable: reason quotes the transport failure verbatim', /simulated network failure/.test(unreachable.reason), unreachable.reason);
  check('unreachable: no anchor_binding / anchor_bindings key present (never a fake binding)',
    !('anchor_binding' in unreachable) && !('anchor_bindings' in unreachable), JSON.stringify(unreachable));

  // ── (3) anchored_hash mismatch (anchor-suite returns a well-formed but WRONG binding) ──
  globalThis.fetch = async () => mockAnchorSuiteResponse({
    anchor_bindings: [{ type: 'rfc3161-tst', anchored_hash: 'sha256:' + HASH_B, log_origin: 'https://timestamp.sigstore.dev', proof: 'ZGVy', policy_oid: '1.2.3', serial: '1', gen_time: '2026-08-03T00:00:00Z', signer_cert_chain_b64: [] }],
    failures: [],
  });
  const mismatch = await withServer(data, 'anchor_stamp', (call) =>
    call('anchor_stamp', { execution_hash: 'sha256:' + HASH_A }).then(parse));
  check('mismatch: ok:false even though anchor-suite\'s response was well-formed', mismatch.ok === false, JSON.stringify(mismatch));
  check('mismatch: unanchored:true, no binding relayed', mismatch.unanchored === true && !('anchor_binding' in mismatch), JSON.stringify(mismatch));

  // ── (4) batch (array) input calls anchor_batch, shapes per-hash anchor_bindings[] ──
  let lastRequestedTool = null;
  globalThis.fetch = async (_url, opts) => {
    const body = JSON.parse(opts.body);
    lastRequestedTool = body.params.name;
    return mockAnchorSuiteResponse({
      root: 'sha256:' + 'aa'.repeat(32),
      anchor_bindings: [{ type: 'rfc3161-tst', anchored_hash: 'sha256:' + 'aa'.repeat(32), log_origin: 'https://timestamp.sigstore.dev', proof: 'ZGVy', policy_oid: '1.2.3', serial: '1', gen_time: '2026-08-03T00:00:00Z', signer_cert_chain_b64: [] }],
      entries: [
        { hash: 'sha256:' + HASH_A, merkle_inclusion: { leaf: 'sha256:' + HASH_A, path: [], tree_size: 2 } },
        { hash: 'sha256:' + HASH_B, merkle_inclusion: { leaf: 'sha256:' + HASH_B, path: [], tree_size: 2 } },
      ],
      failures: [],
    });
  };
  const batch = await withServer(data, 'anchor_stamp', (call) =>
    call('anchor_stamp', { execution_hash: ['sha256:' + HASH_A, 'sha256:' + HASH_B] }).then(parse));
  check('batch: calls anchor_batch, not repeated anchor_hash', lastRequestedTool === 'anchor_batch', lastRequestedTool);
  check('batch: ok:true', batch.ok === true, JSON.stringify(batch));
  check('batch: anchor_bindings has one entry per input hash', Array.isArray(batch.anchor_bindings) && batch.anchor_bindings.length === 2, JSON.stringify(batch));
  check('batch: entry 0 carries its OWN merkle_inclusion.leaf (hash A)',
    batch.anchor_bindings?.[0]?.[0]?.merkle_inclusion?.leaf === 'sha256:' + HASH_A, JSON.stringify(batch.anchor_bindings?.[0]));
  check('batch: entry 1 carries its OWN merkle_inclusion.leaf (hash B)',
    batch.anchor_bindings?.[1]?.[0]?.merkle_inclusion?.leaf === 'sha256:' + HASH_B, JSON.stringify(batch.anchor_bindings?.[1]));

  // ── (5) malformed execution_hash rejected before any network call ──
  let networkCalled = false;
  globalThis.fetch = async () => { networkCalled = true; return mockAnchorSuiteResponse({}); };
  const badHash = await withServer(data, 'anchor_stamp', (call) =>
    call('anchor_stamp', { execution_hash: 'not-a-hash' }).then(parse));
  check('malformed execution_hash: ok:false, no network call attempted', badHash.ok === false && !networkCalled, JSON.stringify(badHash));

  globalThis.fetch = originalFetch;

  if (failed) {
    console.error(`\n✗ ${failed} assertion(s) FAILED`);
    process.exit(1);
  }
  console.log(`\n✅ all assertions passed — anchor_stamp relays real anchor-suite responses and never fakes a receipt`);
}

main().catch((err) => {
  globalThis.fetch = originalFetch;
  console.error('✗ e2e test ERROR:', err);
  process.exit(1);
});
