#!/usr/bin/env node
// find-site-repo.selftest.mjs — proves findSiteRepo() (scripts/find-site-repo.mjs) actually refuses
// a stale candidate BY NAME instead of silently anchoring on it, never falls back to a further
// candidate once one is rejected, returns a real site when one is genuinely fresh, and degrades
// cleanly (no throw) when nothing is found — the four SO #40(b) proof points for
// FINDSITEREPO-ANCHOR-1. Builds hermetic, disposable git fixtures under the OS temp dir with plain
// `git` commands (no npm, no touching any real project checkout), reproducing the exact "fetched but
// not merged" staleness shape measured on the real `AINumbers/.wt/repo` stray clone, so this stays
// reproducible even after that directory is eventually cleaned up (a separate decision, not this
// row's).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findSiteRepo, isDescendantOfOriginMain } from './find-site-repo.mjs';

function git(args, cwd) {
  execFileSync('git', args, { cwd, stdio: ['ignore', 'ignore', 'ignore'] });
}

// A minimal git repo at `dir` on branch `main`, one commit.
function initOrigin(dir) {
  mkdirSync(dir, { recursive: true });
  git(['init', '-b', 'main'], dir);
  git(['config', 'user.email', 'test@example.com'], dir);
  git(['config', 'user.name', 'test'], dir);
  writeFileSync(join(dir, 'f.txt'), 'v1\n');
  git(['add', 'f.txt'], dir);
  git(['commit', '-m', 'v1'], dir);
}

function advance(dir, content) {
  writeFileSync(join(dir, 'f.txt'), content);
  git(['add', 'f.txt'], dir);
  git(['commit', '-m', 'advance'], dir);
}

function cloneFrom(originDir, dest) {
  mkdirSync(dest, { recursive: true });
  git(['clone', originDir, '.'], dest);
  git(['config', 'user.email', 'test@example.com'], dest);
  git(['config', 'user.name', 'test'], dest);
}

let failures = 0;
function expect(label, actual, expected) {
  const got = JSON.stringify(actual);
  const want = JSON.stringify(expected);
  if (got === want) {
    console.log(`✓ ${label}`);
  } else {
    console.error(`✗ ${label}: expected ${want}, got ${got}`);
    failures++;
  }
}

const root = mkdtempSync(join(tmpdir(), 'findsiterepo-selftest-'));
try {
  const origin = join(root, 'origin-src');
  initOrigin(origin);

  // FRESH candidate: a plain clone, HEAD == its own cached origin/main ref.
  const freshRepo = join(root, 'fresh-workspace', 'repo');
  cloneFrom(origin, freshRepo);

  // STALE candidate: clone, then origin advances, then the clone FETCHES (updates its local
  // origin/main tracking ref) but never merges/pulls — HEAD stays behind. This is the exact shape
  // measured on the real .wt/repo (a cached origin/main ref ahead of checked-out HEAD), not a
  // never-fetched repo (which would look trivially "fresh" against its own stale ref).
  const staleRepo = join(root, 'stale-workspace', 'repo');
  cloneFrom(origin, staleRepo);
  advance(origin, 'v2 — origin moved on\n');
  git(['fetch', 'origin'], staleRepo);

  // 1. RED — isDescendantOfOriginMain on the stale repo directly: refused, with a reason.
  const staleVerdict = isDescendantOfOriginMain(staleRepo);
  expect('isDescendantOfOriginMain: stale checkout is refused', staleVerdict.ok, false);
  console.log(`   reason: ${staleVerdict.reason}`);

  // 2. GREEN — isDescendantOfOriginMain on the fresh repo directly: accepted.
  expect('isDescendantOfOriginMain: fresh checkout is accepted', isDescendantOfOriginMain(freshRepo).ok, true);

  // 3. RED via findSiteRepo(): refusal is logged and NAMES the candidate; function returns null,
  // never the stale path.
  const staleLog = [];
  const foundStale = findSiteRepo(join(root, 'stale-workspace'), { log: (...a) => staleLog.push(a.join(' ')) });
  expect('findSiteRepo: refuses stale candidate, returns null (not the stale path)', foundStale, null);
  expect('findSiteRepo: refusal names the rejected path', staleLog.some((l) => l.includes(staleRepo)), true);

  // 4. GREEN via findSiteRepo(): a fresh candidate is returned as-is.
  const foundFresh = findSiteRepo(join(root, 'fresh-workspace'), { log: () => {} });
  expect('findSiteRepo: returns the fresh candidate', foundFresh, freshRepo);

  // 5. NO SILENT FALLBACK — a stale repo sits as the NEAR candidate, a genuinely fresh repo sits as
  // a FURTHER-UP candidate. Searching from below the near one must refuse it and STOP — never walk
  // past it to return the further, fresh one. (This is the whole point: the next stale tree found
  // this way will have a different name than `.wt/repo`, so silently skipping past a rejected
  // candidate is how the defect recurs.)
  const searchStart = join(root, 'nofallback', 'mid', 'child');
  mkdirSync(searchStart, { recursive: true });
  const nearRepo = join(root, 'nofallback', 'mid', 'repo'); // found at i=1 from searchStart
  const farRepo = join(root, 'nofallback', 'repo');          // found at i=2 from searchStart
  cloneFrom(origin, nearRepo); // origin currently at v2
  advance(origin, 'v3 — origin moved on again\n');
  git(['fetch', 'origin'], nearRepo); // near candidate: fetched-not-merged => STALE (behind v3)
  cloneFrom(origin, farRepo); // cloned at current tip v3 => HEAD == origin/main => FRESH

  const fallbackLog = [];
  const foundNoFallback = findSiteRepo(searchStart, { log: (...a) => fallbackLog.push(a.join(' ')) });
  expect('findSiteRepo: does not silently fall back to the further fresh candidate', foundNoFallback, null);
  expect('findSiteRepo: names the NEAR (rejected) candidate', fallbackLog.some((l) => l.includes(nearRepo)), true);
  expect('findSiteRepo: never even mentions the far candidate', fallbackLog.some((l) => l.includes(farRepo)), false);

  // 6. ABSENT — no `repo/.git` anywhere in the walked ancestry: returns null, no throw. Proves the
  // fix works whether or not a stale tree like `.wt/repo` exists on disk at all.
  const emptyStart = join(root, 'empty', 'a', 'b', 'c');
  mkdirSync(emptyStart, { recursive: true });
  let threwAbsent = null;
  let foundAbsent;
  try {
    foundAbsent = findSiteRepo(emptyStart, { log: () => {} });
  } catch (e) {
    threwAbsent = e;
  }
  expect('findSiteRepo: no repo/.git anywhere — no throw', threwAbsent, null);
  expect('findSiteRepo: no repo/.git anywhere — returns null', foundAbsent, null);

  // 7. isDescendantOfOriginMain on a nonexistent path — no throw, refused (defensive edge).
  let threwMissing = null;
  let verdictMissing;
  try {
    verdictMissing = isDescendantOfOriginMain(join(root, 'does-not-exist'));
  } catch (e) {
    threwMissing = e;
  }
  expect('isDescendantOfOriginMain: nonexistent path — no throw', threwMissing, null);
  expect('isDescendantOfOriginMain: nonexistent path — refused', verdictMissing && verdictMissing.ok, false);
} finally {
  try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort scratch cleanup */ }
}

if (failures > 0) {
  console.error(`\n✗ self-test FAILED: ${failures} case(s) did not match expectation`);
  process.exit(1);
}
console.log('\n✓ self-test PASSED: findSiteRepo refuses stale candidates by name, never silently falls back, returns fresh candidates, and degrades cleanly when nothing is found.');
process.exit(0);
