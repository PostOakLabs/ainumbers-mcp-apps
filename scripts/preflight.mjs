#!/usr/bin/env node
// preflight.mjs — run the worker's hard CI gates LOCALLY, in CI order, before a push.
//
// WHY: the "Validate MCP server" CI job runs ~12 gates, but the pre-push hook historically ran only
// ONE (vendor-freshness). So count-drift / surface-parity / build-parity / tool-name failures sailed
// through the hook, reached GitHub, and red-failed CI (e.g. run_chain's two red master deploys,
// 2026-06-29 — count drift + surface-parity). This aggregator makes "green preflight ⇒ green Validate
// job", and .githooks/pre-push runs it so a bad push never leaves the machine.
//
// Run:   node scripts/preflight.mjs          (fast: the static gates that catch the common errors)
//        node scripts/preflight.mjs --full    (also wrangler bundle dry-run + registry sync — slower)
//
// Site-dependent gates (vendor-freshness, schema-validate) run only when the site repo is present
// (SITE_REPO or ../repo); on a worker-only checkout they are skipped with a note (CI backstops them) —
// but the count/parity/name/invariant gates ALWAYS run, so the common drift is caught everywhere.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SITE = resolve(ROOT, process.env.SITE_REPO || '../repo');
const siteOk = existsSync(SITE);
const FULL = process.argv.includes('--full');

// Each gate: { name, args:[...node argv], env?, needsSite? }. Mirrors .github/workflows/ci.yml "validate".
const gates = [
  { name: 'tool-name collisions',                 args: ['scripts/check-tool-names.mjs'] },
  { name: 'surface-parity (counts/discovery)',    args: ['scripts/surface-parity.mjs'] },
  { name: 'worker hot-path invariants',           args: ['scripts/check-worker-invariants.mjs'] },
  { name: 'build parity + pre-deploy count guard',args: ['scripts/build-mcp-parity.mjs'] },
  { name: 'kernel coverage (strict)',             args: ['scripts/kernel-coverage.mjs', '--strict'] },
  { name: 'validate named chains',                args: ['scripts/validate-chains.mjs'] },
  { name: 'cross-tool artifact round-trip (AUD-C1)', args: ['scripts/gate-crosstool-roundtrip.mjs'] },
  { name: 'export-format consistency (AUD-C2)',    args: ['scripts/gate-export-format-consistency.mjs'] },
  { name: 'negative gate-enforcement (AUD-E2)',    args: ['scripts/gate-negative-enforcement.mjs'] },
  { name: 'zero-egress determinism (AUD-F4)',      args: ['scripts/gate-zero-egress.mjs'] },
  { name: 'ttlMs cache-key is input-hash-only (§M1.5)', args: ['scripts/test-ttl-cache-key.mjs'] },
  { name: 'description-quality dogfood gate (§M2.1)',   args: ['scripts/check-tool-description-quality.mjs'] },
  { name: 'deprecation lifecycle (§M2.2)',              args: ['scripts/gate-deprecation-lifecycle.mjs'] },
  { name: 'tool-selection eval (§M2.4)',                args: ['scripts/gate-tool-selection-eval.mjs'] },
  { name: 'chain-fixtures freshness (OCGR §A)',   args: ['scripts/gen-chain-fixtures.mjs', '--check'], env: { SITE_REPO: SITE }, needsSite: true },
  { name: 'vendor-freshness vs site',             args: ['scripts/check-vendor-fresh.mjs'], env: { SITE_REPO: SITE }, needsSite: true },
  { name: 'schema-validate chaingraph (OCG v0.4)',args: [resolve(SITE, 'chaingraph/standard/schema-validate.mjs')],
    env: { SCHEMA: resolve(SITE, 'chaingraph/standard/openchain-graph-v0.4.schema.json'), CHAINGRAPH: 'data/chaingraph/chaingraph.json', FIXTURES_DIR: resolve(SITE, 'chaingraph/kernels/fixtures') }, needsSite: true },
];
if (FULL) {
  gates.push({ name: 'wrangler bundle dry-run', cmd: 'npx', args: ['wrangler@4.99.0', 'deploy', '--dry-run', '--outdir', '/tmp/worker-build'] });
  gates.push({ name: 'registry sync (dry-run)', args: ['scripts/sync-registry.mjs'] });
}

console.log(`\n▶ worker preflight — ${gates.length} gates${FULL ? ' (--full)' : ''}${siteOk ? '' : ' [site repo not found → site-dependent gates skipped, CI backstops]'}\n`);

let failed = 0, skipped = 0;
for (const g of gates) {
  if (g.needsSite && !siteOk) { console.log(`⏭  ${g.name} — skipped (no site repo)`); skipped++; continue; }
  process.stdout.write(`▶ ${g.name} … `);
  const r = spawnSync(g.cmd || 'node', g.args, { cwd: ROOT, env: { ...process.env, ...(g.env || {}) }, encoding: 'utf8' });
  const out = (r.stdout || '') + (r.stderr || '');
  if (r.status === 0) {
    console.log('✓');
  } else {
    console.log('✗');
    console.log(out.split('\n').filter(Boolean).slice(-12).map((l) => '    ' + l).join('\n'));
    failed++;
  }
}

console.log('');
if (failed) {
  console.error(`✗ preflight FAILED — ${failed} gate(s) red. Fix before pushing (this is what CI would have rejected).`);
  if (!FULL) console.error('  (run with --full to also check the wrangler bundle + registry sync.)');
  process.exit(1);
}
console.log(`✅ preflight PASSED — all hard CI gates green${skipped ? ` (${skipped} site-dependent skipped)` : ''}. Safe to push.`);
