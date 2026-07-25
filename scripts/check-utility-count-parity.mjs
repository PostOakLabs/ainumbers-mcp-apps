#!/usr/bin/env node
// check-utility-count-parity.mjs — UTILITY-TOOL COUNT PARITY GATE (worker CI validate job).
//
// MCPCOUNTS-FIX-1 (MCPCOUNTS-DRIFT-CAUSE-2026-07-25.md): the site's committed
// data/mcp-counts.json.utility_tools drifted stale (34 vs the worker's true 37) for
// months because verify-counts --check only compares the site's own sentinels against
// its own trusted-blindly input — it has no cross-repo visibility into what the worker
// actually registers. That let a public count go wrong with every site-side gate green.
//
// This gate closes that: it compares this worker's own UTILITY_TOOL_COUNT (the actual
// producer — utility-tools.mjs is what worker.mjs registers) against the SITE's
// committed data/mcp-counts.json.utility_tools, and fails the WORKER PR/push when they
// disagree. This is the only gate positioned to catch the drift at the moment it is
// introduced, because the site-side gate structurally cannot (both site numbers agree
// with each other even when both are stale).
//
// Same advisory-on-PR / strict-on-push posture as check-vendor-fresh.mjs: a paired site
// PR adding a new utility tool often merges AFTER this worker PR opens (or vice versa),
// so a PR-time mismatch can be the expected two-repo-same-push window, not a real bug.
// On push to master (the deploy path) the worker MUST match site main exactly.
//
// Usage: SITE_REPO=_site node scripts/check-utility-count-parity.mjs   (exit 1 if mismatched on push)
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { UTILITY_TOOL_COUNT } from '../utility-tools.mjs';

const SITE = process.env.SITE_REPO;
if (!SITE || !existsSync(SITE)) { console.error(`FATAL: SITE_REPO not set or not found: ${SITE}`); process.exit(2); }

const GIT_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
const git = (args, opts = {}) => execFileSync('git', args, { ...opts, env: GIT_ENV });

let useGit = false;
try { git(['-C', SITE, 'rev-parse', '--is-inside-work-tree'], { stdio: 'pipe' }); useGit = true; } catch { useGit = false; }

let ref = 'HEAD';
if (useGit) {
  try {
    git(['-C', SITE, 'fetch', 'origin', '--quiet'], { stdio: 'pipe' });
    git(['-C', SITE, 'rev-parse', '--verify', 'origin/main'], { stdio: 'pipe' });
    ref = 'origin/main';
  } catch { /* fall back to local HEAD below */ }
}

const raw = useGit
  ? git(['-C', SITE, 'show', `${ref}:data/mcp-counts.json`], { encoding: 'utf8' })
  : readFileSync(join(SITE, 'data', 'mcp-counts.json'), 'utf8');
const siteCounts = JSON.parse(raw);
const siteUtilityTools = siteCounts.utility_tools;

console.log(`(comparing vs site ${useGit ? ref : 'working tree'}: ${SITE})`);
console.log(`worker UTILITY_TOOL_COUNT (utility-tools.mjs, the producer) = ${UTILITY_TOOL_COUNT}`);
console.log(`site data/mcp-counts.json utility_tools (committed)        = ${siteUtilityTools}`);

const IS_PR = process.env.GITHUB_EVENT_NAME === 'pull_request';

if (UTILITY_TOOL_COUNT === siteUtilityTools) {
  console.log('✓ utility_tools count in sync between worker and site.');
  process.exit(0);
}

const msg = `utility_tools MISMATCH: worker=${UTILITY_TOOL_COUNT} site(${ref})=${siteUtilityTools}.`;
if (IS_PR) {
  console.log(`⚠ ${msg} ADVISORY on pull_request — expected if the paired site PR hasn't merged yet.`);
  console.log('  If the paired site PR IS already merged, this is a real drift: update site data/mcp-counts.json.utility_tools and re-run verify-counts --fix.');
  process.exit(0);
}
console.error(`✗ ${msg}`);
console.error('  Fix: update site repo data/mcp-counts.json.utility_tools to match this worker\'s UTILITY_TOOL_COUNT, run node scripts/verify-counts.mjs --fix in the site repo, commit + merge there FIRST, then re-run this worker push.');
process.exit(1);
