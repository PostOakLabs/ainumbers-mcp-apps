#!/usr/bin/env node
// gate-tool-selection-eval.mjs — MCP-500-2 §M2.4.
//
// Smoke proves tools WORK; this proves agents can FIND them at 300+ registered tools. Runs a
// fixed, deterministic set of natural-language task descriptions through find_tool (BM25 search,
// no live model call — never flaky) and asserts the expected mcp_name lands in the top-N results.
// Negative-tested (FIXTURES_NEGATIVE): a deliberately WRONG expected-tool is asserted to fail, so
// this gate is proven to actually discriminate rather than always pass.
//
// Run: node scripts/gate-tool-selection-eval.mjs

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer, widgetGlue, stripCspMeta } from '../worker.mjs';
import { PILOT } from '../pilot.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = resolve(ROOT, 'data');
const TOP_N = 5;

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
  };
}

async function rpcOnce(server, method, params) {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  await clientT.start();
  const pending = new Map();
  clientT.onmessage = (msg) => {
    if (msg && msg.id !== undefined && pending.has(msg.id)) {
      const { resolve: r } = pending.get(msg.id); pending.delete(msg.id); r(msg);
    }
  };
  const rpc = (m, p, id) => new Promise((r) => { pending.set(id, { resolve: r }); clientT.send({ jsonrpc: '2.0', id, method: m, params: p }); });
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'selection-eval', version: '1' } }, 0);
  await clientT.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const out = await rpc(method, params, 1);
  await clientT.close(); await server.close();
  return out;
}

// Fixed task -> expected-mcp_name fixtures. Deterministic (BM25, no live model call). Keep
// task phrasing close to how an agent would actually describe the need — that's what this gate
// is proving discoverability against. find_tool's BM25 index covers live ChainGraph NODE tools
// only (not PILOT browser widgets or the 9 utility tools) — every expect: below must be a live
// chaingraph.json node's mcp_name.
const FIXTURES = [
  { task: 'FRTB expected shortfall calculation',                          expect: 'simulate_frtb_es' },
  { task: 'MiCA own funds requirement for a crypto-asset issuer',         expect: 'calculate_mica_own_funds' },
  { task: 'compute XVA for a derivatives portfolio',                     expect: 'calculate_xva' },
  { task: 'score a synthetic transaction graph against AML typologies and FATF Travel Rule', expect: 'score_aml_typologies' },
  { task: 'HMDA rate spread computation for a mortgage loan',            expect: 'compute_hmda_rate_spread' },
  { task: 'DORA ICT third-party risk readiness diagnostic',              expect: 'run_dora_readiness_diagnostic' },
  { task: 'EMIR UTI completeness check on a trade report',               expect: 'check_emir_uti_completeness' },
  { task: 'stablecoin reserve attestation simulation',                   expect: 'simulate_stablecoin_reserve' },
  { task: 'repo haircut calculation for a securities financing trade',    expect: 'calculate_repo_haircut' },
  { task: 'IRRBB EVE shock scenario calculation',                        expect: 'calculate_irrbb_eve_shocks' },
  { task: 'CBAM embedded emissions calculation for imported goods',      expect: 'calculate_cbam_embedded_emissions' },
  { task: 'validate an SPDX software bill of materials',                 expect: 'validate_spdx_sbom' },
  { task: 'check EUDR due diligence statement for deforestation risk',   expect: 'validate_eudr_due_diligence_statement' },
  { task: 'calibrate sanctions fuzzy-match Jaro-Winkler Levenshtein thresholds', expect: 'score_fuzzy_match_calibration' },
  { task: 'compute perpetual futures funding rate',                      expect: 'compute_perp_funding' },
];

// Negative control: this task's TRUE best match is NOT the (deliberately wrong) expected tool —
// proves the gate can fail, not just always pass.
const NEGATIVE_FIXTURE = { task: 'FRTB expected shortfall calculation', expect: 'calculate_mica_own_funds' };

async function evalFixture({ task, expect }) {
  const data = loadDataFromDisk();
  const server = buildServer(data, {});
  const res = await rpcOnce(server, 'tools/call', { name: 'find_tool', arguments: { query: task, top_n: TOP_N } });
  const tools = res?.result?.structuredContent?.tools ?? [];
  const names = tools.map((t) => t.mcp_name);
  return { hit: names.includes(expect), names };
}

async function main() {
  let failed = 0;
  console.log('▶ positive fixtures (expected mcp_name must appear in top-' + TOP_N + ' find_tool results)');
  for (const f of FIXTURES) {
    const { hit, names } = await evalFixture(f);
    if (hit) console.log('  ✓ "' + f.task + '" -> ' + f.expect);
    else { console.error('  ✗ "' + f.task + '" -> expected ' + f.expect + ', got [' + names.join(', ') + ']'); failed++; }
  }

  console.log('▶ negative control (deliberately wrong expected-tool must FAIL — proves the gate discriminates)');
  {
    const { hit, names } = await evalFixture(NEGATIVE_FIXTURE);
    if (!hit) console.log('  ✓ negative control correctly failed to match "' + NEGATIVE_FIXTURE.expect + '" (got [' + names.join(', ') + '])');
    else { console.error('  ✗ negative control matched — gate is not discriminating (always-pass risk)'); failed++; }
  }

  if (failed) { console.error(`\n${failed} check(s) FAILED`); process.exit(1); }
  console.log('All tool-selection fixtures passed.');
}

main().catch((e) => { console.error(e); process.exit(1); });
