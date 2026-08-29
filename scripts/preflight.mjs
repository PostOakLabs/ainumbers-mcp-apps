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
import { findSiteRepo } from './find-site-repo.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// findSiteRepo() (FINDSITEREPO-ANCHOR-1, scripts/find-site-repo.mjs) walks up from ROOT looking for
// the first ancestor with a `repo/.git`, refuses a stale one BY NAME instead of silently anchoring
// on it, and returns null (never a stale or unverified path) rather than walking further when it
// finds nothing fresh — see that file for the full rationale.
const foundSite = process.env.SITE_REPO ? resolve(ROOT, process.env.SITE_REPO) : findSiteRepo(ROOT);
// SITE stays a real string (never null) so the schema-validate gate's `resolve(SITE, …)` args below
// never throw when no site was found — but siteOk is keyed off `foundSite`, never off this sentinel,
// so an unrelated directory that happens to exist at this bogus path can never be mistaken for a site.
const SITE = foundSite ?? resolve(ROOT, '.no-site-repo-found');
const siteOk = foundSite !== null && existsSync(SITE);
const FULL = process.argv.includes('--full');
const SHOW = (process.argv.find((a) => a.startsWith('--show=')) || '').slice(7);

// Each gate: { name, args:[...node argv], env?, needsSite? }. Mirrors .github/workflows/ci.yml "validate".
const gates = [
  { name: 'preflight↔CI parity (no gate drift)',  args: ['scripts/check-preflight-parity.mjs'] },
  { name: 'tool-name collisions',                 args: ['scripts/check-tool-names.mjs'] },
  { name: 'Credits registry coverage',            args: ['scripts/check-credits-coverage.mjs', 'mcp-apps-poc'] },
  { name: 'Credits notices freshness',            args: ['scripts/gen-credits.mjs', 'mcp-apps-poc', '--check'] },
  { name: 'WASM deterministic self-test (§CW-1.b)',args: ['scripts/check-wasm-deterministic.selftest.mjs'] },
  { name: 'WASM deterministic profile (§CW-1.b)', args: ['scripts/check-wasm-deterministic.mjs'] },
  { name: 'surface-parity (counts/discovery)',    args: ['scripts/surface-parity.mjs'] },
  { name: 'worker hot-path invariants',           args: ['scripts/check-worker-invariants.mjs'] },
  { name: 'malformed-body fast-fail (audit F1)',  args: ['scripts/test-malformed-body-fastfail.mjs'] },
  { name: '/mcp Accept content negotiation (MCP-CONTENT-NEGOTIATION-FIX-1)', args: ['scripts/test-mcp-accept-negotiation.mjs'] },
  { name: '2026-07-28 era-gated request rules',   args: ['scripts/gate-mcp-era.mjs'] },
  { name: 'build parity + pre-deploy count guard',args: ['scripts/build-mcp-parity.mjs'] },
  { name: 'kernel coverage (strict)',             args: ['scripts/kernel-coverage.mjs', '--strict'] },
  { name: 'validate named chains',                args: ['scripts/validate-chains.mjs'] },
  { name: 'full-corpus chain E2E + schema conformance (audit E1/E3)', args: ['scripts/run-chain-corpus.mjs'] },
  { name: 'input-attestations gate (§23)',        args: ['scripts/validate-input-attestations.test.mjs'] },
  { name: 'private-inputs gate (§25)',            args: ['scripts/validate-private-inputs.test.mjs'] },
  { name: 'AuthZEN mapping (§21.4)',              args: ['scripts/authzen-mapping.test.mjs'] },
  { name: 'AuthZEN certification fixtures',       args: ['scripts/authzen-cert.test.mjs'] },
  { name: 'cross-tool artifact round-trip (AUD-C1)', args: ['scripts/gate-crosstool-roundtrip.mjs'] },
  { name: 'export-format consistency (AUD-C2)',    args: ['scripts/gate-export-format-consistency.mjs'] },
  { name: 'negative gate-enforcement (AUD-E2)',    args: ['scripts/gate-negative-enforcement.mjs'] },
  { name: 'zero-egress determinism (AUD-F4)',      args: ['scripts/gate-zero-egress.mjs'] },
  { name: 'ttlMs cache-key is input-hash-only (§M1.5)', args: ['scripts/test-ttl-cache-key.mjs'] },
  { name: 'description-quality dogfood gate (§M2.1)',   args: ['scripts/check-tool-description-quality.mjs'] },
  { name: 'deprecation lifecycle (§M2.2)',              args: ['scripts/gate-deprecation-lifecycle.mjs'] },
  { name: 'tool-selection eval (§M2.4)',                args: ['scripts/gate-tool-selection-eval.mjs'] },
  { name: 'hash-SSOT gate self-test (WORKER-HASH-SSOT-1)', args: ['scripts/gate-hash-ssot.selftest.mjs'] },
  { name: 'hash-SSOT: no second execution-hash impl in worker.mjs', args: ['scripts/gate-hash-ssot.mjs'] },
  { name: 'I-JSON refusal on the hash surface (WORKER-HASH-SSOT-1)', args: ['scripts/gate-hash-ijson.mjs'] },
  { name: 'id-splice DoS gate self-test (WORKER-IDREPLACE-DOS-1)', args: ['scripts/gate-idreplace-dos.selftest.mjs'] },
  { name: 'id-splice: no string-replacement splice in worker.mjs', args: ['scripts/gate-idreplace-dos.mjs'] },
  { name: 'id-splice DoS runtime regression (WORKER-IDREPLACE-DOS-1)', args: ['scripts/test-idreplace-dos.mjs'] },
  { name: 'chain-fixtures freshness (OCGR §A)',   args: ['scripts/gen-chain-fixtures.mjs', '--check'], env: { SITE_REPO: SITE }, needsSite: true },
  { name: 'vendor-freshness vs site',             args: ['scripts/check-vendor-fresh.mjs'], env: { SITE_REPO: SITE }, needsSite: true },
  { name: 'utility-tools count parity vs site (MCPCOUNTS-FIX-1)', args: ['scripts/check-utility-count-parity.mjs'], env: { SITE_REPO: SITE }, needsSite: true },
  { name: 'schema-validate chaingraph (OCG v0.4)',args: [resolve(SITE, 'chaingraph/standard/schema-validate.mjs')],
    env: { SCHEMA: resolve(SITE, 'chaingraph/standard/openchain-graph-v0.4.schema.json'), CHAINGRAPH: 'data/chaingraph/chaingraph.json', FIXTURES_DIR: resolve(SITE, 'chaingraph/kernels/fixtures') }, needsSite: true },
];
if (FULL) {
  gates.push({ name: 'wrangler bundle dry-run', cmd: 'npx', args: ['wrangler@4.99.0', 'deploy', '--dry-run', '--outdir', '/tmp/worker-build'] });
  gates.push({ name: 'registry sync (dry-run)', args: ['scripts/sync-registry.mjs'] });
}

console.log(`\n▶ worker preflight — ${gates.length} gates${FULL ? ' (--full)' : ''}${siteOk ? '' : ' [site repo not found → site-dependent gates skipped, CI backstops]'}\n`);

// git invokes this hook with GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE pinned to the WORKER repo. Gates
// below shell out to `git -C <site-repo>` for the site-dependent checks — inheriting those pinned
// vars makes git ignore -C and read the WRONG repo's HEAD (surfaced as "path exists on disk, but not
// in HEAD" for a file that is very much in the site's HEAD). Strip them so every gate starts clean,
// same as running preflight by hand outside a hook.
const CLEAN_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));

let failed = 0, skipped = 0;
for (const g of gates) {
  if (g.needsSite && !siteOk) { console.log(`⏭  ${g.name} — skipped (no site repo)`); skipped++; continue; }
  process.stdout.write(`▶ ${g.name} … `);
  // On Windows, `npx` is a .cmd shim — spawnSync can't exec a .cmd directly (tried: ENOENT with the
  // bare name, EINVAL even with the resolved "npx.cmd" path) without going through a shell. Gate
  // args are static repo config, never user input, so shell:true here carries no injection risk.
  // Linux CI is unaffected — shell defaults false there regardless.
  const r = spawnSync(g.cmd || 'node', g.args, { cwd: ROOT, env: { ...CLEAN_ENV, ...(g.env || {}) }, encoding: 'utf8', shell: process.platform === 'win32' });
  const out = (r.stdout || '') + (r.stderr || '');
  if (r.status === 0) {
    console.log('✓');
    if (SHOW && g.name.includes(SHOW)) console.log(out.split('\n').filter(Boolean).map((l) => '    ' + l).join('\n'));
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
