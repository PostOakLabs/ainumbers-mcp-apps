#!/usr/bin/env node
// linear-hash-freeze.mjs — OCG v0.8 gate 3 (LINEAR-HASH-FREEZE).
//
// Every existing chain is LINEAR (no decision gates). v0.8 adds gates + new
// composite_policy/composite_output keys, but ALL of those keys are
// CONDITIONAL-PRESENCE (emitted only when a chain has >=1 gate). Therefore NO
// linear chain's composite_execution_hash may move. This gate is the proof:
// it captures a golden composite_execution_hash for every fixture-runnable
// linear chain BEFORE the v0.8 change (committed first, separately), and fails
// if any hash moves after.
//
// Uses the embedded runChain (byte-identical to the Worker run_chain server
// path — enforced by the surface-parity gate), so it needs no network / MCP
// transport and is fully deterministic.
//
// Usage:
//   node scripts/linear-hash-freeze.mjs --capture   # write goldens (pre-change, once)
//   node scripts/linear-hash-freeze.mjs             # verify goldens unchanged (CI)

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runChain } from '../embed/runChain.mjs';
import { getKernel } from '../kernels/index.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = resolve(ROOT, 'data');
const GOLDENS = resolve(ROOT, 'test', 'linear-hash-freeze.goldens.json');

const rd = (p) => JSON.parse(readFileSync(resolve(DATA, p), 'utf8'));
const chaingraph = rd('chaingraph/chaingraph.json');
const fixtures = rd('chain-fixtures.json');
const deps = { getKernel, chaingraph, fixtures };

async function captureAll() {
  const out = {};
  for (const chainName of Object.keys(fixtures)) {
    // Skip chains not in the catalog (fixtures may outlive a renamed chain).
    if (!(chaingraph.chains ?? []).some((c) => c.name === chainName)) continue;
    try {
      const r = await runChain(chainName, undefined, deps);
      if (r.composite_execution_hash) {
        out[chainName] = { composite_execution_hash: r.composite_execution_hash, steps_ran: r.steps_ran };
      }
    } catch { /* unrunnable chain — not a golden */ }
  }
  return out;
}

async function main() {
  const mode = process.argv[2];
  const current = await captureAll();
  const count = Object.keys(current).length;

  if (mode === '--capture') {
    writeFileSync(GOLDENS, JSON.stringify(current, null, 2) + '\n');
    console.log(`✅ captured ${count} linear-chain composite goldens → test/linear-hash-freeze.goldens.json`);
    return;
  }

  let goldens;
  try {
    goldens = JSON.parse(readFileSync(GOLDENS, 'utf8'));
  } catch {
    console.error('✗ goldens missing — run `node scripts/linear-hash-freeze.mjs --capture` (pre-change) first.');
    process.exit(1);
  }

  let failed = 0;
  const gk = Object.keys(goldens);
  if (gk.length < 10) {
    console.error(`✗ only ${gk.length} goldens recorded — the freeze set MUST cover >=10 linear chains.`);
    failed++;
  }
  for (const chain of gk) {
    const want = goldens[chain].composite_execution_hash;
    const got = current[chain]?.composite_execution_hash ?? null;
    if (got !== want) {
      console.error(`✗ ${chain}: composite hash MOVED\n    golden:  ${want}\n    current: ${got}`);
      failed++;
    }
  }
  if (failed) {
    console.error(`\n✗ LINEAR-HASH-FREEZE: ${failed} problem(s). A linear chain's composite_execution_hash changed — v0.8 keys must be conditional-presence (gated chains only).`);
    process.exit(1);
  }
  console.log(`✅ LINEAR-HASH-FREEZE: all ${gk.length} linear composite hashes unchanged.`);
}

main().catch((e) => { console.error('✗ linear-hash-freeze ERROR:', e); process.exit(1); });
