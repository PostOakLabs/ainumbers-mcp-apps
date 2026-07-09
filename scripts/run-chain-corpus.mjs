#!/usr/bin/env node
// run-chain-corpus.mjs — audit Suite E1/E3: full-corpus named-chain E2E execution
// + v0.4 schema conformance for EVERY emitted artifact.
//
// scripts/test-run-chain-fixtures.mjs only smoke-tests ONE example chain
// (agent-commerce-conformance) as a proof that the fixture-default mechanism
// works. It does NOT run the other 146 fixture-backed chains, so a kernel
// regression or a stale fixture on any of them can silently ship. This script
// closes that gap: it drives run_chain (via the SAME embedded InMemoryTransport
// mechanism as test-run-chain-fixtures.mjs — no network, no live worker) for
// EVERY chain in data/chain-fixtures.json, and additionally validates each
// chain's final composite_artifact against the OCG v0.4 JSON Schema by
// shelling out to the site repo's chaingraph/standard/schema-validate.mjs
// (reused as-is — this script does not reimplement schema/AJV logic).
//
// For each fixture-backed chain, asserts:
//   - run_chain completes without throwing
//   - non-gated chains: steps_ran === step_count (every step executed "ok")
//   - gated chains (>=1 step has a `gate`): 1 <= steps_ran <= step_count
//     (a gate may legitimately route past later steps — see gate-parity.mjs
//     and OCG §21.4/§22.8; that is expected routing, not a failure)
//   - composite_execution_hash is a 64-char hex string
//   - re-running the SAME chain a second time yields a byte-identical
//     composite_execution_hash (determinism)
//   - the final composite_artifact validates against the v0.4 JSON Schema
//
// Usage:
//   node scripts/run-chain-corpus.mjs                 # every fixture-backed chain
//   node scripts/run-chain-corpus.mjs <chain-name>     # single chain
//   node scripts/run-chain-corpus.mjs --fixtures=<path-to-chain-fixtures.json>
//     # override the fixtures file (used to prove the gate catches a corrupted
//     # fixture — see the defect-injection demo in the audit report; never point
//     # this at anything but a scratch file)
//
// Exit code: 1 if any chain fails to run/validate, or the schema validator
// cannot be located; 0 otherwise.

import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer, widgetGlue, stripCspMeta } from '../worker.mjs';
import { PILOT } from '../pilot.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = resolve(ROOT, 'data');

function firstExisting(paths) { return paths.find((p) => existsSync(p)) || null; }

const rawArgs = process.argv.slice(2);
const fixturesArg = rawArgs.find((a) => a.startsWith('--fixtures='));
const FIXTURES_OVERRIDE = (fixturesArg && fixturesArg.slice('--fixtures='.length)) || process.env.FIXTURES_OVERRIDE || null;
const chainFilter = rawArgs.find((a) => !a.startsWith('--')) || null;

// Mirror precompute-discovery.mjs loadDataFromDisk (same shape used by
// test-run-chain-fixtures.mjs / gate-parity.test.mjs) — must include chainFixtures.
function loadDataFromDisk() {
  const get = (p) => readFileSync(resolve(DATA, p), 'utf8');
  const glue = widgetGlue(get('ext-apps-inline.js'));
  const manifests = {}, widgets = {};
  for (const slug of PILOT) {
    manifests[slug] = JSON.parse(get('manifests/' + slug + '.manifest.json'));
    widgets[slug] = stripCspMeta(get('tools/' + slug + '.html')) + glue;
  }
  const chainFixtures = FIXTURES_OVERRIDE
    ? JSON.parse(readFileSync(resolve(FIXTURES_OVERRIDE), 'utf8'))
    : JSON.parse(get('chain-fixtures.json'));
  return {
    manifests, widgets,
    catalog: JSON.parse(get('mcp/catalog.json')),
    chaingraph: JSON.parse(get('chaingraph/chaingraph.json')),
    searchIndex: JSON.parse(get('search-index.json')),
    chainFixtures,
  };
}

async function runChain(data, chainName) {
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
  const rpc = (method, params, id) => new Promise((res) => {
    pending.set(id, res);
    clientT.send({ jsonrpc: '2.0', id, method, params });
  });

  await rpc('initialize', {
    protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'run-chain-corpus', version: '1' },
  }, 0);
  await clientT.send({ jsonrpc: '2.0', method: 'notifications/initialized' });

  const resp = await rpc('tools/call', {
    name: 'run_chain',
    arguments: { chain: chainName },  // NO inputs — must fall back to fixture defaults
  }, 1);

  await clientT.close();
  await server.close();

  if (resp.error) throw new Error('RPC error: ' + JSON.stringify(resp.error));
  if (resp.result?.isError) throw new Error('Tool error: ' + resp.result?.content?.[0]?.text);

  const text = resp.result?.content?.[0]?.text;
  if (!text) throw new Error('Empty response');
  return JSON.parse(text);
}

async function main() {
  const data = loadDataFromDisk();
  const chainsByName = new Map((data.chaingraph.chains || []).map((c) => [c.name, c]));
  const allFixtureNames = Object.keys(data.chainFixtures || {}).filter((n) => chainsByName.has(n));
  const targets = chainFilter ? allFixtureNames.filter((n) => n === chainFilter) : allFixtureNames;

  if (chainFilter && targets.length === 0) {
    console.error(`✗ chain "${chainFilter}" not found in the fixtures file (or has no matching chaingraph.json entry).`);
    process.exit(1);
  }

  console.log(`\n▶ run-chain-corpus: ${targets.length} fixture-backed chain(s) of ${data.chaingraph.chains.length} named chains` +
    (FIXTURES_OVERRIDE ? `  [fixtures override: ${FIXTURES_OVERRIDE}]` : '') + '\n');

  const scratchDir = mkdtempSync(join(tmpdir(), 'ocg-run-chain-corpus-'));
  const results = [];

  for (const name of targets) {
    const chain = chainsByName.get(name);
    const hasGates = (chain.steps || []).some((s) => s && s.gate);
    const reasons = [];
    let r1, r2;

    try {
      r1 = await runChain(data, name);
    } catch (err) {
      results.push({ name, ok: false, reasons: [`run 1 threw: ${err.message}`] });
      continue;
    }
    try {
      r2 = await runChain(data, name);
    } catch (err) {
      results.push({ name, ok: false, reasons: [`run 2 threw: ${err.message}`] });
      continue;
    }

    if (!hasGates && r1.steps_ran !== r1.step_count) {
      const badSteps = (r1.steps || [])
        .filter((s) => s.status !== 'ok')
        .map((s) => `${s.tool_id}:${s.status}${s.error ? ` (${s.error})` : ''}`);
      reasons.push(`steps_ran ${r1.steps_ran} !== step_count ${r1.step_count} on a non-gated chain — non-ok steps: ${badSteps.join('; ') || '(none reported)'}`);
    }
    if (hasGates && (r1.steps_ran < 1 || r1.steps_ran > r1.step_count)) {
      reasons.push(`steps_ran ${r1.steps_ran} out of expected range [1, ${r1.step_count}] for a gated chain`);
    }

    const hashOk = typeof r1.composite_execution_hash === 'string' && /^[0-9a-f]{64}$/.test(r1.composite_execution_hash);
    if (r1.steps_ran > 0 && !hashOk) {
      reasons.push(`composite_execution_hash is not 64-char hex: ${JSON.stringify(r1.composite_execution_hash)}`);
    }
    if (r1.steps_ran === 0) {
      reasons.push('0 steps ran — fixture defaults produced no executable step (first step kernel failure or missing fixture)');
    }
    if (r1.composite_execution_hash !== r2.composite_execution_hash) {
      reasons.push(`non-deterministic composite_execution_hash: run1=${r1.composite_execution_hash} run2=${r2.composite_execution_hash}`);
    }

    if (r1.composite_artifact) {
      writeFileSync(join(scratchDir, `${name}.json`), JSON.stringify({ artifact: r1.composite_artifact }));
    } else if (r1.steps_ran > 0) {
      reasons.push('steps_ran > 0 but composite_artifact is null');
    }

    results.push({ name, ok: reasons.length === 0, reasons, hasGates, steps_ran: r1.steps_ran, step_count: r1.step_count });
  }

  // ── Suite E3 — schema conformance. Reuse the SSOT validator (no reimplemented AJV logic). ──
  const schemaDir = firstExisting([
    resolve(ROOT, '..', 'repo', 'chaingraph', 'standard'),   // local sibling checkout (this worktree layout)
    resolve(ROOT, '_site', 'chaingraph', 'standard'),        // CI: site repo checked out to _site
  ]);

  let schemaSkipped = false;
  const schemaFailuresByChain = new Map();

  if (!schemaDir) {
    schemaSkipped = true;
    console.log('⚠ Could not locate chaingraph/standard/schema-validate.mjs (no sibling ../repo and no ./_site checkout).');
  } else {
    const script = join(schemaDir, 'schema-validate.mjs');
    let out = '';
    try {
      out = execFileSync(process.execPath, [script], {
        env: {
          ...process.env,
          SCHEMA: join(schemaDir, 'openchain-graph-v0.4.schema.json'),
          CHAINGRAPH: join(scratchDir, '__no_chaingraph_here__.json'), // intentionally absent — we're only validating fixtures[]
          FIXTURES_DIR: scratchDir,
        },
        encoding: 'utf8',
      });
    } catch (err) {
      out = String(err.stdout || '') + String(err.stderr || '');
    }
    console.log('— schema-validate.mjs output —');
    console.log(out.trim());
    console.log('— end schema-validate.mjs output —\n');

    // Attribute "✗ fixture <chainName>.json#0" blocks back to the owning chain.
    let current = null;
    for (const line of out.split('\n')) {
      const m = line.match(/^✗ fixture (.+)\.json#\d+/);
      if (m) { current = m[1]; schemaFailuresByChain.set(current, []); continue; }
      if (current && /^\s{4}\S/.test(line)) { schemaFailuresByChain.get(current).push(line.trim()); continue; }
      current = null;
    }
  }

  rmSync(scratchDir, { recursive: true, force: true });

  for (const r of results) {
    if (schemaFailuresByChain.has(r.name)) {
      r.ok = false;
      r.reasons.push(`schema-invalid (v0.4): ${schemaFailuresByChain.get(r.name).join(' | ')}`);
    }
  }

  const passed = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);

  console.log('════ run-chain-corpus summary ════');
  console.log(`  fixture-backed chains attempted : ${results.length}`);
  console.log(`  passed                          : ${passed.length}`);
  console.log(`  failed                          : ${failed.length}`);
  if (failed.length) {
    console.log('\n  FAILURES:');
    for (const f of failed) {
      console.log(`   ✗ ${f.name}`);
      for (const reason of f.reasons) console.log(`       - ${reason}`);
    }
  }
  console.log('');

  if (schemaSkipped) {
    console.error('✗ schema-validate.mjs could not be located — treating as FAIL (Suite E3 requires schema conformance for every artifact).');
  }
  if (failed.length || schemaSkipped) process.exit(1);

  console.log(`✅ run-chain-corpus: ${passed.length}/${results.length} fixture-backed chains ran E2E, deterministic, and v0.4.0 schema-valid.`);
}

main().catch((err) => {
  console.error('✗ run-chain-corpus ERROR:', err);
  process.exit(1);
});
