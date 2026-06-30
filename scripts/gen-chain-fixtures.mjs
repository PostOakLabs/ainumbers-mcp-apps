#!/usr/bin/env node
// gen-chain-fixtures.mjs — build data/chain-fixtures.json
//
// Resolves policy_parameters fixtures for every step of every fully-kernel-backed
// chain in data/chaingraph/chaingraph.json, reading the site's COMMITTED HEAD so
// uncommitted working-tree changes never leak into the worker bundle.
//
// Resolution order per step tool_id (per §1.4 / OCGR BUILD SPEC §5.1):
//   1. site committed HEAD: chaingraph/conformance/vectors/<tool_id>.fixture.json
//      (.policy_parameters — the authoritative single-vector fixture)
//   2. site committed HEAD: chaingraph/kernels/fixtures/<tool_id>.fixtures.json
//      (.vectors[0].policy_parameters — fallback multi-vector fixture)
//   3. {} (logged — the step will still get inputs_source:"none" at runtime)
//
// Usage:
//   node scripts/gen-chain-fixtures.mjs          — write data/chain-fixtures.json
//   node scripts/gen-chain-fixtures.mjs --check  — regenerate in-memory; exit 1 on drift

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHECK = process.argv.includes('--check');
const OUT_PATH = resolve(ROOT, 'data/chain-fixtures.json');

// Locate the site repo (same logic as check-vendor-fresh.mjs / preflight.mjs).
const SITE = resolve(ROOT, process.env.SITE_REPO || '../repo');

// --- git show helper (reads from COMMITTED HEAD, never the working tree) ----------
function gitShow(gitDir, path) {
  try {
    return execSync(`git -C "${gitDir}" show HEAD:${path}`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    return null;
  }
}

// --- resolve a single step's fixture policy_parameters ---------------------------
function resolveFixture(tid) {
  // 1. conformance/vectors/<tool_id>.fixture.json
  const vectorRaw = gitShow(SITE, `chaingraph/conformance/vectors/${tid}.fixture.json`);
  if (vectorRaw) {
    try {
      const obj = JSON.parse(vectorRaw);
      if (obj.policy_parameters && typeof obj.policy_parameters === 'object') {
        return { pp: obj.policy_parameters, src: 'vectors' };
      }
    } catch {
      // fall through
    }
  }

  // 2. kernels/fixtures/<tool_id>.fixtures.json → .vectors[0].policy_parameters
  const kernelRaw = gitShow(SITE, `chaingraph/kernels/fixtures/${tid}.fixtures.json`);
  if (kernelRaw) {
    try {
      const obj = JSON.parse(kernelRaw);
      const pp = obj?.vectors?.[0]?.policy_parameters;
      if (pp && typeof pp === 'object') {
        return { pp, src: 'kernels/fixtures' };
      }
    } catch {
      // fall through
    }
  }

  return null;
}

// --- main -----------------------------------------------------------------------
async function main() {
  if (!existsSync(SITE)) {
    console.error(`ERROR: site repo not found at ${SITE} (set SITE_REPO env to override).`);
    process.exit(1);
  }

  // Load the vendored chaingraph (committed in worker repo — the source of truth for what's deployed).
  const cgPath = resolve(ROOT, 'data/chaingraph/chaingraph.json');
  const cg = JSON.parse(readFileSync(cgPath, 'utf8'));

  // Import the kernel registry dynamically (ESM, async).
  const { getKernel } = await import('../kernels/index.mjs');

  // Index nodes by tool_id so we can check node.gpu (mirrors run_chain's exact gate).
  const nodeByTid = {};
  for (const n of cg.nodes ?? []) nodeByTid[n.tool_id] = n;

  // A step is server-runnable iff !node.gpu && getKernel(tool_id) — matches run_chain logic exactly.
  const isServerStep = (tid) => !nodeByTid[tid]?.gpu && !!getKernel(tid);

  // Identify fully kernel-backed chains (every step is server-runnable).
  const kernelChains = (cg.chains ?? []).filter(
    (c) => c.steps?.length && c.steps.every((s) => isServerStep(s.tool_id))
  );

  console.log(`gen-chain-fixtures: ${kernelChains.length}/${(cg.chains ?? []).length} chains fully kernel-backed`);

  const fixtures = {};
  let total = 0, found = 0, missing = 0;

  for (const chain of kernelChains) {
    const chainMap = {};
    for (const step of chain.steps) {
      total++;
      const tid = step.tool_id;
      const result = resolveFixture(tid);
      if (result) {
        chainMap[tid] = result.pp;
        found++;
      } else {
        console.warn(`  WARN: no fixture for ${tid} in chain "${chain.name}" — step will get inputs_source:"none" at runtime`);
        missing++;
      }
    }
    fixtures[chain.name] = chainMap;
  }

  console.log(`gen-chain-fixtures: ${found}/${total} steps resolved, ${missing} missing`);

  const output = JSON.stringify(fixtures, null, 2);

  if (CHECK) {
    // --check: compare against committed file; exit 1 on drift.
    if (!existsSync(OUT_PATH)) {
      console.error(`DRIFT: data/chain-fixtures.json does not exist. Run: node scripts/gen-chain-fixtures.mjs`);
      process.exit(1);
    }
    const committed = readFileSync(OUT_PATH, 'utf8');
    // Canonical comparison: normalize both through JSON parse/stringify to ignore whitespace.
    const committedNorm = JSON.stringify(JSON.parse(committed));
    const freshNorm = JSON.stringify(JSON.parse(output));
    if (committedNorm !== freshNorm) {
      console.error(`DRIFT: data/chain-fixtures.json is stale vs current chaingraph + site fixtures.`);
      console.error(`       Run: node scripts/gen-chain-fixtures.mjs  then commit data/chain-fixtures.json`);
      process.exit(1);
    }
    console.log(`✓ data/chain-fixtures.json is current (no drift)`);
    return;
  }

  // Write mode.
  writeFileSync(OUT_PATH, output + '\n', 'utf8');
  console.log(`✓ wrote data/chain-fixtures.json (${kernelChains.length} chains, ${found} step fixtures)`);
}

main().catch((err) => {
  console.error('gen-chain-fixtures ERROR:', err);
  process.exit(1);
});
