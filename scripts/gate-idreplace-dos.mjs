#!/usr/bin/env node
// gate-idreplace-dos.mjs — worker.mjs may never splice an attacker-controlled id into the static
// SSE template with a STRING replacement. The replacement must be a FUNCTION.
//
// WHY (WORKER-IDREPLACE-DOS-1, 2026-08-29 — a live P0 on the public MCP endpoint):
// `worker.mjs` served the static tools/list frame with
//     const sse = tpl.replace(ID_PLACEHOLDER, JSON.stringify(body.id));
// `String.prototype.replace` with a STRING second argument interprets `$'`, `` $` ``, `$&` and `$$`
// in the REPLACEMENT (ECMA-262, GetSubstitution). `__OCG_ID__` sits at byte 43 of a 1,740,927-byte
// template, so an id of `"$'"` — "the portion after the match" — spliced ~1.74MB of the template
// back into itself. A ~40-byte unauthenticated request bought a 2x amplified response; batched, it
// returned a live HTTP 503 (Cloudflare Error 1102, retryable:false). A single-request DoS.
//
// The runtime regression test (scripts/test-idreplace-dos.mjs) proves the BEHAVIOUR is fixed today.
// This gate is the structural half: it fails the build if the dangerous SHAPE is ever reintroduced,
// including on a code path no fixture happens to drive. A comment asserting "this is safe" is not a
// gate — the parity comment on the hash canonicalizer was wrong for years (WORKER-HASH-SSOT-1).
//
// Zero-dep and text-only ON PURPOSE (SO #34 security rider): this gate never `require`s, imports or
// evaluates the file it is judging — a gate that executes its subject IS the vulnerability.
//
// Run:  node scripts/gate-idreplace-dos.mjs
// Prove it can fail:  node scripts/gate-idreplace-dos.selftest.mjs   (mutation-tests these rules)

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = resolve(ROOT, 'worker.mjs');

// ── FORBIDDEN: a string-valued replacement spliced into a template ────────────────────────────
// Rules match CODE, not prose — this gate's own rationale (and worker.mjs's) names the defect in
// English and must stay legal, or the gate would forbid documenting the bug it guards. Comments are
// stripped before matching, and every pattern additionally requires call syntax.
export const FORBIDDEN = [
  {
    id: 'placeholder-string-replacement',
    // `.replace(ID_PLACEHOLDER, <anything that is not a function literal>`.
    // Legal:   .replace(ID_PLACEHOLDER, () => idJson)
    //          .replace(ID_PLACEHOLDER, function () { return idJson; })
    // Illegal: .replace(ID_PLACEHOLDER, JSON.stringify(body.id))   ← the 2026-08-29 defect
    //          .replace(ID_PLACEHOLDER, idJson)
    //
    // ⚠ The `\s*` separating the comma from the lookahead lives INSIDE the lookahead on purpose.
    // Written as `,\s*(?!…)` the greedy `\s*` BACKTRACKS to zero width, the lookahead is then
    // evaluated against the space rather than the replacement, fails to find the arrow, and the
    // NEGATION therefore succeeds — flagging the legal form. That false positive is what the first
    // run of this gate's own self-test caught (clean control + 4 negative controls rejected).
    // Anchoring the lookahead directly on the fixed `,` leaves nothing to backtrack into.
    re: /\.replace(?:All)?\(\s*ID_PLACEHOLDER\s*,(?!\s*(?:(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>|function\b))/,
    why: 'the id is spliced with a STRING replacement — `$\'`, `` $` ``, `$&` and `$$` are interpreted as ' +
         'pattern tokens. Pass a replacer FUNCTION: .replace(ID_PLACEHOLDER, () => idJson)',
  },
  {
    id: 'stringify-as-replacement-arg',
    // The exact pre-fix shape, caught by name even if the placeholder constant is renamed.
    re: /\.replace(?:All)?\([^,)]*,\s*JSON\.stringify\(/,
    why: 'JSON.stringify(...) passed directly as a replacement string — its output is still scanned ' +
         'for `$` tokens. Wrap it in a replacer function, or the escape is no escape at all',
  },
  {
    id: 'raw-id-interpolated-into-template',
    // Template-literal splice of a raw id into the SSE frame sidesteps .replace entirely but
    // re-opens the same "untrusted value inside a 1.7MB document" surface unvalidated.
    re: /\btpl\s*\.\s*replace(?:All)?\(\s*ID_PLACEHOLDER\s*,\s*(?:body|request|params)\b/,
    why: 'a raw request-derived value is used as the replacement — validate and JSON-encode it first, ' +
         'and pass it through a replacer function',
  },
];

// ── REQUIRED: the three fixes are actually present ────────────────────────────────────────────
// Absence is not a pass (SO #34c): "no forbidden shape found" is also true of a worker.mjs that
// deleted the static path altogether, or that never validates an id. Assert the positive too.
export const REQUIRED = [
  {
    id: 'replacer-function',
    re: /\.replace(?:All)?\(\s*ID_PLACEHOLDER\s*,\s*(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/,
    why: 'the static id splice must use a replacer FUNCTION (no pattern interpretation)',
  },
  {
    id: 'id-type-validation',
    re: /isValidJsonRpcId\s*\(/,
    why: 'a JSON-RPC id must be validated as string|number|null before use (JSON-RPC 2.0 §4)',
  },
  {
    id: 'batch-rejection',
    re: /Array\.isArray\(\s*body\s*\)/,
    why: 'JSON-RPC batches must be rejected (P1-1: the N-amplification vector; removed from MCP in 2025-06-18)',
  },
  {
    id: 'body-size-cap',
    re: /MAX_REQUEST_BODY_BYTES/,
    why: 'the request body must be capped (P1-2)',
  },
  {
    id: 'splice-assert',
    re: /assertSingleSplice\s*\(/,
    why: 'the substituted result must be asserted — exactly one splice, inserted bytes === the intended id JSON',
  },
];

// Strip line + block comments so a rule can never fire on (or be evaded by) prose.
//
// ⚠ ORDER IS LOAD-BEARING, and getting it wrong is silent — the same trap gate-hash-ssot.mjs
// documents: worker.mjs:871 is a LINE comment quoting an Accept header, so it contains a literal
// `*/*`. Strip block comments first and that stray `/*` opens a comment that closes thousands of
// lines later, deleting most of the file — and the gate would pass on source it never read. Line
// comments go first. strippingSanity() below is the fail-closed backstop.
export function stripComments(src) {
  return src
    .replace(/^[ \t]*\/\/.*$/gm, ' ')                  // 1. whole-line comments (incl. the :871 trap)
    .replace(/([^:'"`\\])\/\/[^\n'"`]*$/gm, '$1')      // 2. trailing comments (never inside a URL/string)
    .replace(/\/\*[\s\S]*?\*\//g, ' ');                // 3. block comments, now that no stray opener remains
}

// Fail-CLOSED guard on the stripper: if comment-stripping ever eats real code, every FORBIDDEN
// pattern disappears with it and this gate reports a clean file.
export function strippingSanity(raw, stripped) {
  const problems = [];
  if (raw.includes('ID_PLACEHOLDER') && !stripped.includes('ID_PLACEHOLDER')) {
    problems.push('comment-stripping removed the ID_PLACEHOLDER code that is present in the raw source');
  }
  if (raw.length > 1000 && stripped.length < raw.length * 0.4) {
    problems.push(`comment-stripping removed ${Math.round((1 - stripped.length / raw.length) * 100)}% of the source (expected <60%) — a stray comment delimiter has swallowed real code`);
  }
  return problems;
}

// The whole rule set as one pure function over source text — so the self-test mutation-tests
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
  const violations = auditSource(readFileSync(TARGET, 'utf8'));

  if (violations.length) {
    console.error(`✗ gate-idreplace-dos: ${violations.length} violation(s) in worker.mjs — the id-splice DoS surface is open:`);
    for (const v of violations) console.error(`    [${v.kind}] ${v.id} — ${v.why}`);
    console.error('');
    console.error('  An attacker-supplied JSON-RPC id of "$\'" splices the 1.7MB tools/list template into');
    console.error('  itself (2x amplification) — the 2026-08-29 P0 that returned a live 503 on the public');
    console.error('  endpoint. The replacement passed to String.replace MUST be a function.');
    process.exit(1);
  }

  console.log(`✅ gate-idreplace-dos: worker.mjs splices the id with a replacer function; all ${REQUIRED.length} fix assertions hold (${FORBIDDEN.length} forbidden shapes checked).`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
