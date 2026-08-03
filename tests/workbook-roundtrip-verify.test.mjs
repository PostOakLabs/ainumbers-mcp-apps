#!/usr/bin/env node
// workbook-roundtrip-verify.test.mjs — XLR-4 done-criteria (WORKBOOK-ROUNDTRIP-BUILD-SPEC.md §XLR-4).
//
// Proves `workbook_roundtrip_verify` is SAME SIGNATURE, SAME BEHAVIOUR as the site's
// XLR-2 comparator (repo/chaingraph/workbook/roundtrip-verify.mjs), not a fork:
//   (1) the vendored ./workbook/roundtrip-verify.mjs is byte-identical to the site
//       source it was vendored from (verbatim vendor discipline, generate.mjs).
//   (2) calling the live tool through a real MCP server (same in-memory-transport
//       harness as tests/anchor-stamp.test.mjs) on the SAME fixture the site's
//       roundtrip-verify.test.mjs uses (identical values -> match; a perturbed cell
//       -> mismatch naming that cell) produces the SAME receipt shape the site
//       comparator produces for that input.
//   (3) CSV-injection sanitization travels with the tool (paste-intake safety
//       rules aren't page-only, per the row's fence note).
//
// Usage: node tests/workbook-roundtrip-verify.test.mjs

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer, widgetGlue, stripCspMeta } from '../worker.mjs';
import { PILOT } from '../pilot.mjs';
import { csvToWorkbook, fullRangeRef, rangeDigest } from '../workbook/workbook.mjs';

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
const ok = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) failed++; };
const eq = (actual, expected, msg) => ok(JSON.stringify(actual) === JSON.stringify(expected), `${msg} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);

console.log('— XLR-4: workbook_roundtrip_verify worker-tool parity —\n');

// ── 1. verbatim-vendor proof: the bundled module is byte-identical to the site source ──
{
  const siteSrc = readFileSync(resolve(ROOT, '..', 'repo', 'chaingraph', 'workbook', 'roundtrip-verify.mjs'));
  const vendoredBundle = readFileSync(resolve(ROOT, 'workbook', 'roundtrip-verify.mjs'));
  const vendoredData = readFileSync(resolve(DATA, 'workbook', 'roundtrip-verify.mjs'));
  ok(siteSrc.equals(vendoredBundle), 'worker bundle ./workbook/roundtrip-verify.mjs is byte-identical to repo/chaingraph/workbook/roundtrip-verify.mjs -- no forked logic');
  ok(siteSrc.equals(vendoredData), 'data/workbook/roundtrip-verify.mjs (ASSETS target) is byte-identical to the site source');
}

async function manifestFor(csvText, ref, sourceCsvDigest) {
  const wb = csvToWorkbook(csvText);
  const fullRange = fullRangeRef(wb);
  return {
    manifest_type: 'spreadsheet-input-manifest',
    source: { filename: 'line-items.csv', csv_digest: sourceCsvDigest },
    ranges: [{ ref, values_digest: await rangeDigest(wb, fullRange), semantics: 'unit fixture' }],
    produced_by: 'workbook-roundtrip-verify.test.mjs fixture',
    produced_at: '2026-08-03T00:00:00Z',
  };
}

const data = loadDataFromDisk();

await withServer(data, 'workbook_roundtrip_verify', async (callTool) => {
  // ── 2. same fixture as the site's XLR-2 test, case "identical values -> match" ──
  {
    const csv = '10,widget\r\n20,gadget\r\n';
    const manifest = await manifestFor(csv, 'A1:B2', 'src-digest-1');
    const receipt = parse(await callTool('workbook_roundtrip_verify', {
      manifest, observed_by_ref: { 'A1:B2': csv },
      produced_by: 'test', produced_at: '2026-08-03T01:00:00Z',
    }));
    eq(receipt.receipt_type, 'workbook-roundtrip-receipt', 'receipt_type is set');
    eq(receipt.result, 'match', 'identical pasted values -> result "match" (same as site comparator)');
    eq(receipt.mismatches, [], 'match receipt has empty mismatches[]');
    eq(receipt.expected.ranges[0].values_digest, receipt.observed.ranges[0].values_digest, 'expected/observed digests equal on match');
  }

  // ── 3. same fixture, case "a perturbed cell -> mismatch naming that cell" ──
  {
    const expectedCsv = '10,widget\r\n20,gadget\r\n';
    const observedCsv = '10,widget\r\n25,gadget\r\n'; // A2 perturbed 20 -> 25
    const manifest = await manifestFor(expectedCsv, 'A1:B2', 'src-digest-2');
    const receipt = parse(await callTool('workbook_roundtrip_verify', {
      manifest,
      observed_by_ref: { 'A1:B2': observedCsv },
      expected_by_ref: { 'A1:B2': expectedCsv },
      produced_by: 'test', produced_at: '2026-08-03T02:00:00Z',
    }));
    eq(receipt.result, 'mismatch', 'a perturbed cell -> result "mismatch"');
    eq(receipt.mismatches.length, 1, 'exactly one cell differs -> one mismatches[] entry');
    eq(receipt.mismatches[0].ref, 'A2', 'mismatch entry names the diverging cell A2');
    eq(receipt.mismatches[0].expected_value, 20, 'mismatch entry carries the expected value');
    eq(receipt.mismatches[0].observed_value, 25, 'mismatch entry carries the observed value');
  }

  // ── 4. CSV-injection sanitization travels with the worker tool (fence note) ──
  {
    const expectedCsv = '10,widget\r\n';
    const observedCsv = '+1+1,widget\r\n';
    const manifest = await manifestFor(expectedCsv, 'A1:B1', 'src-digest-3');
    const receipt = parse(await callTool('workbook_roundtrip_verify', {
      manifest,
      observed_by_ref: { 'A1:B1': observedCsv },
      expected_by_ref: { 'A1:B1': expectedCsv },
      produced_by: 'test', produced_at: '2026-08-03T03:00:00Z',
    }));
    const cell = receipt.mismatches.find((m) => m.ref === 'A1');
    ok(!!cell, 'the A1 mismatch entry is present');
    eq(cell.observed_value, "'+1+1", 'formula-injection observed value is sanitized before entering the receipt, same as the site tool');
  }

  // ── 5. finite-gate: malformed pasted CSV is rejected via the MCP error path ──
  {
    const manifest = await manifestFor('10,widget\r\n', 'A1:B1', 'src-digest-4');
    const result = await callTool('workbook_roundtrip_verify', {
      manifest, observed_by_ref: { 'A1:B1': 'a"b,c' },
      produced_by: 'test', produced_at: '2026-08-03T04:00:00Z',
    });
    ok(result?.isError === true, 'malformed pasted CSV surfaces as an MCP tool error, not a silently-repaired receipt');
  }
});

console.log(`\n${failed === 0 ? '✅ ALL CHECKS PASSED' : `❌ ${failed} CHECK(S) FAILED`}`);
process.exit(failed === 0 ? 0 : 1);
