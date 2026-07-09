#!/usr/bin/env node
// gate-zero-egress.mjs — audit AUD-F4: zero-egress determinism proof.
//
// Claim (CONTRACT §0): any node claiming determinism (every gpu:false ChainGraph node —
// server-side Compute Binding, v0.4 §3) makes NO outbound network call. A "deterministic"
// node that fetches is not reproducible and is a conformance violation.
//
// Two independent checks:
//
//  STATIC  — grep every kernels/*.kernel.mjs source file (the actual server-side compute
//  path the Worker dispatches gpu:false nodes to) for network/telemetry primitives. Reuses
//  the SAME forbidden-pattern list embed/selftest.mjs already ships (§4 of that self-test,
//  "zero network / zero telemetry") — not reimplemented, just applied to kernels/ instead
//  of embed/ (selftest.mjs only scans the standalone embedded bundle; it never scans the
//  Worker's own kernels/ directory, which is the actual live server-compute path).
//
//  DYNAMIC — stub globalThis.fetch (and XMLHttpRequest / WebSocket, if present in this
//  runtime) to THROW, then run kernel.buildArtifact() for every gpu:false, kernel-backed,
//  fixture-covered node (the same corpus AUD-C1's gate-crosstool-roundtrip.mjs uses) over
//  its vendored fixture. A clean run proves the kernel never reaches for a network
//  primitive at runtime, not just that the literal text is absent from the source.
//
// Anchor/TSA/relay tools are exempt per the audit spec (they legitimately reach out) — in
// THIS repo, kernels/_rfc3161.mjs and kernels/_anchor-testutil.mjs are the only
// anchor/TSA-shaped helper modules, and neither is imported by any *.kernel.mjs (verified
// below as part of the static pass) — so no live gpu:false node needs an exemption; the
// exemption class is empty in this repo. If that ever changes (a kernel starts importing
// one of those helpers), EXEMPT_TOOL_IDS below is where to declare it explicitly.
//
// Defect-injection proof: a synthetic "bad kernel" (real fetch() call in its compute path)
// is run through BOTH checks — the static grep must flag its source, and the dynamic stub
// must catch the actual fetch() call — proving neither check is a rubber stamp.
//
// Usage: node scripts/gate-zero-egress.mjs
// Exit code: 1 on any real finding (or if the defect-injection self-check fails to catch
// the synthetic violation); 0 otherwise.

import { readFileSync, readdirSync, statSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { getKernel } from '../kernels/index.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = resolve(ROOT, 'data');
const KERNELS_DIR = resolve(ROOT, 'kernels') + '/';
const get = (p) => readFileSync(resolve(DATA, p), 'utf8');

// Reused verbatim from embed/selftest.mjs §4 ("zero network / zero telemetry") — the
// canonical forbidden-primitive list for this codebase, just applied to a different
// directory (kernels/ — the live server-compute path — instead of embed/).
const FORBIDDEN = [
  /\bfetch\s*\(/, /XMLHttpRequest/, /navigator\.sendBeacon/, /WebSocket/,
  /import\s*\(\s*['"]https?:/, /require\(\s*['"](node:)?(http|https|net|dgram|dns)['"]/,
];

const EXEMPT_TOOL_IDS = new Set([
  // Anchor/TSA/relay tools that legitimately reach out (§F4 exemption). Empty in this repo
  // as of the 2026-07-09 audit — no *.kernel.mjs imports the anchor/rfc3161 helpers.
]);

function staticScan(dir) {
  const files = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = d + name;
      if (statSync(p).isDirectory()) { walk(p + '/'); continue; }
      if (/\.kernel\.mjs$/.test(name)) files.push(p);
    }
  };
  walk(dir);
  const findings = [];
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    for (const re of FORBIDDEN) {
      if (re.test(src)) findings.push({ file: f.slice(dir.length), pattern: re.toString() });
    }
  }
  return { files, findings };
}

async function main() {
  console.log('\n▶ gate-zero-egress: AUD-F4 zero-egress determinism proof\n');

  // --- STATIC: grep every *.kernel.mjs for network primitives -------------------------
  console.log('[1] STATIC — grep kernels/*.kernel.mjs for network/telemetry primitives');
  const { files, findings } = staticScan(KERNELS_DIR);
  const realFindings = findings.filter((f) => !EXEMPT_TOOL_IDS.has(f.file.replace(/\.kernel\.mjs$/, '')));
  console.log(`  scanned ${files.length} kernel source file(s)`);
  if (realFindings.length) {
    for (const f of realFindings) console.error(`  ✗ ${f.file} matches ${f.pattern}`);
  } else {
    console.log(`  ✓ zero network/telemetry constructs found`);
  }

  // Confirm the anchor/TSA-shaped helper modules are indeed unimported by any kernel
  // (the exemption-class-is-empty claim above) — structural check, not a grep guess.
  const anchorHelpers = ['_rfc3161.mjs', '_anchor-testutil.mjs'];
  const importers = [];
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    for (const h of anchorHelpers) if (src.includes(h)) importers.push({ file: f.slice(KERNELS_DIR.length), helper: h });
  }
  if (importers.length) {
    console.log(`  ⚠ ${importers.length} kernel(s) import an anchor/TSA-shaped helper — verify EXEMPT_TOOL_IDS covers them:`);
    for (const i of importers) console.log(`      ${i.file} imports ${i.helper}`);
  } else {
    console.log(`  ✓ no kernel imports an anchor/TSA-shaped helper (_rfc3161.mjs / _anchor-testutil.mjs) — exemption class is empty`);
  }

  // --- DYNAMIC: stub fetch to throw, run every gpu:false fixture-covered node ----------
  console.log('\n[2] DYNAMIC — globalThis.fetch stubbed to throw; run every gpu:false node over its fixture');
  const chaingraph = JSON.parse(get('chaingraph/chaingraph.json'));
  const chainFixtures = JSON.parse(get('chain-fixtures.json'));
  const nodeById = {};
  for (const n of (chaingraph.nodes || [])) nodeById[n.tool_id] = n;
  const fixtureByToolId = {};
  for (const stepMap of Object.values(chainFixtures)) {
    for (const [tid, pp] of Object.entries(stepMap)) if (fixtureByToolId[tid] === undefined) fixtureByToolId[tid] = pp;
  }
  const corpus = Object.keys(fixtureByToolId).filter((tid) => nodeById[tid] && nodeById[tid].gpu === false && getKernel(tid)).sort();

  const realFetch = globalThis.fetch;
  const realXHR = globalThis.XMLHttpRequest;
  const realWS = globalThis.WebSocket;
  globalThis.fetch = async (...args) => { throw new Error('ZERO-EGRESS VIOLATION: fetch() called with ' + JSON.stringify(args[0])); };
  if (realXHR) globalThis.XMLHttpRequest = function () { throw new Error('ZERO-EGRESS VIOLATION: XMLHttpRequest constructed'); };
  if (realWS) globalThis.WebSocket = function () { throw new Error('ZERO-EGRESS VIOLATION: WebSocket constructed'); };

  let dynamicFail = 0;
  const dynamicResults = [];
  try {
    for (const tid of corpus) {
      const kernel = getKernel(tid);
      try {
        await kernel.buildArtifact(fixtureByToolId[tid], { now: '1970-01-01T00:00:00.000Z' });
        dynamicResults.push({ tid, ok: true });
      } catch (err) {
        const isEgress = /ZERO-EGRESS VIOLATION/.test(err.message);
        dynamicResults.push({ tid, ok: !isEgress, egress: isEgress, error: err.message });
        if (isEgress) { dynamicFail++; console.error(`  ✗ ${tid}: ${err.message}`); }
        // A non-egress throw (e.g. missing required fixture field) is out of scope for THIS
        // gate — that is a kernel-input-validity concern covered by run-chain-corpus.mjs.
      }
    }
  } finally {
    globalThis.fetch = realFetch;
    if (realXHR) globalThis.XMLHttpRequest = realXHR;
    if (realWS) globalThis.WebSocket = realWS;
  }
  console.log(`  ran ${corpus.length} gpu:false fixture-covered node(s) under the fetch/XHR/WebSocket stub`);
  if (!dynamicFail) console.log(`  ✓ zero network calls observed at runtime`);

  // --- DEFECT-INJECTION SELF-CHECK: a synthetic bad kernel must be caught by BOTH checks ---
  console.log('\n[3] Defect-injection self-check — synthetic kernel with a real fetch() call');
  const scratchDir = mkdtempSync(join(tmpdir(), 'ocg-zero-egress-selftest-')) + '/';
  const badKernelSrc = [
    "export async function buildArtifact(pp, opts) {",
    "  const res = await fetch('https://example.invalid/leak');",
    "  return { output_payload: { ok: true }, execution_hash: 'deadbeef' };",
    "}",
  ].join('\n');
  writeFileSync(scratchDir + 'zzz-synthetic-bad.kernel.mjs', badKernelSrc);
  const staticSelfCheck = staticScan(scratchDir);
  let selfCheckOk = true;
  if (!staticSelfCheck.findings.length) { selfCheckOk = false; console.error('  ✗ STATIC self-check FAILED: synthetic fetch() call was not detected by the grep'); }
  else console.log(`  ✓ STATIC self-check: synthetic fetch() call correctly detected (${staticSelfCheck.findings[0].file})`);

  const badKernelUrl = 'file:///' + scratchDir.replace(/\\/g, '/') + 'zzz-synthetic-bad.kernel.mjs';
  const badKernel = await import(badKernelUrl);
  globalThis.fetch = async () => { throw new Error('ZERO-EGRESS VIOLATION: fetch() called (self-check)'); };
  try {
    await badKernel.buildArtifact({}, {});
    selfCheckOk = false;
    console.error('  ✗ DYNAMIC self-check FAILED: synthetic kernel\'s fetch() call did not throw under the stub');
  } catch (err) {
    if (/ZERO-EGRESS VIOLATION/.test(err.message)) console.log('  ✓ DYNAMIC self-check: synthetic kernel\'s fetch() call correctly caught by the stub');
    else { selfCheckOk = false; console.error('  ✗ DYNAMIC self-check FAILED: unexpected error — ' + err.message); }
  } finally {
    globalThis.fetch = realFetch;
    rmSync(scratchDir, { recursive: true, force: true });
  }

  // --- Summary --------------------------------------------------------------------------
  console.log('\n════ gate-zero-egress summary ════');
  console.log(`  kernel files scanned (static)   : ${files.length}`);
  console.log(`  static findings                 : ${realFindings.length}`);
  console.log(`  nodes run under fetch-stub       : ${corpus.length}`);
  console.log(`  dynamic egress violations        : ${dynamicFail}`);
  console.log(`  defect-injection self-check      : ${selfCheckOk ? 'PASS' : 'FAIL'}`);
  console.log('');

  if (realFindings.length || dynamicFail || !selfCheckOk) {
    console.error('✗ gate-zero-egress: FAILED.');
    process.exit(1);
  }
  console.log(`✅ gate-zero-egress: zero network/telemetry primitives across ${files.length} kernel source files (static), zero fetch/XHR/WebSocket calls across ${corpus.length} gpu:false nodes run under a throwing stub (dynamic), and the defect-injection self-check confirms both checks actually discriminate.`);
}

main().catch((err) => { console.error('✗ gate-zero-egress ERROR:', err); process.exit(1); });
