#!/usr/bin/env node
// check-tool-description-quality.mjs — M2.1 dogfood gate (MCP-500-2 §M2.1).
//
// Runs the suite's OWN lint_mcp_tool_definition ruleset (ported logic, scripts/lib/mcp-tool-lint.mjs
// — the site tool's execution_type is "browser-reference" so it has no server-callable *.kernel.mjs
// to invoke directly) over every tool definition the worker actually registers (buildServer's full
// tools/list, not the lean-default advertised subset — deferred tools still get linted).
//
// Baseline-shield (mirrors the site's copy-hallmarks-baseline.json pattern): tools already below the
// bar at the time this gate landed are recorded in data/mcp-lint-baseline.json so the gate lands
// strict-FORWARD without a 300+ description rewrite blocking it. The baseline may only SHRINK
// (counts-only-down) — any name in the baseline that now scores >= BAR is reported as stale and must
// be removed from the baseline file; any NEW sub-bar tool not already in the baseline fails the gate.
//
// Run: node scripts/check-tool-description-quality.mjs
//      UPDATE_BASELINE=1 node scripts/check-tool-description-quality.mjs   (regenerate baseline; use
//        only when deliberately accepting new sub-bar tools, never to silence a real regression)

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer, widgetGlue, stripCspMeta } from '../worker.mjs';
import { PILOT } from '../pilot.mjs';
import { lintToolDef, scoreOf } from './lib/mcp-tool-lint.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = resolve(ROOT, 'data');
const BASELINE_PATH = resolve(DATA, 'mcp-lint-baseline.json');
const BAR = 60; // must match the "Conformant" reference-tool threshold used by the linter's own UI

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
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'lint-quality-gate', version: '1' } }, 0);
  await clientT.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const out = await rpc(method, params, 1);
  await clientT.close(); await server.close();
  return out;
}

async function main() {
  const data = loadDataFromDisk();
  const server = buildServer(data, {});
  const listed = await rpcOnce(server, 'tools/list', {});
  const tools = listed?.result?.tools;
  if (!Array.isArray(tools) || tools.length < 300) {
    console.error('FATAL: tools/list returned ' + (tools?.length ?? 'nothing') + ' tools (expected 300+). Aborting gate.');
    process.exit(1);
  }

  const baseline = existsSync(BASELINE_PATH) ? JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) : { subBarTools: [] };
  const baselineSet = new Set(baseline.subBarTools || []);

  const scored = tools.map((t) => {
    const def = { name: t.name, description: t.description, inputSchema: t.inputSchema, outputSchema: t.outputSchema, annotations: t.annotations };
    const findings = lintToolDef(def);
    const sc = scoreOf(findings);
    return { name: t.name, score: sc.score, errors: sc.e, warns: sc.w, findings };
  });

  const subBar = scored.filter((s) => s.score < BAR);
  const subBarNames = new Set(subBar.map((s) => s.name));

  if (process.env.UPDATE_BASELINE === '1') {
    writeFileSync(BASELINE_PATH, JSON.stringify({ bar: BAR, subBarTools: [...subBarNames].sort() }, null, 2) + '\n');
    console.log('Baseline written: ' + subBarNames.size + ' sub-bar tool(s) at bar=' + BAR + '.');
    return;
  }

  const newSubBar = subBar.filter((s) => !baselineSet.has(s.name));
  const staleBaseline = [...baselineSet].filter((n) => !subBarNames.has(n));

  console.log('Linted ' + scored.length + ' registered tool definitions (bar=' + BAR + ').');
  console.log('  sub-bar total:    ' + subBar.length);
  console.log('  baseline-shielded:' + ' ' + (subBar.length - newSubBar.length));
  console.log('  NEW sub-bar:      ' + newSubBar.length);
  console.log('  stale baseline:   ' + staleBaseline.length + ' (now score >= bar; must be removed from baseline)');

  let ok = true;
  if (newSubBar.length > 0) {
    ok = false;
    console.error('\nFAIL: new sub-bar tool description(s) not in baseline:');
    for (const s of newSubBar) {
      console.error('  - ' + s.name + ' (score ' + s.score + ', ' + s.errors + ' error/' + s.warns + ' warn)');
      for (const f of s.findings.filter((f) => f.level !== 'pass')) console.error('      [' + f.level.toUpperCase() + '] ' + f.msg);
    }
  }
  if (staleBaseline.length > 0) {
    ok = false;
    console.error('\nFAIL: baseline is stale (counts-only-down) — these tools now score >= bar and must be removed from ' + BASELINE_PATH + ':');
    for (const n of staleBaseline) console.error('  - ' + n);
    console.error('Fix: UPDATE_BASELINE=1 node scripts/check-tool-description-quality.mjs');
  }

  if (!ok) process.exit(1);
  console.log('\nOK: no new sub-bar descriptions; baseline current.');
}

main().catch((e) => { console.error(e); process.exit(1); });
