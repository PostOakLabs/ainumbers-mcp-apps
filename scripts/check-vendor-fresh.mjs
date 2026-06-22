#!/usr/bin/env node
// check-vendor-fresh.mjs — VENDOR-FRESHNESS GATE (worker CI validate job).
//
// The worker boots from vendored data/ + kernels/ produced by `node generate.mjs` from the SITE repo
// (PostOakLabs/ainumbers). CI deploys COMMITTED files only — it does NOT run generate.mjs (needs the
// sibling ../repo, absent in CI; see ci.yml). So if someone edits the site's chaingraph.json/kernels
// but forgets to re-vendor + commit data/ here, the worker ships a STALE catalog. The local PreToolUse
// hook catches a direct `git push origin master`, but NOT the `gh pr merge` path — this gate closes that.
//
// Robust to line-ending/formatting noise: chaingraph.json compared by parsed-JSON equality; kernels by
// \r-normalized text. Set SITE_REPO to a checked-out PostOakLabs/ainumbers (CI: actions/checkout path).
//
// Usage: SITE_REPO=_site node scripts/check-vendor-fresh.mjs   (exit 1 if stale)
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const SITE = process.env.SITE_REPO;
if (!SITE || !existsSync(SITE)) { console.error(`FATAL: SITE_REPO not set or not found: ${SITE}`); process.exit(2); }
const norm = (s) => s.replace(/\r\n/g, '\n');
let fails = 0;

// 1) chaingraph.json — semantic (parsed-JSON) equality, ignores whitespace/key-order-of-file
try {
  const vend = JSON.parse(readFileSync(join('data', 'chaingraph', 'chaingraph.json'), 'utf8'));
  const src = JSON.parse(readFileSync(join(SITE, 'chaingraph', 'chaingraph.json'), 'utf8'));
  if (JSON.stringify(vend) !== JSON.stringify(src)) {
    console.error('✗ data/chaingraph/chaingraph.json is STALE vs the site source.'); fails++;
  } else console.log('✓ data/chaingraph/chaingraph.json is current');
} catch (e) { console.error('✗ chaingraph.json compare error:', e.message); fails++; }

// 2) bundled kernels/ (what wrangler imports into the Worker) — every site kernel present + identical
try {
  const srcDir = join(SITE, 'chaingraph', 'kernels');
  const srcKernels = readdirSync(srcDir).filter((f) => f.endsWith('.kernel.mjs'));
  let kfail = 0;
  for (const k of srcKernels) {
    const vp = join('kernels', k);
    if (!existsSync(vp)) { console.error(`  ✗ missing vendored kernel: ${k}`); kfail++; continue; }
    if (norm(readFileSync(vp, 'utf8')) !== norm(readFileSync(join(srcDir, k), 'utf8'))) {
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
