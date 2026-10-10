#!/usr/bin/env node
/**
 * sync-registry.mjs — auto-update server.json before mcp-publisher.exe publish
 *
 * Usage:
 *   node scripts/sync-registry.mjs               # dry-run (prints what would change)
 *   node scripts/sync-registry.mjs --write        # writes server.json in-place
 *   node scripts/sync-registry.mjs --check        # REGISTRY-PARITY-1: exit 1 if the COMMITTED
 *                                                  # description has drifted from data/counts.json.
 *                                                  # Hermetic (no network, no writes) — wired into
 *                                                  # preflight.mjs + ci.yml validate. Description only:
 *                                                  # version drift is --check-drift's job.
 *   node scripts/sync-registry.mjs --check-drift  # dry-run + exit 1 if local is ahead of the
 *                                                  # live registry (committed but never published).
 *                                                  # Scheduled use only — see registry-drift-schedule.yml.
 *                                                  # A plain run (no flag, incl. CI/preflight) NEVER
 *                                                  # fails on drift: the normal bump→commit→push→publish
 *                                                  # flow is legitimately "ahead" for a while and must
 *                                                  # not cry wolf on every version-bump PR.
 *                                                  # REGISTRY-PUBLISH-AUTO-1: if the registry API itself
 *                                                  # is unreachable (network error, timeout, 5xx), prints
 *                                                  # REGISTRY_UNREACHABLE and exits 0 — that is not drift.
 *                                                  # Real drift still exits 1.
 *
 * Run this immediately before:  .\mcp-publisher.exe publish
 *
 * What it does:
 *   1. Reads data/counts.json — the vendored SSOT (generate.mjs writes it; never
 *      hand-derive counts here, that's how this script went stale before — S4 2026-07-09)
 *   2. Bumps server.json patch version (X.Y.Z → X.Y.Z+1)
 *   3. Writes server.json (with --write) or prints the diff (dry-run)
 *   4. Fetches the live MCP Registry entry and reports whether local server.json has
 *      drifted from what is actually published (REGISTRY-DRIFT-GATE-1, 2026-07-26 —
 *      server.json sat committed at 0.4.9 while the registry still served 0.4.8 for
 *      days, and nothing caught it: committing a version bump is not publishing it).
 */

import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));
const root  = join(__dir, '..');
const write = process.argv.includes('--write');
const checkDrift = process.argv.includes('--check-drift');
const check = process.argv.includes('--check');

// ── 1. Read current server.json ───────────────────────────────────────────
const serverJsonPath = join(root, 'server.json');
const serverJson = JSON.parse(readFileSync(serverJsonPath, 'utf8'));

// ── 2. Read vendored SSOT counts ──────────────────────────────────────────
const counts = JSON.parse(readFileSync(join(root, 'data', 'counts.json'), 'utf8'));
const mcpToolsTotal = counts.mcp_tools_total;
const catalogTools = counts.catalog_tools;

// ── 3. Build new description (≤100 chars) ─────────────────────────────────
const desc = `${mcpToolsTotal} MCP tools across ${catalogTools} fintech tools: ChainGraph AP2 decisions, execution_hash. Zero PII.`;
if (desc.length > 100) {
  console.error(`❌  Description too long (${desc.length} chars, max 100): "${desc}"`);
  console.error(`    Fix the description template above in THIS script, then re-run.`);
  process.exit(1);
}

// ── 3b. REGISTRY-PARITY-1: --check (hermetic, read-only) ──────────────────
// Fails when the committed server.json description has drifted from what this
// script derives from data/counts.json. Description ONLY — version drift is
// the scheduled registry-drift-schedule.yml's job (--check-drift). Exits
// BEFORE the live-registry fetch so CI runs are hermetic and deterministic.
if (check) {
  if (write || checkDrift) {
    console.error('❌  --check cannot be combined with --write or --check-drift.');
    process.exit(1);
  }
  if (serverJson.description === desc) {
    console.log(`✅  registry-parity (REGISTRY-PARITY-1): server.json description matches the counts SSOT (${mcpToolsTotal} MCP tools / ${catalogTools} catalog tools).`);
    process.exit(0);
  }
  console.error(`✗  registry-parity (REGISTRY-PARITY-1): server.json description has drifted from the counts SSOT.`);
  console.error(`      committed: "${serverJson.description}"`);
  console.error(`      derived  : "${desc}"`);
  console.error(`    Fix: node scripts/sync-registry.mjs --write && git add server.json && git commit -m "chore: registry sync pre-publish"`);
  process.exit(1);
}

// ── 4. Bump patch version ──────────────────────────────────────────────────
const [maj, min, pat] = (serverJson.version || '0.1.0').split('.').map(Number);
const newVersion = `${maj}.${min}.${pat + 1}`;

// ── 5. Apply or preview ────────────────────────────────────────────────────
const updated = { ...serverJson, version: newVersion, description: desc };

console.log('\n── sync-registry.mjs ─────────────────────────────────────');
console.log(`  mcp tools    : ${mcpToolsTotal}`);
console.log(`  catalog tools: ${catalogTools}`);
console.log(`  version      : ${serverJson.version}  →  ${newVersion}`);
console.log(`  description  : "${desc}"  (${desc.length} chars)`);
console.log('──────────────────────────────────────────────────────────\n');

if (write) {
  writeFileSync(serverJsonPath, JSON.stringify(updated, null, 2) + '\n', 'utf8');
  console.log(`✅  server.json written (v${newVersion})`);
  console.log('    Next: commit and push (Cloudflare auto-deploys):');
  console.log('      git add server.json');
  console.log('      git commit -m "chore: bump registry to v' + newVersion + '"');
  console.log('      git push origin master');
} else {
  console.log('ℹ️   Dry run — no files written.  Pass --write to apply.');
}

// ── 6. Compare against what the live MCP Registry actually serves ──────────
// (compares the CURRENTLY COMMITTED version, not the hypothetical --write bump —
// the drift this catches is "committed but never published", not "about to change")
function cmpSemver(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

let driftIsAhead = false;
try {
  // REGISTRY-PUBLISH-AUTO-1: bound the request so a hang reads as
  // "unreachable" (report-not-fail under --check-drift) instead of
  // dangling a scheduled job forever.
  const res = await fetch('https://registry.modelcontextprotocol.io/v0/servers?search=ainumbers', { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  const live = (body.servers || [])
    .find(s => s.server?.name === serverJson.name
      && s._meta?.['io.modelcontextprotocol.registry/official']?.isLatest === true);

  if (!live) {
    console.log('⚠️   live registry   : no isLatest entry found for ' + serverJson.name + ' (skipped)');
  } else {
    const liveVersion = live.server.version;
    const liveDesc = live.server.description;
    const cmp = cmpSemver(serverJson.version, liveVersion);
    if (cmp === 0) {
      console.log(`✅  live registry   : v${liveVersion} — in sync with local`);
    } else if (cmp > 0) {
      driftIsAhead = true;
      console.log(`⛔  live registry   : v${liveVersion} — LOCAL AHEAD (v${serverJson.version} committed, not yet published)`);
    } else {
      console.log(`⚠️   live registry   : v${liveVersion} — LOCAL BEHIND (unexpected; registry ahead of this checkout)`);
    }
    if (liveDesc !== serverJson.description) {
      console.log(`⚠️   live description differs from local:\n      live : "${liveDesc}"\n      local: "${serverJson.description}"`);
    }
  }
} catch (err) {
  // REGISTRY-PUBLISH-AUTO-1 (2026-10-10): a network error, timeout, or 5xx from
  // the registry API is NOT drift — nothing was compared, so it must not fail
  // the scheduled gate or the post-publish check. Under --check-drift print
  // REGISTRY_UNREACHABLE and exit 0 (report-not-fail); plain runs keep the old
  // "skipped, not a build failure" line. REAL drift (a successful comparison
  // showing local ahead) still exits 1 below.
  const status = Number((err?.message || '').match(/^HTTP (\d+)$/)?.[1] || 0);
  const unreachable = !(status >= 100 && status < 500); // network/timeout (status 0) or 5xx
  if (unreachable) {
    if (checkDrift) {
      console.log(`REGISTRY_UNREACHABLE: registry API not comparable (${err.message}) — report-not-fail, exiting 0.`);
      process.exit(0);
    }
    console.log(`⚠️   live registry   : unreachable (${err.message}) — skipped, not a build failure`);
  } else {
    console.log(`⚠️   live registry   : HTTP ${status} from the registry API — skipped, not a build failure`);
  }
}

if (checkDrift && driftIsAhead) {
  console.error('\n❌  --check-drift: local server.json is ahead of the live registry. Run:  .\\mcp-publisher.exe publish');
  process.exit(1);
}
