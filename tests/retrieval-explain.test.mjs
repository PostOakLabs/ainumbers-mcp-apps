#!/usr/bin/env node
// retrieval-explain.test.mjs — TOOL-RETRIEVAL-MEASURE-1 step 6 gates.
//
// Gates (from the row):
//   1. a term present in a doc's text but absent from the index idf map does NOT appear in
//      why_matched (zero-idf terms contributed nothing to the score and must never appear);
//   2. a deliberately partial query yields non-empty coverage_gaps;
//   3. why_matched is present on every result.
//
// Both keys are driven through the REAL find_tool / find_chain MCP surface (buildServer +
// InMemoryTransport + the vendored search-index.json), never through a re-implementation —
// the same posture as null-normalize.test.mjs.
//
// Usage: node --test tests/retrieval-explain.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer, widgetGlue, stripCspMeta } from '../worker.mjs';
import { PILOT } from '../pilot.mjs';

// EXACTLY the bm25Search tokenizer, mirrored locally ONLY to pick the probe token — the assertions
// themselves run against the real worker surface.
const explainable = (s) =>
  String(s ?? '').toLowerCase().replace(/[^a-z0-9_-]/g, ' ').split(/\s+/).filter((t) => t.length > 1);

const here = dirname(fileURLToPath(import.meta.url));
const DATA = resolve(here, '..', 'data');

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
    protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'retrieval-explain-test', version: '1' },
  }, 0);
  await clientT.send({ jsonrpc: '2.0', method: 'notifications/initialized' });

  const callTool = async (name, args) => {
    const resp = await rpc('tools/call', { name, arguments: args }, nextId++);
    if (resp.error) throw new Error('RPC error: ' + JSON.stringify(resp.error));
    if (resp.result?.isError) throw new Error('Tool error: ' + resp.result?.content?.[0]?.text);
    return resp.result.structuredContent;
  };

  const out = await fn(callTool);
  await clientT.close();
  await server.close();
  return out;
}

test('find_chain: why_matched present on every result, zero-idf terms never appear, partial query yields coverage_gaps', async () => {
  const data = loadDataFromDisk();
  // Deliberately partial query: '2052a' is heavily indexed; 'zzqxj' exists nowhere; 'liquidity'
  // hits chain prose. Confirms all three gates on one real call.
  const sc = await withServer(data, 'find_chain', (callTool) =>
    callTool('find_chain', { query: '2052a liquidity zzqxj classification', top_n: 5 }));
  assert.ok(Array.isArray(sc.chains) && sc.chains.length > 0, 'expected non-empty chain results');
  for (const r of sc.chains) {
    assert.ok(Array.isArray(r.why_matched), `why_matched missing on ${r.chain_name}`);
    for (const w of r.why_matched) {
      assert.ok(w.term !== 'zzqxj', `zero-idf term leaked into why_matched: ${w.term}`);
      assert.ok(Array.isArray(w.fields) && w.fields.length > 0, `why_matched entry without a field: ${w.term}`);
    }
    const terms = r.why_matched.map((w) => w.term);
    assert.ok(terms.includes('2052a'), `scoring term 2052a missing from why_matched on ${r.chain_name}`);
  }
  assert.ok(Array.isArray(sc.coverage_gaps) && sc.coverage_gaps.length > 0, 'expected non-empty coverage_gaps for the partial query');
  assert.ok(sc.coverage_gaps.some((g) => g.includes('zzqxj')), 'coverage_gaps must name the zero-idf term');
  assert.ok(sc.coverage_gaps.every((g) => !g.includes('2052a')), 'indexed terms must not be reported as coverage gaps');
});

test('find_tool: why_matched present on every result; term in doc prose but with zero idf stays out of why_matched', async () => {
  const data = loadDataFromDisk();
  const sc = await withServer(data, 'find_tool', (callTool) =>
    callTool('find_tool', { query: 'reconciliation zzqxj attestation', top_n: 5 }));
  assert.ok(Array.isArray(sc.tools) && sc.tools.length > 0, 'expected non-empty tool results');
  for (const r of sc.tools) {
    assert.ok(Array.isArray(r.why_matched), `why_matched missing on ${r.tool_id}`);
    const terms = r.why_matched.map((w) => w.term);
    assert.ok(!terms.includes('zzqxj'), `zero-idf term leaked into why_matched: ${r.tool_id}`);
    for (const w of r.why_matched) {
      assert.ok(Array.isArray(w.fields) && w.fields.length > 0, `why_matched entry without a field: ${w.term}`);
    }
  }
  assert.ok(Array.isArray(sc.coverage_gaps) && sc.coverage_gaps.length > 0, 'expected non-empty coverage_gaps for the partial query');
});

test('zero-idf guard holds even when the term IS present in a returned doc field (gate 1 in its strict form)', async () => {
  const data = loadDataFromDisk();
  const index = data.searchIndex.chains;
  // Pick any chain doc and any token of its own text that the index never scored (idf not > 0 —
  // 'https'-class tokens that appear across nearly every doc have zero idf and contribute nothing).
  let probe = null;
  for (const d of index.docs) {
    const text = Object.entries(d).filter(([, v]) => typeof v === 'string').map(([, v]) => v).join(' ');
    const zeroIdfTok = text.split(/\s+/).length && explainable(text).find((t) => !((index.idf?.[t] ?? 0) > 0));
    if (zeroIdfTok) { probe = { doc: d, term: zeroIdfTok }; break; }
  }
  assert.ok(probe, 'no zero-idf token found in any chain title; strict-form gate not exercisable on this index');
  const sc = await withServer(data, 'find_chain', (callTool) =>
    callTool('find_chain', { query: probe.term + ' liquidity', top_n: 20 }));
  const hit = (sc.chains ?? []).find((r) => r.chain_name === probe.doc.chain_name);
  assert.ok(hit, 'probe chain not returned');
  assert.ok(!hit.why_matched.some((w) => w.term === probe.term),
    `term "${probe.term}" is in doc text but has zero idf — it must not appear in why_matched`);
});
