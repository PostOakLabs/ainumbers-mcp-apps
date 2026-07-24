#!/usr/bin/env node
// check-preflight-parity.mjs — fail if the CI "Validate MCP server" job runs a
// `node scripts/*.mjs` gate that scripts/preflight.mjs does NOT run locally.
//
// WHY: preflight.mjs claims "green preflight ⇒ green Validate job", but the two
// lists were maintained by hand and silently drifted — the §23 input-attestations
// gate (validate-input-attestations.test.mjs) was in CI but not in preflight, so a
// broken commit passed pre-push and red-failed CI on master (run 30105102021,
// 2026-07-24, fixed by the very next push). This gate makes the drift itself a
// failure: add a gate to CI and you MUST add it to preflight, or this blocks.
//
// Text-based on purpose: reads both files as source and compares script basenames.
// No importing preflight.mjs (that would execute its gate loop). Zero-dep.
import { readFileSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CI = resolve(ROOT, ".github/workflows/ci.yml");
const PREFLIGHT = resolve(ROOT, "scripts/preflight.mjs");

// Gates that legitimately run ONLY in CI, never pre-push, with the reason each
// can't run on a developer's machine before a push. Keep this list tight — every
// entry is a hole in "green preflight ⇒ green CI", so only add ones that are
// physically impossible locally (need a live deployed worker or the cloud env).
const CI_ONLY = new Map([
  ["run-chain-corpus.mjs", "integration corpus — runs in the post-build job, not the static Validate gates"],
  ["smoke-mcp.mjs", "post-deploy smoke — needs the live deployed /mcp endpoint"],
  ["hash-sweep.mjs", "post-deploy — sweeps the live worker"],
  ["verify-mcp-registered.mjs", "post-deploy — checks the live MCP registry"],
]);

function scriptBasenames(text) {
  const out = new Set();
  // matches `node scripts/foo.mjs` and `scripts/foo.mjs` (preflight args entries)
  const re = /scripts[\/\\]([\w.-]+\.mjs)/g;
  let m;
  while ((m = re.exec(text))) out.add(basename(m[1]));
  return out;
}

// CI gates: only the `run: node scripts/X.mjs` invocations (ignore comments/paths).
function ciGates(text) {
  const out = new Set();
  const re = /run:\s*node\s+scripts[\/\\]([\w.-]+\.mjs)/g;
  let m;
  while ((m = re.exec(text))) out.add(basename(m[1]));
  return out;
}

function main() {
  const ci = ciGates(readFileSync(CI, "utf8"));
  const pre = scriptBasenames(readFileSync(PREFLIGHT, "utf8"));

  const missing = [...ci].filter((g) => !pre.has(g) && !CI_ONLY.has(g)).sort();

  if (missing.length) {
    console.error(`✗ preflight↔CI parity: ${missing.length} CI gate(s) not run by preflight.mjs:`);
    for (const g of missing) console.error(`    - ${g}`);
    console.error(`  Add each to the gates[] array in scripts/preflight.mjs (or, if it truly`);
    console.error(`  cannot run pre-push, allowlist it in CI_ONLY here with a reason).`);
    process.exit(1);
  }

  console.log(`✓ preflight↔CI parity: all ${ci.size} CI gates covered (${CI_ONLY.size} CI-only allowlisted).`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
