#!/usr/bin/env node
// gate-error-registry.mjs — the error-code registry (errors.mjs) is the SINGLE CONSTRUCTION SITE
// for the worker's JSON-RPC error responses (ERROR-REGISTRY-REQUEST-ID-SPEC.md §4, row
// AICONTRACT-PART-B-1).
//
// WHY: before errors.mjs, every protocol-layer error body was a hand-rolled inline literal
// (21 sites in worker.mjs + 5 in the dev server) with nothing but review discipline stopping an
// edit from conflating the rate-limit path (-32029, transport availability) with a validation
// error (-32602), "restoring" the pre-#2907 -32001 header-mismatch mapping, or dropping the
// additive `request_id` envelope. This gate makes each of those a build failure:
//
//   construction-site   every JSON-RPC error construction (`error: { code:` shape or a
//                       mcpJsonRpcErrorResponse-shaped call) in worker.mjs / server.mjs must be
//                       covered by scripts/error-registry.baseline.json (the frozen dev-server
//                       sites) — migrated sites resolve to errors.mjs constructors instead and
//                       carry no inline shape at all.
//   unregistered-name   every protocolErrorResponse()/protocolErrorBody() call must use a name
//                       the errors.mjs registry actually exports (typo-proofing).
//   frozen-code         the conflation codes -32029 / -32001 / -32020 may be MINTED only inside
//                       errors.mjs (spec §2.3: throttle is never conflated; -32001 is watchdog-
//                       only since modelcontextprotocol#2907 renumbered the header mismatch).
//   data-reason         an inline `error.data.reason` literal may only be 'ijson_violation'.
//   additivity          the `request_id` envelope member must exist in BOTH errors.mjs builders
//                       and in the Analytics tool-call datum's blobs list; the initialize datum
//                       must stay request_id-free (spec §3: initialize datum unchanged).
//   registry-drift      the registry's frozen message prefixes/codes themselves are pinned here,
//                       so editing errors.mjs cannot silently rename what the smoke asserts.
//   baseline-anchor     baseline entries are line-anchored: if the anchored line stops carrying
//                       the recorded wire code, the baseline no longer describes reality → RED.
//
// Zero-dep and text-only over worker.mjs/server.mjs (SO #34 security rider, same as
// gate-hash-ssot): the gate never evaluates the file it judges. It DOES import errors.mjs — the
// registry is the SSOT being enforced, and importing it (never re-typing it) is the point.
//
// Run:  node scripts/gate-error-registry.mjs --check
// Prove it can fail:  node scripts/gate-error-registry.selftest.mjs

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TARGETS = ['worker.mjs', 'server.mjs'];
const REGISTRY_FILE = 'errors.mjs';
const BASELINE_FILE = resolve(ROOT, 'scripts', 'error-registry.baseline.json');

// The codes whose minting is confined to errors.mjs (spec §4.1 conflation rule).
export const FROZEN_CODES = ['-32029', '-32001', '-32020'];

// Strip line + block comments so a rule can never fire on (or be evaded by) prose. Same order
// caveat as gate-hash-ssot (a line comment containing `*/*` must not open a phantom block
// comment): line comments go first. Every replacement preserves the comment's NEWLINES so a
// violation's reported line number is the line in the REAL file.
export function stripComments(src) {
  const blank = (m) => m.replace(/[^\n]/g, ' ');
  return src
    .replace(/^[ \t]*\/\/.*$/gm, blank)
    .replace(/([^:'"`\\])(\/\/[^\n'"`]*$)/gm, (_, p1, p2) => p1 + ' '.repeat(p2.length))
    .replace(/\/\*[\s\S]*?\*\//g, blank);
}

function strippingSanity(raw, stripped) {
  const problems = [];
  if (raw.length > 1000 && stripped.length < raw.length * 0.4) {
    problems.push(`comment-stripping removed ${Math.round((1 - stripped.length / raw.length) * 100)}% of the source — a stray comment delimiter has swallowed real code`);
  }
  return problems;
}

const lineOf = (src, idx) => src.slice(0, idx).split('\n').length;

// A JSON-RPC error construction: `error: {` followed by `code:` within the same object literal
// opening (≤80 chars, so single- AND multi-line shapes both match, but a `code:` belonging to a
// later statement does not). Matches the plain-literal shape AND `Response.json(...)` bodies.
const CONSTRUCTION_RE = /error:\s*\{[\s\S]{0,80}?\bcode:\s*/g;
const HELPER_CALL_RE = /mcpJsonRpcErrorResponse\s*\(/g;
const REGISTRY_CALL_RE = /\bprotocolError(?:Response|Body)\(\s*'([a-zA-Z0-9_.]+)'/g;
const DATA_REASON_RE = /data:\s*\{[^\n}]*reason:\s*['"]([a-zA-Z0-9_.-]+)['"]/g;
const TOOL_BLOBS_RE = /^.*blobs:\s*\[[^\n]*'ok' : 'error'[^\n]*$/gm;
const INIT_BLOBS_RE = /^.*blobs:\s*\[[^\n]*'initialize'[^\n]*$/gm;

// Audit the REGISTRY MODULE's own source (pure — the selftest feeds it mutants).
export function auditErrorsModule(src) {
  const violations = [];
  // Additivity (spec §4.1): the protocol builder must still emit the additive error.request_id
  // member. (The TOOL-layer builder stays in worker.mjs — gate-hash-ssot pins its
  // `reason: 'ijson_violation'` literal THERE — so the tool half of this rule is a tree rule
  // in auditSource.)
  {
    const i = src.indexOf('export function protocolErrorBody');
    const body = i >= 0 ? src.slice(i) : '';
    if (!/request_id/.test(body)) {
      violations.push({ id: 'request_id-envelope-missing', why: `${REGISTRY_FILE}:protocolErrorBody must still emit the additive error.request_id member (spec §3)` });
    }
  }
  // Frozen codes must still be minted by the registry at all.
  for (const code of FROZEN_CODES) {
    if (!src.includes(code)) violations.push({ id: 'registry-frozen-code-missing', why: `${REGISTRY_FILE} no longer mints ${code} — the registry is the ONLY allowed mint site, so its disappearance is drift, not cleanup` });
  }
  // Frozen message anchors (what the post-deploy smoke and gate-hash-ijson assert). Quote-agnostic:
  // entries render templates as backtick literals, plain strings as single-quoted ones.
  for (const [needle, why] of [
    [/['"`]Tool not found: /, 'the -32602 tool-not-found texts must keep their `Tool not found:` prefix'],
    [/['"`]Header mismatch: /, 'the -32020 text must keep its `Header mismatch:` prefix (renumber history is permanent)'],
    [/['"`]Server timeout['"`]/, 'the -32001 watchdog text is frozen'],
    [/['"`]Internal error['"`]/, 'the -32603 text is frozen (detail goes to console.error only)'],
    [/['"`]Rate limit exceeded\. Wait and retry\.['"`]/, 'the -32029 limiter text is frozen (smoke-mcp trips it)'],
    [/['"`]ijson_violation['"`]/, 'error.data.reason must stay the string "ijson_violation" (gate-hash-ijson asserts it)'],
  ]) {
    if (!needle.test(src)) violations.push({ id: 'registry-message-drift', why: `${REGISTRY_FILE} lost ${needle}: ${why}` });
  }
  return violations;
}

// The whole rule set over the scanned tree, as one pure function — the selftest mutation-tests
// EXACTLY this (SO #34), never a re-typed imitation.
// sources: { 'worker.mjs': src, 'server.mjs': src }; baseline: parsed error-registry.baseline.json.
export function auditSource(sources, { baseline = [] } = {}) {
  const violations = [];
  const baselineKeys = new Set(baseline.map((b) => `${b.file}:${b.line}:${b.code}`));

  for (const [file, raw] of Object.entries(sources)) {
    const code = stripComments(raw);
    for (const p of strippingSanity(raw, code)) {
      violations.push({ file, line: 0, id: 'comment-stripping-damaged-source', why: p });
    }

    // 1. Construction-site rule: every inline JSON-RPC error shape must be baseline-covered.
    for (const m of code.matchAll(CONSTRUCTION_RE)) {
      const line = lineOf(code, m.index);
      const window = code.slice(m.index, m.index + 160);
      const codeMatch = /code:\s*(-?\d+)/.exec(window);
      const wire = codeMatch ? Number(codeMatch[1]) : null;
      // A construction whose value comes straight from the errors.mjs TOOL registry (the
      // worker-resident ijsonErrorResult builder) IS registry construction (spec §2.2).
      const registryBuilt = /TOOL_ERRORS\[\s*['"]tool\./.test(window);
      if (!registryBuilt && !baselineKeys.has(`${file}:${line}:${wire}`)) {
        violations.push({
          file, line, id: 'unregistered-construction',
          why: `inline JSON-RPC error construction (code ${wire ?? '?'}) is neither built by an errors.mjs constructor nor absorbed by scripts/error-registry.baseline.json — route it through errors.mjs protocolErrorResponse()/buildIjsonErrorResult()`,
        });
      }
    }
    // ...and the deleted hand-rolled helper must not come back.
    for (const m of code.matchAll(HELPER_CALL_RE)) {
      violations.push({
        file, line: lineOf(code, m.index), id: 'unregistered-construction',
        why: 'mcpJsonRpcErrorResponse() was deleted in favour of the errors.mjs constructors — a reintroduction is a construction site outside the registry',
      });
    }

    // 2. Registered-name rule: constructors may only be called with names the registry exports.
    for (const m of code.matchAll(REGISTRY_CALL_RE)) {
      if (!(m[1] in REGISTRY_NAMES)) {
        violations.push({
          file, line: lineOf(code, m.index), id: 'unregistered-name',
          why: `protocolError*('${m[1]}') is not a PROTOCOL_ERRORS key in ${REGISTRY_FILE} — a typo here throws at request time`,
        });
      }
    }

    // 3. Conflation rule: frozen codes are minted only inside errors.mjs.
    for (const c of FROZEN_CODES) {
      let idx = code.indexOf(c);
      while (idx >= 0) {
        violations.push({
          file, line: lineOf(code, idx), id: 'frozen-code-outside-registry',
          why: `${c} may be minted only by ${REGISTRY_FILE} (spec §2.3: throttle is never conflated; -32001 is watchdog-only; -32020 is the #2907 renumber)`,
        });
        idx = code.indexOf(c, idx + 1);
      }
    }

    // 4. data.reason literals: only 'ijson_violation' may appear inline (same-line shape;
    //    multi-line objects are the registry's job, and the registry itself pins the reason).
    for (const m of code.matchAll(DATA_REASON_RE)) {
      if (m[1] !== 'ijson_violation') {
        violations.push({
          file, line: lineOf(code, m.index), id: 'data-reason-literal',
          why: `error.data.reason literal '${m[1]}' — the only sanctioned inline reason is 'ijson_violation'; everything else belongs in errors.mjs`,
        });
      }
    }

    // 5. Additivity: the tool-call Analytics datum carries the request_id blob (5th);
    //    the initialize datum stays unchanged (no request_id) per spec §3.
    if (file === 'worker.mjs') {
      for (const m of code.matchAll(TOOL_BLOBS_RE)) {
        if (!/requestId/.test(m[0])) {
          violations.push({ file, line: lineOf(code, m.index), id: 'request_id-analytics-blob-missing', why: 'the tools/call Analytics datum must append the request_id blob (spec §3: 4 blobs → 5)' });
        }
      }
      for (const m of code.matchAll(INIT_BLOBS_RE)) {
        if (/requestId/.test(m[0])) {
          violations.push({ file, line: lineOf(code, m.index), id: 'initialize-datum-changed', why: 'the initialize Analytics datum must stay unchanged (spec §3) — no request_id blob there' });
        }
      }
      // Tool-layer additivity: the worker-resident ijsonErrorResult builder must still add the
      // additive structuredContent.error.request_id member (spec §3: structuredContent ONLY —
      // content[].text serializes the pre-envelope shape and stays byte-identical).
      if (!/request_id:\s*requestId/.test(code)) {
        violations.push({ file, line: lineOf(code, Math.max(0, code.indexOf('function ijsonErrorResult'))), id: 'request_id-envelope-missing', why: 'worker.mjs ijsonErrorResult must add the additive structuredContent.error.request_id member (spec §3)' });
      }
    }
  }

  // 6. Baseline anchor rule: every baseline entry must still describe the live line.
  for (const b of baseline) {
    const src = sources[b.file];
    if (src === undefined) {
      violations.push({ file: b.file, line: b.line, id: 'stale-baseline-anchor', why: `baseline references ${b.file} which the gate does not scan` });
      continue;
    }
    const lineText = (src.split('\n')[b.line - 1] ?? '');
    if (!new RegExp(`code:\\s*${b.code}\\b`).test(lineText)) {
      violations.push({ file: b.file, line: b.line, id: 'stale-baseline-anchor', why: `baseline says ${b.file}:${b.line} carries code ${b.code}, but the line no longer matches — the site moved or changed, so re-baseline honestly (shrink-only, never grow)` });
    }
  }

  return violations;
}

// Filled at module load from the real registry (single source of truth — never re-typed here).
let REGISTRY_NAMES = null;
export function setRegistryNames(names) { REGISTRY_NAMES = names; }

async function loadRegistryNames() {
  const mod = await import(pathToFileURL(resolve(ROOT, REGISTRY_FILE)).href);
  setRegistryNames(mod.PROTOCOL_ERRORS);
}

async function main() {
  await loadRegistryNames();
  const baseline = JSON.parse(readFileSync(BASELINE_FILE, 'utf8')).sites;
  const sources = Object.fromEntries(TARGETS.map((f) => [f, readFileSync(resolve(ROOT, f), 'utf8')]));
  const errorsSrc = readFileSync(resolve(ROOT, REGISTRY_FILE), 'utf8');

  const violations = [
    ...auditErrorsModule(errorsSrc),
    ...auditSource(sources, { baseline }),
  ];

  // Code-level cross-check: the SOURCE of errors.mjs says the frozen codes; the MODULE must agree
  // (guards a literal trapped in a comment while the real entry moved).
  const mod = await import(pathToFileURL(resolve(ROOT, REGISTRY_FILE)).href);
  for (const [name, want] of [['protocol.rate_limited', -32029], ['protocol.server_timeout', -32001], ['protocol.header_mismatch', -32020]]) {
    const entry = mod.PROTOCOL_ERRORS[name];
    if (!entry || entry.code !== want) {
      violations.push({ file: REGISTRY_FILE, line: 0, id: 'registry-code-drift', why: `PROTOCOL_ERRORS['${name}'].code must stay ${want} (frozen wire value)` });
    }
  }
  const ijson = mod.TOOL_ERRORS?.['tool.ijson_violation'];
  if (!ijson || ijson.code !== -32602 || ijson.reason !== 'ijson_violation') {
    violations.push({ file: REGISTRY_FILE, line: 0, id: 'registry-code-drift', why: "TOOL_ERRORS['tool.ijson_violation'] must stay code -32602 + reason 'ijson_violation' (gate-hash-ijson asserts both)" });
  }

  if (violations.length) {
    console.error(`✗ gate-error-registry: ${violations.length} violation(s) — the error registry is not the single construction site:`);
    for (const v of violations) {
      console.error(`    ${v.file ?? '?'}:${v.line ?? '?'} [${v.id}] ${v.why}`);
    }
    console.error('');
    console.error('  Route the site through errors.mjs (protocolErrorResponse / protocolErrorBody /');
    console.error('  buildIjsonErrorResult) with a registered stable name, or — only for the frozen');
    console.error('  dev-server sites — keep it covered by scripts/error-registry.baseline.json.');
    console.error('  The baseline shrinks as sites migrate; it never grows.');
    process.exit(1);
  }
  console.log(`✅ gate-error-registry: worker.mjs + server.mjs hold no unregistered JSON-RPC error construction; frozen codes (-32029/-32001/-32020) mint only in errors.mjs; request_id envelope present in protocolErrorBody, ijsonErrorResult and the tool Analytics datum; ${baseline.length} baseline anchor(s) verified.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error('✗ gate-error-registry ERROR:', err); process.exit(1); });
}
