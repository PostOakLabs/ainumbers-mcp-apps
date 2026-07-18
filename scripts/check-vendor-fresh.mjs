#!/usr/bin/env node
// check-vendor-fresh.mjs — VENDOR-FRESHNESS GATE (worker CI validate job).
//
// The worker boots from vendored data/ + kernels/ produced by `node generate.mjs` from the SITE repo
// (PostOakLabs/ainumbers). CI deploys COMMITTED files only — it does NOT run generate.mjs (needs the
// sibling ../repo, absent in CI; see ci.yml). So if someone edits the site's chaingraph.json/kernels
// but forgets to re-vendor + commit data/ here, the worker ships a STALE catalog. The local PreToolUse
// hook catches a direct `git push origin master`, but NOT the `gh pr merge` path — this gate closes that.
//
// Compares against the site's COMMITTED HEAD (git show HEAD:…), NOT the working tree — this MATCHES what
// CI deploys (a clean actions/checkout) AND means a concurrent session's UNCOMMITTED WIP in ../repo no
// longer false-positives this gate (the bug that forced --no-verify on every push during another
// session's work). Falls back to a working-tree read only when SITE is not a git repo.
//
// Robust to line-ending/formatting noise: chaingraph.json compared by parsed-JSON equality; kernels by
// \r-normalized text. Set SITE_REPO to a checked-out PostOakLabs/ainumbers (CI: actions/checkout path).
//
// Usage: SITE_REPO=_site node scripts/check-vendor-fresh.mjs   (exit 1 if stale)
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const SITE = process.env.SITE_REPO;
if (!SITE || !existsSync(SITE)) { console.error(`FATAL: SITE_REPO not set or not found: ${SITE}`); process.exit(2); }
const norm = (s) => s.replace(/\r\n/g, '\n');

// When invoked from a git hook (this repo's own pre-push), the parent process has GIT_DIR/GIT_WORK_TREE
// pinned to the WORKER repo. Any inherited `git -C <SITE>` call then ignores -C and reads the WRONG
// repo's HEAD -- surfaces as "path exists on disk, but not in HEAD" for a file that's very much in the
// site's HEAD. Strip those vars so git commands against SITE always target SITE.
const GIT_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
const git = (args, opts = {}) => execFileSync('git', args, { ...opts, env: GIT_ENV });

// Read the site source from its COMMITTED HEAD when SITE is a git repo (matches CI's clean checkout and
// ignores uncommitted WIP); otherwise read the working tree.
let useGit = false;
try { git(['-C', SITE, 'rev-parse', '--is-inside-work-tree'], { stdio: 'pipe' }); useGit = true; } catch { useGit = false; }

// SITE may be a session-local worktree checkout that isn't synced to the true current origin/main —
// its own HEAD alone is not a trustworthy freshness baseline (a stale worktree makes this gate both
// false-stale and false-fresh, which is why sessions were reaching for --no-verify; see
// feedback-worker-vendor-single-writer). Best-effort fetch + prefer origin/main so the baseline matches
// what CI's fresh actions/checkout deploys, falling back to local HEAD only when fetch is unavailable
// (offline dev, no `origin` remote, detached SITE checkout).
let ref = 'HEAD';
if (useGit) {
  try {
    git(['-C', SITE, 'fetch', 'origin', '--quiet'], { stdio: 'pipe' });
    git(['-C', SITE, 'rev-parse', '--verify', 'origin/main'], { stdio: 'pipe' });
    ref = 'origin/main';
  } catch { /* fall back to local HEAD below */ }
}
const siteRead = (relPath) => useGit
  ? git(['-C', SITE, 'show', `${ref}:${relPath.replace(/\\/g, '/')}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  : readFileSync(join(SITE, relPath), 'utf8');
const siteListKernels = () => useGit
  ? git(['-C', SITE, 'ls-tree', '--name-only', ref, 'chaingraph/kernels/'], { encoding: 'utf8' })
      .split('\n').filter((l) => l.endsWith('.kernel.mjs')).map((l) => l.split('/').pop())
  : readdirSync(join(SITE, 'chaingraph', 'kernels')).filter((f) => f.endsWith('.kernel.mjs'));

console.log(`(comparing vs site ${useGit ? ref : 'working tree'}: ${SITE})`);
let fails = 0;

// CONTEXT-AWARE severity. On a pull_request the PAIRED site PR is often still open, so the worker
// legitimately vendors chains/nodes/kernels that site main does not have yet (two-repo same-push:
// the site PR merges FIRST, then the worker vendor matches main). Comparing the worker vs site main
// during that window is a FALSE red — the recurring "worker CI red until the site PR merges" pain.
// So on pull_request we ADVISE (classify + never fail); on push to master (the DEPLOY path) we stay
// STRICT — the deployed worker must match site main exactly. The deploy gate is unchanged.
// History: memory feedback_wrangler_deploy_in_commit_block + consolidated queue.
const IS_PR = process.env.GITHUB_EVENT_NAME === 'pull_request';

function classifyChainGraph(vend, src) {
  const idset = (arr, key) => new Set((arr || []).map((x) => x[key] ?? x.id ?? x.name));
  const sChains = idset(src.chains, 'name'), vChains = idset(vend.chains, 'name');
  const sNodes = idset(src.nodes, 'tool_id'), vNodes = idset(vend.nodes, 'tool_id');
  const siteChainsKept = [...sChains].every((n) => vChains.has(n));
  const siteNodesKept = [...sNodes].every((n) => vNodes.has(n));
  const workerHasExtra = vChains.size > sChains.size || vNodes.size > sNodes.size;
  // 'ahead' = worker keeps every site chain/node and adds more (the paired-PR-in-flight shape).
  return (siteChainsKept && siteNodesKept && workerHasExtra) ? 'ahead' : 'diverged';
}

function reportDrift(label, detail, classify) {
  if (IS_PR) {
    const cls = classify ? classify() : 'diverged';
    console.log(`⚠ ${label} differs from site main (${cls}) — ADVISORY on pull_request.`);
    console.log(cls === 'ahead'
      ? '   Worker vendors content not yet on site main. EXPECTED when the paired site PR is unmerged: merge the site PR first, then this is strict-green on push to master.'
      : `   ${detail} If the paired site PR is unmerged this is expected; otherwise run \`node generate.mjs\` and recommit data/.`);
    return 0;
  }
  console.error(`✗ ${label} is STALE vs the site source.`);
  return 1;
}

// 1) chaingraph.json — semantic (parsed-JSON) equality, ignores whitespace/key-order-of-file
// `src` (the site's ASSEMBLED chaingraph.json) is kept in outer scope — section 2 uses its node
// tool_ids to tell an assembled-but-unvendored kernel (real outage: /mcp advertises it, worker has
// none) apart from a shard-only kernel (CGSHARD: not yet assembled, not advertised, cannot be
// reached — see VENDOR-FRESHNESS-CGSHARD-CONFLICT-2026-07-18.md). Only the former is a hard red.
let src = null;
try {
  const vend = JSON.parse(readFileSync(join('data', 'chaingraph', 'chaingraph.json'), 'utf8'));
  src = JSON.parse(siteRead('chaingraph/chaingraph.json'));
  if (JSON.stringify(vend) !== JSON.stringify(src)) {
    fails += reportDrift(
      'data/chaingraph/chaingraph.json',
      'Worker may be BEHIND site main, or the site PR modified shared content.',
      () => classifyChainGraph(vend, src),
    );
  } else console.log('✓ data/chaingraph/chaingraph.json is current');
} catch (e) { console.error('✗ chaingraph.json compare error:', e.message); fails++; }

// 2) bundled kernels/ (what wrangler imports into the Worker) — every ASSEMBLED site kernel present
// + identical is a HARD RED (the real outage class). A kernel that exists only as an unassembled
// CGSHARD shard (not in chaingraph.json's nodes[]) is expected to lag the batched assemble+vendor
// pass — report it as one INFO count line, never a failure.
try {
  const srcKernels = siteListKernels();
  // Kernel filename === tool_id + '.kernel.mjs' (uniform across the legacy bare-number and art-NN
  // naming eras — verified against both live shapes). `src` may be null if section 1 failed to
  // parse; fall back to treating every kernel as assembled (old strict behavior) rather than
  // silently downgrading real drift to INFO.
  const assembledIds = src ? new Set((src.nodes || []).map((n) => n.tool_id)) : null;
  const isAssembled = (k) => !assembledIds || assembledIds.has(k.replace(/\.kernel\.mjs$/, ''));

  let kfail = 0;
  let shardMissing = 0;
  for (const k of srcKernels) {
    const vp = join('kernels', k);
    const stale = !existsSync(vp) || norm(readFileSync(vp, 'utf8').toString()) !== norm(siteRead(`chaingraph/kernels/${k}`));
    if (!stale) continue;
    if (isAssembled(k)) {
      console.error(`  ${IS_PR ? '⚠' : '✗'} missing/differing vendored kernel: ${k}`);
      kfail++;
    } else {
      shardMissing++;
    }
  }
  if (kfail) {
    fails += reportDrift(
      `${kfail} of ${srcKernels.length} kernels`,
      'Worker kernels differ from site main.',
      null,
    );
  } else console.log(`✓ ${srcKernels.length - shardMissing} assembled bundled kernels current`);
  if (shardMissing) console.log(`INFO: ${shardMissing} shard${shardMissing === 1 ? '' : 's'} awaiting next assemble-land`);
} catch (e) { console.error('✗ kernel compare error:', e.message); fails++; }

console.log(fails
  ? '\n✗ VENDOR STALE — run `node generate.mjs` (in mcp-apps-poc) and commit data/ + kernels/ in the SAME push.'
  : '\n✓ vendored data/ + kernels/ are current vs PostOakLabs/ainumbers.');
process.exit(fails ? 1 : 0);
