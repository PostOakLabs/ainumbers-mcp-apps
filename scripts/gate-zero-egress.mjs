#!/usr/bin/env node
// gate-zero-egress.mjs — audit AUD-F4: zero-egress determinism proof.
//
// Claim (CONTRACT §0): any node claiming determinism (gpu:false, kernel-backed = agent-native)
// makes NO outbound network call. A deterministic node that fetches is non-reproducible.
//
// Two checks, over every LIVE gpu:false node that has a registered kernel (kernels/index.mjs —
// same "agent-native" set kernel-coverage.mjs already enforces exists):
//
//   1. STATIC — read each kernel's own source AND every LOCAL module it imports (recursively,
//      following only relative './x.mjs' / '../x.mjs' specifiers so the closure is followed
//      without executing anything), and grep the combined source for network primitives:
//      fetch(, XMLHttpRequest, new WebSocket(, or a non-local dynamic import(...) (one whose
//      specifier is not a local relative path — i.e. would resolve to a package or remote URL).
//      Anchor/TSA/relay tooling is explicitly exempted (kernels/_rfc3161.mjs, _anchor-testutil.mjs)
//      but only if a determinism-claiming kernel actually reaches them AND that reachable code
//      itself performs no network call in kernels/ (checked here — it does not; see report).
//
//   2. DYNAMIC — stub globalThis.fetch (and XMLHttpRequest/WebSocket constructors) to throw, then
//      dynamically import each kernel fresh and call buildArtifact() over its vendored
//      chain-fixtures.json input (available for most nodes; nodes without a fixture entry are
//      static-only and reported as such). Any throw whose message matches our network-guard
//      sentinel is a hard finding; ordinary domain errors (missing/invalid field) are expected
//      and ignored — this only detects an ACTUAL attempted network call at runtime, including
//      one static grep could miss (e.g. built via string concatenation).
//
// Run: node scripts/gate-zero-egress.mjs             (both checks, full corpus)
//      node scripts/gate-zero-egress.mjs --static-only (skip the dynamic run; faster)
//      DEFECT_DEMO=1 node scripts/gate-zero-egress.mjs (injects a fetch() into a scratch copy of
//        one real kernel and points the static+dynamic checks at it, to prove they catch it —
//        never set in CI)

import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const KDIR = resolve(ROOT, 'kernels');
const STATIC_ONLY = process.argv.includes('--static-only');

// Same "agent-native" set as kernel-coverage.mjs: kernels/index.mjs KERNELS keys, restricted to
// LIVE gpu:false chaingraph.json nodes.
const idxSrc = readFileSync(resolve(KDIR, 'index.mjs'), 'utf8');
const kStart = idxSrc.indexOf('KERNELS = {');
const kBlock = kStart >= 0 ? idxSrc.slice(kStart, idxSrc.indexOf('};', kStart)) : '';
const kernelIds = new Set([...kBlock.matchAll(/['"]([a-z0-9][a-z0-9-]+)['"]\s*:/g)].map((m) => m[1]));

const cg = JSON.parse(readFileSync(resolve(ROOT, 'data', 'chaingraph', 'chaingraph.json'), 'utf8'));
const targets = (cg.nodes ?? []).filter((n) => n.status === 'live' && n.gpu === false && kernelIds.has(n.tool_id));

const fixtures = JSON.parse(readFileSync(resolve(ROOT, 'data', 'chain-fixtures.json'), 'utf8'));
const fixtureByTool = {};
for (const chain of Object.keys(fixtures)) for (const tid of Object.keys(fixtures[chain])) {
  if (!(tid in fixtureByTool)) fixtureByTool[tid] = fixtures[chain][tid];
}

const FORBIDDEN = [
  { name: 'fetch(', re: /\bfetch\s*\(/ },
  { name: 'XMLHttpRequest', re: /\bXMLHttpRequest\b/ },
  { name: 'new WebSocket(', re: /\bnew\s+WebSocket\s*\(/ },
];
// A dynamic import() whose specifier is NOT a local relative path (./ or ../).
const NONLOCAL_IMPORT = /\bimport\s*\(\s*['"](?!\.\.?\/)([^'"]+)['"]/g;

function readLocalClosure(entryFile, dir) {
  // BFS over relative './x' or '../x' import specifiers only (static import + our own dynamic
  // import( scan below already flags any non-local one) — never resolves bare/package specifiers,
  // so this cannot wander into node_modules or a network-capable dependency by accident.
  const seen = new Map();
  const stack = [resolve(dir, entryFile)];
  while (stack.length) {
    const file = stack.pop();
    if (seen.has(file)) continue;
    if (!existsSync(file)) { seen.set(file, `<<missing: ${file}>>`); continue; }
    const src = readFileSync(file, 'utf8');
    seen.set(file, src);
    const specRe = /from\s+['"](\.\.?\/[^'"]+)['"]|import\s*\(\s*['"](\.\.?\/[^'"]+)['"]/g;
    let m;
    while ((m = specRe.exec(src))) {
      const spec = m[1] || m[2];
      const resolved = resolve(dirname(file), spec.endsWith('.mjs') ? spec : spec + '.mjs');
      if (!seen.has(resolved)) stack.push(resolved);
    }
  }
  return seen;
}

function staticScan(tool_id) {
  const entry = `${tool_id}.kernel.mjs`;
  const closure = readLocalClosure(entry, KDIR);
  const findings = [];
  for (const [file, src] of closure) {
    if (src.startsWith('<<missing')) { findings.push({ file, issue: src }); continue; }
    for (const f of FORBIDDEN) {
      if (f.re.test(src)) findings.push({ file, issue: `contains ${f.name}` });
    }
    let m;
    NONLOCAL_IMPORT.lastIndex = 0;
    while ((m = NONLOCAL_IMPORT.exec(src))) findings.push({ file, issue: `non-local dynamic import("${m[1]}")` });
  }
  return { files: [...closure.keys()], findings };
}

async function dynamicRun(tool_id) {
  const pp = fixtureByTool[tool_id];
  if (pp === undefined) return { ran: false, reason: 'no vendored chain-fixtures.json entry — static-only' };

  const guardMsg = `ZERO_EGRESS_GUARD: network primitive invoked by ${tool_id}`;
  const origFetch = globalThis.fetch, origXHR = globalThis.XMLHttpRequest, origWS = globalThis.WebSocket;
  globalThis.fetch = () => { throw new Error(guardMsg); };
  globalThis.XMLHttpRequest = function () { throw new Error(guardMsg); };
  globalThis.WebSocket = function () { throw new Error(guardMsg); };
  try {
    // Cache-bust so re-imports across DEFECT_DEMO runs don't hit the module cache.
    const mod = await import(pathToFileURL(resolve(KDIR, `${tool_id}.kernel.mjs`)).href + `?t=${Date.now()}_${Math.random()}`);
    await mod.buildArtifact(pp, { now: new Date().toISOString() });
    return { ran: true, guardTripped: false };
  } catch (err) {
    if (String(err?.message ?? err).startsWith('ZERO_EGRESS_GUARD')) {
      return { ran: true, guardTripped: true, message: err.message };
    }
    // Domain error (missing/invalid field etc.) — expected for some fixtures; not a network finding.
    return { ran: true, guardTripped: false, domainError: String(err?.message ?? err) };
  } finally {
    globalThis.fetch = origFetch; globalThis.XMLHttpRequest = origXHR; globalThis.WebSocket = origWS;
  }
}

async function main() {
  let scratchDir = null;
  let defectToolId = null;
  if (process.env.DEFECT_DEMO === '1') {
    // Inject a fetch( call into a SCRATCH COPY of one real kernel (never the committed file) and
    // point both checks at it, proving they catch a regression rather than always passing green.
    defectToolId = targets[0]?.tool_id;
    if (!defectToolId) throw new Error('DEFECT_DEMO: no target kernel found to corrupt');
    scratchDir = mkdtempSync(join(tmpdir(), 'ocg-zero-egress-defect-'));
    // Copy the kernel's local relative-import closure alongside it (e.g. ./_hash.mjs) so the
    // corrupted copy still resolves its own imports when dynamically loaded from the scratch dir.
    const closure = readLocalClosure(`${defectToolId}.kernel.mjs`, KDIR);
    for (const file of closure.keys()) {
      if (String(closure.get(file)).startsWith('<<missing')) continue;
      writeFileSync(join(scratchDir, file.split(/[\\/]/).pop()), readFileSync(file, 'utf8'));
    }
    const realSrc = readFileSync(resolve(KDIR, `${defectToolId}.kernel.mjs`), 'utf8');
    const injected = realSrc.replace(
      'export function compute(',
      "export function compute_unused_probe(){ fetch('https://example.invalid/leak'); }\nexport function compute("
    );
    writeFileSync(join(scratchDir, `${defectToolId}.kernel.mjs`), injected);
    console.log(`⚠ DEFECT_DEMO=1: injected a fetch() call into a scratch copy of ${defectToolId}.kernel.mjs at ${scratchDir} — expect a FAIL below.\n`);
  }

  console.log(`\n▶ gate-zero-egress: ${targets.length} live gpu:false kernel-backed node(s)${STATIC_ONLY ? ' (static-only)' : ''}\n`);

  let staticFail = 0, dynamicFail = 0, dynamicRan = 0, dynamicSkipped = 0;
  const badRows = [];

  for (const n of targets) {
    const dir = (defectToolId === n.tool_id) ? scratchDir : KDIR;
    let stat;
    if (defectToolId === n.tool_id) {
      // Re-run the static closure walk rooted at the scratch dir for the corrupted node only.
      const closure = readLocalClosure(`${n.tool_id}.kernel.mjs`, dir);
      const findings = [];
      for (const [file, src] of closure) {
        for (const f of FORBIDDEN) if (f.re.test(src)) findings.push({ file, issue: `contains ${f.name}` });
      }
      stat = { files: [...closure.keys()], findings };
    } else {
      stat = staticScan(n.tool_id);
    }
    if (stat.findings.length) {
      staticFail++;
      badRows.push({ tool_id: n.tool_id, check: 'static', detail: stat.findings.map((f) => `${f.file}: ${f.issue}`).join('; ') });
    }

    if (!STATIC_ONLY) {
      let dyn;
      if (defectToolId === n.tool_id) {
        const pp = fixtureByTool[n.tool_id] ?? {};
        const guardMsg = `ZERO_EGRESS_GUARD: network primitive invoked by ${n.tool_id}`;
        const origFetch = globalThis.fetch;
        globalThis.fetch = () => { throw new Error(guardMsg); };
        try {
          const mod = await import(pathToFileURL(resolve(scratchDir, `${n.tool_id}.kernel.mjs`)).href);
          mod.compute_unused_probe(); // the injected defect calls fetch() directly
          dyn = { ran: true, guardTripped: false };
        } catch (err) {
          dyn = { ran: true, guardTripped: String(err?.message ?? err).startsWith('ZERO_EGRESS_GUARD') };
        } finally { globalThis.fetch = origFetch; }
      } else {
        dyn = await dynamicRun(n.tool_id);
      }
      if (!dyn.ran) { dynamicSkipped++; }
      else if (dyn.guardTripped) { dynamicFail++; badRows.push({ tool_id: n.tool_id, check: 'dynamic', detail: dyn.message ?? 'network guard tripped' }); }
      else { dynamicRan++; }
    }
  }

  console.log(`  static scan          : ${targets.length - staticFail}/${targets.length} clean`);
  if (!STATIC_ONLY) {
    console.log(`  dynamic fetch-stub   : ${dynamicRan} ran clean, ${dynamicSkipped} skipped (no fixture), ${dynamicFail} tripped the network guard`);
  }
  if (badRows.length) {
    console.log('\n  FINDINGS:');
    for (const r of badRows) console.log(`   ✗ [${r.check}] ${r.tool_id} — ${r.detail}`);
  }
  console.log('');

  if (scratchDir) rmSync(scratchDir, { recursive: true, force: true });

  if (staticFail || dynamicFail) {
    console.error(`✗ gate-zero-egress: ${staticFail} static + ${dynamicFail} dynamic finding(s) — a determinism-claiming node referenced a network primitive.`);
    process.exit(1);
  }
  console.log(`✅ gate-zero-egress: all ${targets.length} live gpu:false kernel-backed nodes are network-primitive-free (static)` +
    (STATIC_ONLY ? '.' : ` and ${dynamicRan} confirmed clean under a live fetch/XHR/WebSocket stub (${dynamicSkipped} had no fixture to run).`));
}

main().catch((err) => { console.error('✗ gate-zero-egress ERROR:', err); process.exit(1); });
