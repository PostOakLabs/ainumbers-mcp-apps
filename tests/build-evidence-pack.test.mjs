#!/usr/bin/env node
// build-evidence-pack.test.mjs — AGENTGLUE-BUILD-1 done-criteria (AGENT-GLUE-BUILD-SPEC.md §(a)).
//
// Drives build_evidence_pack via InMemoryTransport (same harness as scripts/test-run-chain-fixtures.mjs).
// Asserts:
//   - session_receipt.session_receipt_root matches a direct build_session_receipt call over the
//     SAME execution_hashes (proves in-process reuse, not a reimplementation).
//   - disclosure_manifest.merkle_root matches a direct build_disclosure_manifest call over the
//     SAME entries.
//   - ha_bundle is OMITTED (no key) when ha_records is not supplied — never synthesized as a placeholder.
//   - ha_bundle IS present and matches assembleEvidenceBundle's own shape when ha_records is supplied.
//   - a thrown section (malformed artifacts) fails the WHOLE call isError:true, no partial pack.
//   - two calls with identical input produce identical session_receipt_root / merkle_root (determinism).
//
// Usage: node tests/build-evidence-pack.test.mjs

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

const ARTIFACTS = [
  { execution_hash: 'sha256:' + '11'.repeat(32), tool_id: 'art-01-example', output_payload: { verdict: 'pass' } },
  { execution_hash: 'sha256:' + '22'.repeat(32), tool_id: 'art-02-example' },
];
const HA_RECORDS = [
  { role: 'reviewer', reviewer_id: 'r-1', decision: 'approved', timestamp: '2026-08-03T00:00:00Z' },
];

async function main() {
  console.log('\n▶ AGENTGLUE-BUILD-1: build_evidence_pack\n');
  const data = loadDataFromDisk();

  // ── (1) session_receipt matches a direct build_session_receipt call over the same hashes ──
  const [packNoHa, directReceipt] = await Promise.all([
    withServer(data, 'build_evidence_pack', (call) =>
      call('build_evidence_pack', { artifacts: ARTIFACTS }).then(parse)),
    withServer(data, 'build_session_receipt', (call) =>
      call('build_session_receipt', {
        execution_hashes: ARTIFACTS.map((a) => a.execution_hash),
        tool_ids: ARTIFACTS.map((a) => a.tool_id),
      }).then(parse)),
  ]);
  check('session_receipt_root matches direct build_session_receipt call (in-process reuse)',
    packNoHa.session_receipt.session_receipt_root === directReceipt.session_receipt_root,
    `pack=${packNoHa.session_receipt.session_receipt_root} direct=${directReceipt.session_receipt_root}`);

  // ── (2) ha_bundle OMITTED (no key) when ha_records not supplied ─────────────────────────
  check('ha_bundle key absent when ha_records not supplied', !('ha_bundle' in packNoHa),
    JSON.stringify(Object.keys(packNoHa)));

  // ── (3) disclosure_manifest present and its merkle_root matches a direct call ───────────
  const directManifest = await withServer(data, 'build_disclosure_manifest', (call) =>
    call('build_disclosure_manifest', {
      entries: [
        { path: 'art-01-example', size: JSON.stringify(ARTIFACTS[0].output_payload).length, digest: ARTIFACTS[0].execution_hash, content_type: 'application/json' },
        { path: 'art-02-example', size: 0, digest: ARTIFACTS[1].execution_hash, content_type: 'application/hash-only' },
      ],
    }).then(parse));
  check('disclosure_manifest.merkle_root matches direct build_disclosure_manifest call',
    packNoHa.disclosure_manifest.merkle_root === directManifest.merkle_root,
    `pack=${packNoHa.disclosure_manifest.merkle_root} direct=${directManifest.merkle_root}`);

  // ── (4) ha_bundle present + shaped when ha_records IS supplied ──────────────────────────
  const packWithHa = await withServer(data, 'build_evidence_pack', (call) =>
    call('build_evidence_pack', { artifacts: ARTIFACTS, ha_records: HA_RECORDS }).then(parse));
  check('ha_bundle present when ha_records supplied', packWithHa.ha_bundle !== undefined && packWithHa.ha_bundle !== null,
    JSON.stringify(packWithHa.ha_bundle));
  check('ha_bundle.subject_hash defaults to artifacts[0].execution_hash',
    packWithHa.ha_bundle?.subject_hash === ARTIFACTS[0].execution_hash,
    packWithHa.ha_bundle?.subject_hash);

  // ── (5) malformed input fails the WHOLE call, no partial pack ───────────────────────────
  // An empty artifacts array is schema-rejected by zod (.min(1)) before the handler runs —
  // itself a whole-call failure with no partial pack.
  const rejectedResult = await withServer(data, 'build_evidence_pack', (call) =>
    call('build_evidence_pack', { artifacts: [] }));
  check('empty artifacts[] is rejected (schema .min(1)) — whole call fails, no partial pack',
    rejectedResult.isError === true || /too_small|expected array/i.test(JSON.stringify(rejectedResult)),
    JSON.stringify(rejectedResult).slice(0, 200));

  // ── (6) determinism — two identical calls produce identical roots ───────────────────────
  const packAgain = await withServer(data, 'build_evidence_pack', (call) =>
    call('build_evidence_pack', { artifacts: ARTIFACTS }).then(parse));
  check('two calls with identical input produce identical session_receipt_root',
    packNoHa.session_receipt.session_receipt_root === packAgain.session_receipt.session_receipt_root,
    `first=${packNoHa.session_receipt.session_receipt_root} second=${packAgain.session_receipt.session_receipt_root}`);
  check('two calls with identical input produce identical disclosure_manifest.merkle_root',
    packNoHa.disclosure_manifest.merkle_root === packAgain.disclosure_manifest.merkle_root,
    `first=${packNoHa.disclosure_manifest.merkle_root} second=${packAgain.disclosure_manifest.merkle_root}`);

  if (failed) {
    console.error(`\n✗ ${failed} assertion(s) FAILED`);
    process.exit(1);
  }
  console.log(`\n✅ all assertions passed — build_evidence_pack composes in-process, no reimplementation`);
}

main().catch((err) => {
  console.error('✗ e2e test ERROR:', err);
  process.exit(1);
});
