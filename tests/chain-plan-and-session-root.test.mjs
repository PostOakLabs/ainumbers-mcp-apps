#!/usr/bin/env node
// chain-plan-and-session-root.test.mjs — COMPOSER-PLAN-AND-ROOT-WEBMCP-1 done-criteria, worker side.
//
// Asserts, against the VENDORED data/ (generate.mjs cycle, committed same push):
//   1. PLAN PARITY — for EVERY chain in data/chaingraph/chaingraph.json, the plan
//      preimage (the identical preimage the composer pages hash) recomputed with the
//      SSOT hasher kernels/_hash.mjs equals the vendored committed set
//      data/chain-plan-hashes.json (369/369).
//   2. build_chaingraph emits chain_plan + chain_plan_hash, and for a sampled chain
//      the emitted hash equals the vendored set value (and is null for a
//      non-chain step sequence).
//   3. SESSION-ROOT PARITY — the REAL build_session_receipt tool (InMemoryTransport,
//      same harness as tests/showcase-prompts.test.mjs) reproduces the expected
//      session_receipt_root of EVERY fixture in data/session-root-fixtures.json —
//      the same fixture file the site's scripts/session-root-parity.test.mjs asserts
//      the page/bridge routine against. One fixture truth, both runtimes.
//
// Usage: node tests/chain-plan-and-session-root.test.mjs   (also runs under `node --test`)

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer, widgetGlue, stripCspMeta } from '../worker.mjs';
import { PILOT } from '../pilot.mjs';
import { executionHash } from '../kernels/_hash.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = resolve(ROOT, 'data');

function loadDataFromDisk() {
  const get = (p) => readFileSync(resolve(DATA, p), 'utf8');
  const glue = widgetGlue(get('ext-apps-inline.js'));
  const manifests = {}, widgets = {};
  for (const slug of PILOT) {
    manifests[slug] = JSON.parse(get('manifests/' + slug + '.manifest.json'));
    widgets[slug] = stripCpsMetaSafe(get('tools/' + slug + '.html'), glue);
  }
  return {
    manifests, widgets,
    catalog: JSON.parse(get('mcp/catalog.json')),
    chaingraph: JSON.parse(get('chaingraph/chaingraph.json')),
    searchIndex: JSON.parse(get('search-index.json')),
    chainFixtures: JSON.parse(get('chain-fixtures.json')),
  };
}
function stripCpsMetaSafe(html, glue) { return stripCspMeta(html) + glue; }

// The composer pages' buildPreimage (chaingraph/chains/build-chain-pages.mjs) —
// mirrored here ONLY as test oracle input; the hash itself comes from the SSOT
// kernels/_hash.mjs, and check 1 pins all 369 against the committed set.
function planPreimage(chain) {
  const steps = chain.steps ?? [];
  return {
    policy_parameters: {
      execution_backend: 'browser',
      chain_id: chain.name,
      step_count: steps.length,
      step_tool_ids: steps.map((s) => s.tool_id),
    },
    output_payload: {
      chain_title: chain.title,
      chain_description: chain.description,
      steps: steps.map((s) => ({ tool_id: s.tool_id, handoff: s.handoff })),
    },
  };
}

let failed = 0;
function check(name, cond, detail = '') {
  console.log((cond ? '  ok  ' : '  ✗ FAIL ') + name + (cond || !detail ? '' : ' — ' + detail));
  if (!cond) failed++;
}

async function withServer(data, fn) {
  const server = buildServer(data);
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
  const rpc = (method, params) => new Promise((res) => {
    const id = nextId++;
    pending.set(id, res);
    clientT.send({ jsonrpc: '2.0', id, method, params });
  });
  try { await fn(rpc); } finally { await clientT.close().catch(() => {}); }
}

async function main() {
  const data = loadDataFromDisk();
  const chains = (data.chaingraph.chains ?? []).filter((c) => c.name && Array.isArray(c.steps) && c.steps.length > 0);
  const committed = JSON.parse(readFileSync(resolve(DATA, 'chain-plan-hashes.json'), 'utf8')).hashes ?? {};
  check('vendored chain-plan-hashes covers every chain', chains.length > 0 && chains.every((c) => c.name in committed), `chains=${chains.length} committed=${Object.keys(committed).length}`);

  // 1. Plan parity, all chains, SSOT hasher.
  let mismatches = 0;
  for (const chain of chains) {
    const pp = planPreimage(chain);
    const hash = await executionHash(pp.policy_parameters, pp.output_payload);
    if (hash !== committed[chain.name]) mismatches++;
  }
  check(`plan parity: all ${chains.length} chain plan hashes equal the vendored committed set`, mismatches === 0, `${mismatches} mismatch(es)`);

  // 2. build_chaingraph emits the plan fields.
  const sample = chains.find((c) => c.name === 'agent-identity-verification') ?? chains[0];
  await withServer(data, async (rpc) => {
    const msg = await rpc('tools/call', {
      name: 'build_chaingraph',
      arguments: { tool_ids: sample.steps.map((s) => s.tool_id) },
    });
    const sc = msg.result?.structuredContent ?? {};
    check('build_chaingraph emits chain_plan_hash for a named chain', sc.chain_plan_hash === committed[sample.name],
      `got ${JSON.stringify(sc.chain_plan_hash).slice(0, 80)}`);
    check('build_chaingraph chain_plan carries the identical preimage',
      sc.chain_plan?.policy_parameters?.chain_id === sample.name &&
      sc.chain_plan?.policy_parameters?.step_count === sample.steps.length &&
      sc.chain_plan?.output_payload?.steps?.length === sample.steps.length &&
      sc.chain_plan?.output_payload?.steps?.every((s, i) => s.tool_id === sample.steps[i].tool_id && s.handoff === sample.steps[i].handoff),
      JSON.stringify(sc.chain_plan).slice(0, 120));
    // Non-chain sequence -> null plan fields (honest absence, never invented).
    const nonChain = await rpc('tools/call', {
      name: 'build_chaingraph',
      arguments: { tool_ids: [...sample.steps.map((s) => s.tool_id)].reverse() },
    });
    const sc2 = nonChain.result?.structuredContent ?? {};
    check('build_chaingraph leaves chain_plan null for a non-chain sequence',
      sc2.chain_plan === null && sc2.chain_plan_hash === null,
      JSON.stringify({ p: sc2.chain_plan, h: sc2.chain_plan_hash }).slice(0, 80));
    // 3. Session-root parity over the REAL tool.
    const fixtures = JSON.parse(readFileSync(resolve(DATA, 'session-root-fixtures.json'), 'utf8'));
    check('vendored session-root fixtures present (>= 5)', (fixtures.fixtures ?? []).length >= 5, String((fixtures.fixtures ?? []).length));
    for (const fx of fixtures.fixtures) {
      const r = await rpc('tools/call', {
        name: 'build_session_receipt',
        arguments: { execution_hashes: fx.execution_hashes },
      });
      if (r.result?.isError) { check(`session receipt fixture "${fx.name}"`, false, JSON.stringify(r.result).slice(0, 120)); continue; }
      // structuredContent carries the receipt object directly.
      const sc3 = r.result?.structuredContent;
      const root = sc3?.session_receipt_root ?? null;
      check(`session receipt root matches fixture "${fx.name}"`, root === fx.expected_session_receipt_root,
        `got ${JSON.stringify(root)}`);
    }
  });

  console.log(failed === 0 ? 'CHAIN-PLAN-AND-SESSION-ROOT: PASS' : `CHAIN-PLAN-AND-SESSION-ROOT: FAIL (${failed})`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
