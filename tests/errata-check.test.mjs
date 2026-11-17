#!/usr/bin/env node
// errata-check.test.mjs -- the errata_check utility tool (KERNEL-ERRATA-MCP-1).
//
// Fixtures: the receipt digests come from the VENDORED snapshot itself (entries are
// append-only per K5, so KE-2026-0001 is stable), never hardcoded -- the test reads
// entries[0]'s affected/fixed digests at runtime and classifies synthetic receipts
// built around them. The predicate semantics pinned below are KE-2026-0001's
// (fail-open-missing-input: affected when any listed input is absent or null).
//
// Asserts:
//   - tools/list carries errata_check exactly once, readOnly, with a description naming
//     the three states and the no-server page path (the row's description contract).
//   - NOT-LISTED: an unrecorded digest classifies NOT-LISTED with the tree size it was
//     checked against and no erratum id.
//   - LISTED-AFFECTED: KE-2026-0001's affected digest + policy_parameters missing the
//     listed fields -> affected, with erratum id + fixed digest + tree size.
//   - LISTED-UNAFFECTED: the same digest with every listed field present -> unaffected.
//   - journal-shaped receipts (kernel_digest + policy_parameters under journal) reach
//     the same verdict as the flat shape; sha256: prefix and case are normalized.
//   - NOT-ENGAGED: an object with no digest says so instead of guessing.
//   - a non-object receipt is a structured -32602 (invalid_args.errata_receipt).
//   - module level: past the checkpoint's expires_at the reader answers STALE with the
//     log's own sentence verbatim (planted clock, synthetic checkpoint).
//
// Usage: node tests/errata-check.test.mjs

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer, widgetGlue, stripCspMeta } from '../worker.mjs';
import { PILOT } from '../pilot.mjs';
import { ERRATA_SNAPSHOT } from '../errata/errata-snapshot.mjs';
import { errataCheck } from '../errata/errata-check.mjs';
import { runErrataCheck } from '../errata-check-tool.mjs';

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

  try { await fn(callTool, rpc); } finally { await clientT.close(); await server.close(); }
}

let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log('  ok  ' + label); }
  else { fail++; console.log('  FAIL ' + label); }
}

// ── fixtures from the vendored snapshot (append-only; KE-2026-0001 is permanent) ──
const ENTRY = ERRATA_SNAPSHOT.entries.find((e) => e.id === 'KE-2026-0001');
if (!ENTRY) { console.error('FATAL: KE-2026-0001 missing from the vendored snapshot'); process.exit(1); }
const AFFECTED_DIGEST = ENTRY.kernel_digest_affected[0];
const TREE_SIZE = ERRATA_SNAPSHOT.checkpoint.tree_size;
const listedFields = ['compliance_modules', 'required_claim_topics', 'trusted_issuers'];
const unaffectedPp = Object.fromEntries(listedFields.map((k) => [k, ['x']]));

const data = loadDataFromDisk();

// ── 1. the tool is listed, unique, readOnly, and its description carries the contract ──
// tools/list is a protocol METHOD (not a tool) and is PAGED (MCP-LIST-CURSOR-V2):
// errata_check is a deferred (non-hot) tool, so walk every page via nextCursor.
await withServer(data, null, async (callTool, rpc) => {
  const all = [];
  let cursor;
  do {
    const page = await rpc('tools/list', cursor ? { cursor } : {}, 900001);
    all.push(...(page.result?.tools ?? []));
    cursor = page.result?.nextCursor;
  } while (cursor);
  const mine = all.filter((t) => t.name === 'errata_check');
  ok(mine.length === 1, 'tools/list carries errata_check exactly once');
  const def = mine[0];
  ok(def.annotations?.readOnlyHint === true, 'readOnlyHint true');
  const d = def.description ?? '';
  ok(['NOT-LISTED', 'LISTED-UNAFFECTED', 'LISTED-AFFECTED'].every((s) => d.includes(s)), 'description names all three states');
  ok(d.includes('no server'), 'description states the page path needs no server');
  ok(d.includes('sees the receipt'), 'description states the worker sees the receipt it is sent');
});

// ── 2-7. classification over the receipt fixtures ──
await withServer(data, null, async (callTool) => {
  // NOT-LISTED: an unrecorded digest.
  const r1 = await callTool('errata_check', { receipt: { kernel_digest: 'sha256:' + '0'.repeat(64), policy_parameters: { a: 1 } } });
  ok(r1.structuredContent?.state === 'NOT-LISTED', 'unrecorded digest -> NOT-LISTED');
  ok(r1.structuredContent?.tree_size === TREE_SIZE, 'NOT-LISTED carries the tree size checked against');
  ok(r1.structuredContent?.erratum_id === null && r1.structuredContent?.kernel_digest_fixed === null, 'NOT-LISTED carries no erratum id / fixed digest');

  // LISTED-AFFECTED: the recorded affected digest, inputs inside the affected region.
  const r2 = await callTool('errata_check', { receipt: { kernel_digest: AFFECTED_DIGEST, policy_parameters: {} } });
  ok(r2.structuredContent?.state === 'LISTED-AFFECTED', 'affected digest + empty pp -> LISTED-AFFECTED');
  ok(r2.structuredContent?.erratum_id === 'KE-2026-0001', 'carries the erratum id');
  ok(typeof r2.structuredContent?.kernel_digest_fixed === 'string' && r2.structuredContent.kernel_digest_fixed.startsWith('sha256:'), 'carries the fixed digest as recorded');
  ok(r2.structuredContent?.tree_size === TREE_SIZE, 'carries the tree size checked against');
  ok(typeof r2.structuredContent?.sentence === 'string' && r2.structuredContent.sentence.includes('KE-2026-0001'), 'sentence names the erratum');

  // LISTED-UNAFFECTED: same digest, every listed field present.
  const r3 = await callTool('errata_check', { receipt: { kernel_digest: AFFECTED_DIGEST, policy_parameters: unaffectedPp } });
  ok(r3.structuredContent?.state === 'LISTED-UNAFFECTED', 'all listed fields present -> LISTED-UNAFFECTED');

  // journal-shaped receipt, prefixed + uppercase digest: same verdict as flat.
  const r4 = await callTool('errata_check', { receipt: { journal: { kernel_digest: 'SHA256:' + AFFECTED_DIGEST.replace(/^sha256:/i, '').toUpperCase(), policy_parameters: {} } } });
  ok(r4.structuredContent?.state === 'LISTED-AFFECTED', 'journal shape + prefix/case normalized -> LISTED-AFFECTED');
  ok(r4.structuredContent?.kernel_digest_checked === AFFECTED_DIGEST.replace(/^sha256:/i, '').toLowerCase(), 'checked digest reported normalized');

  // NOT-ENGAGED: no digest anywhere.
  const r5 = await callTool('errata_check', { receipt: { note: 'no digest here' } });
  ok(r5.structuredContent?.state === 'NOT-ENGAGED', 'digestless receipt -> NOT-ENGAGED');

  // Non-object receipt: the SDK's zod layer pre-empts it at the transport boundary with its
  // own -32602 before the handler runs (the registry's invalid_args.errata_receipt path and
  // the module guard below are the in-process defense for callers that bypass zod).
  const r6 = await callTool('errata_check', { receipt: 'not-a-receipt' });
  ok(r6.isError === true, 'non-object receipt -> isError');
  ok(JSON.stringify(r6.content ?? []).includes('-32602'), 'transport-level refusal is a -32602');
});

// ── 7b. module-level guard: non-object input refuses without throwing (registry path) ──
{
  const bad = runErrataCheck({ receipt: 'not-a-receipt' });
  ok(bad.ok === false && typeof bad.error === 'string', 'runErrataCheck guard returns ok:false + reason for non-object input');
  ok(bad.error.includes('receipt object is required'), 'guard reason names the accepted receipt shapes');
}

// ── 8. STALE at module level: planted clock past expires_at, sentence verbatim ──
{
  // The reader's input contract takes the digest AS THE EXTRACTORS PRODUCE IT: no sha256:
  // prefix, lowercased (extractKernelDigest's output shape) -- the raw recorded form is what
  // the receipt carries, not what the reader input takes.
  const bareDigest = AFFECTED_DIGEST.replace(/^sha256:/i, '').toLowerCase();
  const synthetic = {
    checkpoint: { tree_size: 7, expires_at: 1000, staleness_sentence: 'staleness: past expiry, treat as unknown.' },
    entries: [ENTRY],
  };
  const stale = errataCheck(synthetic, { kernelDigest: bareDigest, policyParameters: {} }, 2000000);
  ok(stale.state === 'STALE', 'past expires_at -> STALE');
  ok(stale.sentence === 'staleness: past expiry, treat as unknown.', 'STALE passes the log sentence verbatim');
  const fresh = errataCheck(synthetic, { kernelDigest: bareDigest, policyParameters: {} }, 500000);
  ok(fresh.state === 'LISTED-AFFECTED', 'before expires_at the verdict still issues');
}

console.log(`\nerrata-check.test.mjs: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
