#!/usr/bin/env node
// gate-hash-ssot.mjs — worker.mjs may hold NO second implementation of the OCG execution-hash
// canonicalizer. There is exactly ONE, ./kernels/_hash.mjs, and worker.mjs must import it.
//
// WHY (WORKER-HASH-SSOT-1, 2026-08-29 — a live P0 on the public MCP endpoint):
// worker.mjs carried a LOCAL `cgCanon` + `cgExecutionHash` pair, commented "PARITY: byte-identical
// to repo/chaingraph/kernels/_hash.mjs". It was not. It dropped the SSOT's assertIJson() guard, so
// values outside I-JSON silently produced a digest instead of an error: {n: 2**53} and
// {n: 2**53 + 1} returned the SAME execution_hash from verify_execution_hash. Two different
// artifacts, one receipt, unauthenticated and deterministic, on the tool whose entire claim is
// "a match proves these inputs deterministically produce these outputs".
//
// The parity copy existed for years BECAUSE a comment asserting parity is not a gate. This file is
// the gate: a re-introduced local copy fails the build instead of quietly re-opening the collision.
//
// Zero-dep and text-only ON PURPOSE (SO #34 security rider): this gate never `require`s, imports or
// evaluates the file it is judging — a gate that executes its subject is the vulnerability.
//
// Run:  node scripts/gate-hash-ssot.mjs
// Prove it can fail:  node scripts/gate-hash-ssot.selftest.mjs   (mutation-tests these same rules)

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = resolve(ROOT, 'worker.mjs');

// The SSOT module worker.mjs must import its canonicalizer + hasher from.
export const SSOT_SPECIFIER = './kernels/_hash.mjs';

// ── FORBIDDEN: a second implementation living in worker.mjs ────────────────────────────────────
// Each rule matches CODE, not prose — the deleted copy's own explanatory comment (and this gate's
// rationale, quoted into worker.mjs) name `cgExecutionHash` in English and must stay legal, or the
// gate would forbid documenting the very defect it guards. So every pattern requires syntax a
// comment does not have: a declaration keyword, or a call/definition parenthesis.
export const FORBIDDEN = [
  {
    id: 'local-cgExecutionHash-decl',
    // `function cgExecutionHash(`, `async function cgExecutionHash(`, `const cgExecutionHash =`
    re: /(?:\b(?:const|let|var)\s+cgExecutionHash\s*=|\bfunction\s+cgExecutionHash\s*\()/,
    why: 'a local execution-hash implementation — import executionHash from ' + SSOT_SPECIFIER + ' instead',
  },
  {
    id: 'local-cgExecutionHash-call',
    // Any surviving CALL site: `cgExecutionHash(` / `await cgExecutionHash(`, but never `.cgExecutionHash(`.
    re: /(?<![\w.])cgExecutionHash\s*\(/,
    why: 'a call to a local cgExecutionHash — route the call site through the SSOT executionHash()',
  },
  {
    id: 'local-cgCanon-decl',
    // A local BINDING named cgCanon. The legal import renames it (`cgCanon as sharedCgCanon`), so
    // it never produces a declaration keyword immediately before a bare `cgCanon`.
    re: /(?:\b(?:const|let|var)\s+cgCanon\s*=|\bfunction\s+cgCanon\s*\()/,
    why: 'a local canonicalizer — import cgCanon (as sharedCgCanon) from ' + SSOT_SPECIFIER + ' instead',
  },
  {
    id: 'local-assertIJson-decl',
    // Re-declaring the I-JSON rule locally is the same defect one level down: the copy drifts, and
    // the drift is invisible because both are named the same thing.
    re: /(?:\b(?:const|let|var)\s+assertIJson\s*=|\bfunction\s+assertIJson\s*\()/,
    why: 'a local I-JSON assertion — import assertIJson from ' + SSOT_SPECIFIER + ' instead',
  },
];

// ── REQUIRED: worker.mjs actually imports the SSOT it is supposed to use ──────────────────────
// Absence is not a pass (SO #34c): "no forbidden copy found" is also true of a worker.mjs that
// hashes nothing at all, or that imports a DIFFERENT module. Assert the positive too.
export const REQUIRED = [
  { id: 'imports-ssot-hash', re: /import\s*\{[^}]*\}\s*from\s*'\.\/kernels\/_hash\.mjs'/, why: "worker.mjs must import from '" + SSOT_SPECIFIER + "'" },
  { id: 'imports-executionHash', re: /\bexecutionHash\s+as\s+\w+/, why: 'worker.mjs must import the SSOT executionHash()' },
  { id: 'imports-assertIJson', re: /\{[^}]*\bassertIJson\b[^}]*\}\s*from\s*'\.\/kernels\/_hash\.mjs'/, why: 'worker.mjs must import the SSOT assertIJson()' },
  { id: 'ijson-structured-error', re: /reason:\s*'ijson_violation'/, why: 'a non-I-JSON input must return a structured error carrying reason "ijson_violation", never a hash' },
];

// Strip line + block comments so a rule can never fire on (or be evaded by) prose. Crude but
// sufficient here and deliberately not a JS parser: worker.mjs is machine-checked for syntax by the
// wrangler bundle dry-run in the same CI job, so this file's only job is pattern presence/absence.
//
// ⚠ ORDER IS LOAD-BEARING, and getting it wrong is silent. worker.mjs:871 is a LINE comment that
// contains the literal `*/*` (it quotes an Accept header). Strip block comments first and that stray
// `/*` opens a comment that closes ~3,800 lines later at the next `*/`, deleting most of the file —
// which would make this gate green on a worker.mjs it never actually read. Line comments go first,
// which removes the stray opener along with the line carrying it. The sanity check in auditSource()
// is the backstop that turns any recurrence of that class into a RED rather than a false pass.
export function stripComments(src) {
  return src
    .replace(/^[ \t]*\/\/.*$/gm, ' ')                  // 1. whole-line comments (incl. the :871 trap)
    .replace(/([^:'"`\\])\/\/[^\n'"`]*$/gm, '$1')      // 2. trailing comments (never inside a URL/string)
    .replace(/\/\*[\s\S]*?\*\//g, ' ');                // 3. block comments, now that no stray opener remains
}

// Fail-CLOSED guard on the stripper itself: if comment-stripping ever eats real code, every
// FORBIDDEN pattern disappears with it and this gate would report a clean file. So assert the
// stripped text still looks like worker.mjs before trusting any verdict drawn from it.
export function strippingSanity(raw, stripped) {
  const problems = [];
  if (raw.includes(SSOT_SPECIFIER) && !stripped.includes(SSOT_SPECIFIER)) {
    problems.push(`comment-stripping removed the ${SSOT_SPECIFIER} import that is present in the raw source`);
  }
  if (raw.length > 1000 && stripped.length < raw.length * 0.4) {
    problems.push(`comment-stripping removed ${Math.round((1 - stripped.length / raw.length) * 100)}% of the source (expected <60%) — a stray comment delimiter has swallowed real code`);
  }
  return problems;
}

// The whole rule set, as one pure function over source text — so the self-test can mutation-test
// EXACTLY the rules CI runs, not a re-typed imitation of them (SO #34: verify by mutation).
export function auditSource(src) {
  const code = stripComments(src);
  const violations = [];
  for (const p of strippingSanity(src, code)) violations.push({ kind: 'instrument', id: 'comment-stripping-damaged-source', why: p });
  for (const rule of FORBIDDEN) if (rule.re.test(code)) violations.push({ kind: 'forbidden', id: rule.id, why: rule.why });
  for (const rule of REQUIRED) if (!rule.re.test(code)) violations.push({ kind: 'missing', id: rule.id, why: rule.why });
  return violations;
}

function main() {
  const src = readFileSync(TARGET, 'utf8');
  const violations = auditSource(src);

  if (violations.length) {
    console.error(`✗ gate-hash-ssot: ${violations.length} violation(s) in worker.mjs — the execution-hash SSOT has been forked:`);
    for (const v of violations) {
      console.error(`    [${v.kind}] ${v.id} — ${v.why}`);
    }
    console.error('');
    console.error('  The execution_hash canonicalizer has exactly ONE implementation: kernels/_hash.mjs.');
    console.error('  A second copy in worker.mjs is what produced the 2026-08-29 digest collision');
    console.error('  ({n: 2**53} and {n: 2**53 + 1} sharing one execution_hash on the live endpoint).');
    process.exit(1);
  }

  console.log(`✅ gate-hash-ssot: worker.mjs holds no second execution-hash implementation; all ${REQUIRED.length} SSOT-import assertions hold (${FORBIDDEN.length} forbidden patterns checked).`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
