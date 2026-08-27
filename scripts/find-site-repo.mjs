// find-site-repo.mjs — resolves the sibling AINumbers site checkout (`repo/`) that preflight.mjs's
// site-dependent gates (chain-fixtures freshness, vendor-freshness, schema-validate, …) read from.
// Split out of preflight.mjs (which has no main-guard and runs its whole gate loop as an import
// side effect) so find-site-repo.selftest.mjs can import and drive these two functions directly,
// against synthetic fixtures, without spawning the entire 30-gate suite.
//
// FINDSITEREPO-ANCHOR-1: a `repo/.git` found while walking up is not automatically trustworthy — a
// stray, long-abandoned clone or worktree checkout can sit on disk (measured 2026-08-23:
// `AINumbers/.wt/repo`, HEAD ce514860, 141 commits behind origin/main, not a registered git
// worktree, 2 dirty entries) and be the FIRST candidate this walk finds. Silently anchoring on it
// made the chain-fixtures-freshness gate regenerate fixtures from stale data and report DRIFT
// against a bundle correctly vendored from current main — a false red with no code at fault.
// Reuse generate.mjs's assertRepoFresh descendant predicate (git merge-base --is-ancestor
// origin/main HEAD) here: refuse a non-descendant candidate LOUDLY — name the rejected path and
// why — and STOP; never walk quietly past it to the next candidate, because a resolver that picks
// the next one is exactly how this recurs under a different stale tree's name later.
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export function isDescendantOfOriginMain(repoPath) {
  try {
    execSync('git rev-parse --is-inside-work-tree', { cwd: repoPath, stdio: 'ignore' });
  } catch { return { ok: false, reason: 'not a git repository' }; }
  try {
    execSync('git rev-parse --verify origin/main', { cwd: repoPath, stdio: 'ignore' });
  } catch { return { ok: false, reason: 'no origin/main ref resolvable (never fetched from origin)' }; }
  try {
    execSync('git merge-base --is-ancestor origin/main HEAD', { cwd: repoPath, stdio: 'ignore' });
  } catch { return { ok: false, reason: 'HEAD is not a descendant of origin/main — stale checkout' }; }
  return { ok: true };
}

// A blind '../repo' sibling assumption breaks when this checkout is a nested worktree
// (mcp-apps-poc/.claude/worktrees/<id>/mcp-apps-poc or mcp-apps-poc/.worktrees/<id>/mcp-apps-poc):
// '../repo' then resolves inside the worktree nesting, not the real site checkout — silently
// skipping the site-dependent gates (or, if a stray sibling exists there, comparing against a
// stale one). Walk up from `root` looking for the first ancestor with a `repo/.git`. Returns the
// first FRESH candidate found; returns null (never a stale or unverified path) when the first
// `repo/.git` found is stale, or when the walk finds no `repo/.git` at all — the caller then
// treats a missing site the same way it always has: site-dependent gates skipped, CI backstops.
// `log` defaults to console.error; the self-test passes a capturing stub instead.
export function findSiteRepo(root, { log = (...a) => console.error(...a) } = {}) {
  let dir = root;
  for (let i = 0; i < 8; i++) {
    const candidate = resolve(dir, 'repo');
    if (existsSync(resolve(candidate, '.git'))) {
      const fresh = isDescendantOfOriginMain(candidate);
      if (fresh.ok) return candidate;
      log(`❌ [findSiteRepo] REFUSING stale candidate: ${candidate} — ${fresh.reason}.`);
      log(`   Not silently walking further up to another candidate (that is how this recurs under a different stale tree). Site-dependent gates skip this run (CI backstops them); point SITE_REPO at a clean, fresh checkout to run them locally.`);
      return null;
    }
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}
