# EGRESS-SCANNER-COMMENT-1 — 2026-07-26

## Root cause (confirmed)
`gate-zero-egress.mjs` matched `FORBIDDEN`/`NONLOCAL_IMPORT` regexes against raw kernel source,
including inside `//` and `/* */` comments. `chaingraph/kernels/art-336-compute-ltv-ratios.kernel.mjs`
(and the vendored copy under `mcp-apps-poc/kernels/`) carries a prose comment (added by
`S18-ART336-FIX-1`) that quotes a runtime failure message naming `import(` and `_hash.mjs`:

```
// MEASURED, 2026-07-25 (S18-ART336-FIX-1): a dynamic `import('./_hash.mjs')` inside
// rejects the dynamic import ("could not load module '_hash.mjs'"), so the shape this
// is computed. Pinned by a self-check vector, verified against _hash.mjs's own cgCanon.
```

The stale vendored `mcp-apps-poc/kernels/art-336-compute-ltv-ratios.kernel.mjs` (4736 bytes,
`ASSEMBLE-LAND-ART336-1`'s half-land) did not yet contain this comment, so the false positive was
invisible until the vendor completed. Re-vendoring from a fresh `origin/main` checkout brought it
in, and the gate went RED as predicted — see the RED quote below.

## RED (before fix, freshly vendored art-336 kernel)
```
▶ gate-zero-egress: 462 live gpu:false kernel-backed node(s)

  static scan          : 461/462 clean
  dynamic fetch-stub   : 327 ran clean, 135 skipped (no fixture), 0 tripped the network guard

  FINDINGS:
   ✗ [static] art-336-compute-ltv-ratios — .../kernels/art-336-compute-ltv-ratios.kernel.mjs: non-local dynamic import("could not load module ")

✗ gate-zero-egress: 1 static + 0 dynamic finding(s) — a determinism-claiming node referenced a network primitive.
```

## Fix
Added `stripComments()` to `gate-zero-egress.mjs`: a char-by-char scanner that tracks active
string-literal state (`'`, `"`, `` ` ``, with backslash-escape handling) and only treats `//`/`/* */`
outside a string as a comment. `readLocalClosure()` now stores the **stripped** source (used for
both the specifier-traversal regex and the FORBIDDEN/NONLOCAL_IMPORT match), so a comment can
neither trip a false positive nor add a phantom traversal edge. `stripComments`, `FORBIDDEN`, and
`NONLOCAL_IMPORT` are now named exports so the regression fixtures can exercise the exact
production regexes.

**`art-336-compute-ltv-ratios.kernel.mjs` was never edited — 0 bytes changed, `kernel_digest`
unaffected (confirmed below).**

## GREEN (after fix, same freshly vendored kernel)
```
▶ gate-zero-egress: 462 live gpu:false kernel-backed node(s)

  static scan          : 462/462 clean
  dynamic fetch-stub   : 327 ran clean, 135 skipped (no fixture), 0 tripped the network guard

✅ gate-zero-egress: all 462 live gpu:false kernel-backed nodes are network-primitive-free (static) and 327 confirmed clean under a live fetch/XHR/WebSocket stub (135 had no fixture to run).
```

## Still bites (real defect injection, unchanged mechanism, re-verified after the fix)
```
DEFECT_DEMO=1 node scripts/gate-zero-egress.mjs --static-only
⚠ DEFECT_DEMO=1: injected a fetch() call into a scratch copy of 503-canton-tokenization-readiness-diagnostic.kernel.mjs ...
  static scan          : 461/462 clean
  FINDINGS:
   ✗ [static] 503-canton-tokenization-readiness-diagnostic — ...: contains fetch(
✗ gate-zero-egress: 1 static + 0 dynamic finding(s) ...
```

## Regression fixtures (pinned, `scripts/gate-zero-egress-comment.test.mjs`)
1. art-336's real `//` prose comment → CLEAN.
2. Same trap in a `/* */` block comment → CLEAN.
3. A string literal containing `"//"` (a URL) → CLEAN, proving the stripper does not eat live code
   that merely resembles a comment start.
4. A REAL non-local `import('some-network-package')` sitting in live code → FLAGGED.
5. A REAL `fetch(` call in live code sitting next to a comment that also mentions `fetch(` in prose
   → FLAGGED (proves the two do not cancel out).

All five green: `node scripts/gate-zero-egress-comment.test.mjs` exits 0.

## Vendor completion (Job 3/4)
- `node generate.mjs --repo=<fresh origin/main checkout>` run from a clean worker worktree
  (`AINumbers/.wt/egress-scanner-comment-1`), vendoring against
  `AINumbers/.wt/egress-scanner-comment-1-site-read` (detached `origin/main`, commit `0c78d83`).
- Vendor diff is minimal, as expected for a single-kernel reprove:
  `data/chaingraph/chaingraph.json` (2 insertions/26 deletions — the art-336 node record),
  `data/kernels/art-336-compute-ltv-ratios.kernel.mjs`, `kernels/art-336-compute-ltv-ratios.kernel.mjs`.
- Post-vendor `art-336-compute-ltv-ratios.kernel.mjs` is 12643 bytes (was 4736 stale) — confirms
  the half-land is now closed by this vendor.

## §18 gates — re-run, unmoved
See board row EGRESS-SCANNER-COMMENT-1 check-off line for the literal re-run output; both gates
were run against `repo/` (site) at `origin/main` commit `0c78d83` and reported unchanged from the
figures `ASSEMBLE-LAND-ART336-1` already moved to (`462/462` proven, `131` digest-fresh).
