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

// Read the site source from its COMMITTED HEAD when SITE is a git repo (matches CI's clean checkout and
// ignores uncommitted WIP); otherwise read the working tree.
let useGit = false;
try { execFileSync('git', ['-C', SITE, 'rev-parse', '--is-inside-work-tree'], { stdio: 'pipe' }); useGit = true; } catch { useGit = false; }
const siteRead = (relPath) => useGit
  ? execFileSync('git', ['-C', SITE, 'show', `HEAD:${relPath.replace(/\\/g, '/')}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  : readFileSync(join(SITE, relPath), 'utf8');
const siteListKernels = () => useGit
  ? execFileSync('git', ['-C', SITE, 'ls-tree', '--name-only', 'HEAD', 'chaingraph/kernels/'], { encoding: 'utf8' })
      .split('\n').filter((l) => l.endsWith('.kernel.mjs')).map((l) => l.split('/').pop())
  : readdirSync(join(SITE, 'chaingraph', 'kernels')).filter((f) => f.endsWith('.kernel.mjs'));

console.log(`(comparing vs site ${useGit ? 'COMMITTED HEAD' : 'working tree'}: ${SITE})`);
let fails = 0;

// 1) chaingraph.json — semantic (parsed-JSON) equality, ignores whitespace/key-order-of-file
try {
  const vend = JSON.parse(readFileSync(join('data', 'chaingraph', 'chaingraph.json'), 'utf8'));
  const src = JSON.parse(siteRead('chaingraph/chaingraph.json'));
  if (JSON.stringify(vend) !== JSON.stringify(src)) {
    console.error('✗ data/chaingraph/chaingraph.json is STALE vs the site source.'); fails++;
  } else console.log('✓ data/chaingraph/chaingraph.json is current');
} catch (e) { console.error('✗ chaingraph.json compare error:', e.message); fails++; }

// 2) bundled kernels/ (what wrangler imports into the Worker) — every site kernel present + identical
try {
  const srcKernels = siteListKernels();
  let kfail = 0;
  for (const k of srcKernels) {
    const vp = join('kernels', k);
    if (!existsSync(vp)) { console.error(`  ✗ missing vendored kernel: ${k}`); kfail++; continue; }
    if (norm(readFileSync(vp, 'utf8')) !== norm(siteRead(`chaingraph/kernels/${k}`))) {
      console.error(`  ✗ stale vendored kernel: ${k}`); kfail++;
    }
  }
  if (kfail) { console.error(`✗ ${kfail} of ${srcKernels.length} kernels stale/missing vs site`); fails++; }
  else console.log(`✓ ${srcKernels.length} bundled kernels current`);
} catch (e) { console.error('✗ kernel compare error:', e.message); fails++; }

console.log(fails
  ? '\n✗ VENDOR STALE — run `node generate.mjs` (in mcp-apps-poc) and commit data/ + kernels/ in the SAME push.'
  : '\n✓ vendored data/ + kernels/ are current vs PostOakLabs/ainumbers.');
process.exit(fails ? 1 : 0);
