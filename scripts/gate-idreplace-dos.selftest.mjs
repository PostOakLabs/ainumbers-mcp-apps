#!/usr/bin/env node
// gate-idreplace-dos.selftest.mjs — proves gate-idreplace-dos.mjs can actually FAIL.
//
// SO #34c: absence is not a pass. A gate that has only ever been observed green has not been
// observed at all. So this file mutation-tests the gate: it feeds gate-idreplace-dos's OWN rule
// function (auditSource — the exact function CI runs, imported, never re-typed) a set of fixtures
// that each re-introduce the WORKER-IDREPLACE-DOS-1 defect, and fails if any is accepted.
//
// SO #34 security rider: nothing here is `require`d or evaluated. The fixtures are inert strings.
//
// Run: node scripts/gate-idreplace-dos.selftest.mjs

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { auditSource } from './gate-idreplace-dos.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// A minimal source that SATISFIES every rule — the clean control. If this is rejected the gate is
// over-strict, which is just as broken as under-strict (it would block every honest change).
const CLEAN = `
const MAX_REQUEST_BODY_BYTES = 1048576;
function isValidJsonRpcId(v) { return v === null || typeof v === 'string' || typeof v === 'number'; }
function assertSingleSplice(out, tpl, idJson) { return out.length === tpl.length - 10 + idJson.length; }
if (Array.isArray(body)) return batchRejected();
const idJson = JSON.stringify(body.id ?? null);
const sse = tpl.replace(ID_PLACEHOLDER, () => idJson);
assertSingleSplice(sse, tpl, idJson);
`;

// Each fixture re-introduces the defect a different way. `expect` names the rule id that must fire.
const MUTANTS = [
  {
    name: 'verbatim pre-fix line (the actual 2026-08-29 defect)',
    expect: 'placeholder-string-replacement',
    src: CLEAN + `\nconst sse2 = tpl.replace(ID_PLACEHOLDER, JSON.stringify(body.id));\n`,
  },
  {
    name: 'pre-computed string passed as the replacement (escaping does not help)',
    expect: 'placeholder-string-replacement',
    src: CLEAN + `\nconst sse2 = tpl.replace(ID_PLACEHOLDER, idJson);\n`,
  },
  {
    name: 'replaceAll variant of the same defect',
    expect: 'placeholder-string-replacement',
    src: CLEAN + `\nconst sse2 = tpl.replaceAll(ID_PLACEHOLDER, JSON.stringify(body.id));\n`,
  },
  {
    name: 'JSON.stringify as a replacement against a renamed placeholder constant',
    expect: 'stringify-as-replacement-arg',
    src: CLEAN + `\nconst sse2 = tpl.replace(SOME_OTHER_TOKEN, JSON.stringify(body.id));\n`,
  },
  {
    name: 'raw request-derived value used as the replacement',
    expect: 'raw-id-interpolated-into-template',
    src: CLEAN + `\nconst sse2 = tpl.replace(ID_PLACEHOLDER, body.id);\n`,
  },
  {
    name: 'replacer function removed entirely',
    expect: 'replacer-function',
    src: `
const MAX_REQUEST_BODY_BYTES = 1048576;
function isValidJsonRpcId(v) { return true; }
function assertSingleSplice(a, b, c) { return true; }
if (Array.isArray(body)) return batchRejected();
`,
  },
  {
    name: 'id type validation dropped (container id reaches the splice)',
    expect: 'id-type-validation',
    src: `
const MAX_REQUEST_BODY_BYTES = 1048576;
function assertSingleSplice(a, b, c) { return true; }
if (Array.isArray(body)) return batchRejected();
const sse = tpl.replace(ID_PLACEHOLDER, () => idJson);
`,
  },
  {
    name: 'batch rejection dropped (P1-1 regression)',
    expect: 'batch-rejection',
    src: `
const MAX_REQUEST_BODY_BYTES = 1048576;
function isValidJsonRpcId(v) { return true; }
function assertSingleSplice(a, b, c) { return true; }
const sse = tpl.replace(ID_PLACEHOLDER, () => idJson);
`,
  },
  {
    name: 'body-size cap dropped (P1-2 regression)',
    expect: 'body-size-cap',
    src: `
function isValidJsonRpcId(v) { return true; }
function assertSingleSplice(a, b, c) { return true; }
if (Array.isArray(body)) return batchRejected();
const sse = tpl.replace(ID_PLACEHOLDER, () => idJson);
`,
  },
  {
    name: 'substitution assert dropped',
    expect: 'splice-assert',
    src: `
const MAX_REQUEST_BODY_BYTES = 1048576;
function isValidJsonRpcId(v) { return true; }
if (Array.isArray(body)) return batchRejected();
const sse = tpl.replace(ID_PLACEHOLDER, () => idJson);
`,
  },
  {
    // The instrument bug gate-hash-ssot.mjs shipped with, kept here as a permanent regression test
    // because this gate reuses the same stripper. worker.mjs:871 is a LINE comment quoting an Accept
    // header, so it contains a literal `*/*`. Stripping block comments BEFORE line comments treats
    // that stray `/*` as an opener and deletes everything to the next `*/` — and the gate would then
    // pass on a file it never read. The defect below the stray delimiter must still be caught.
    name: 'stray `*/*` inside a line comment must not blind the gate (worker.mjs:871 shape)',
    expect: 'placeholder-string-replacement',
    src: CLEAN + `
// Accept header, or one that doesn't mention text/event-stream at all (bare \`*/*\`, or no header
const sse2 = tpl.replace(ID_PLACEHOLDER, JSON.stringify(body.id));
const y = 1; /* a later block comment whose closer the stray opener would otherwise have consumed */
`,
  },
  {
    name: 'named-function replacer is legal (not only arrows)',
    expect: null, // negative control
    src: CLEAN + `\nconst sse2 = tpl.replace(ID_PLACEHOLDER, function () { return idJson; });\n`,
  },
  {
    name: 'single-param arrow replacer is legal',
    expect: null, // negative control
    src: CLEAN + `\nconst sse2 = tpl.replace(ID_PLACEHOLDER, m => idJson);\n`,
  },
  {
    name: 'defect described in a block comment must NOT red the gate (comment-only)',
    expect: null, // negative control: prose about the defect stays legal
    src: CLEAN + `\n/* history: this used to be tpl.replace(ID_PLACEHOLDER, JSON.stringify(body.id)). */\n`,
  },
  {
    name: 'defect described in a line comment must NOT red the gate (comment-only)',
    expect: null, // negative control
    src: CLEAN + `\n// WORKER-IDREPLACE-DOS-1 replaced tpl.replace(ID_PLACEHOLDER, JSON.stringify(body.id)).\n`,
  },
  {
    name: 'an unrelated .replace with a string replacement stays legal',
    expect: null, // negative control: the gate is scoped to the id splice, not every replace call
    src: CLEAN + `\nconst h = header.replace('a', 'b');\nconst p = file.replace('.sse.txt', '.' + toolset + '.sse.txt');\n`,
  },
];

function main() {
  let fail = 0;
  const rows = [];

  // 1. The clean control must be ACCEPTED.
  const cleanViolations = auditSource(CLEAN);
  if (cleanViolations.length) {
    fail++;
    rows.push({ ok: false, name: 'clean control accepted', note: 'rejected with: ' + cleanViolations.map((v) => v.id).join(', ') });
  } else {
    rows.push({ ok: true, name: 'clean control accepted', note: 'no violations' });
  }

  // 2. Every mutant must be REJECTED, by the specific rule it was built to trip.
  for (const m of MUTANTS) {
    const ids = auditSource(m.src).map((v) => v.id);
    if (m.expect === null) {
      const ok = ids.length === 0;
      if (!ok) fail++;
      rows.push({ ok, name: m.name, note: ok ? 'correctly accepted' : 'FALSE POSITIVE: ' + ids.join(', ') });
      continue;
    }
    const ok = ids.includes(m.expect);
    if (!ok) fail++;
    rows.push({ ok, name: m.name, note: ok ? `rejected by ${m.expect}` : `NOT rejected by ${m.expect} (got: ${ids.join(', ') || 'nothing'})` });
  }

  // 3. The real worker.mjs must be clean — same rules, live target. Reported here too so a single
  //    run shows both "the gate can fail" and "the tree passes it".
  const live = auditSource(readFileSync(resolve(ROOT, 'worker.mjs'), 'utf8'));
  if (live.length) { fail++; rows.push({ ok: false, name: 'live worker.mjs clean', note: live.map((v) => v.id).join(', ') }); }
  else rows.push({ ok: true, name: 'live worker.mjs clean', note: 'no violations' });

  console.log('\n════ gate-idreplace-dos selftest (mutation) ════');
  for (const r of rows) console.log(`  ${r.ok ? '✓' : '✗'} ${r.name} — ${r.note}`);
  console.log('');

  if (fail) {
    console.error(`✗ gate-idreplace-dos.selftest: ${fail} case(s) failed — the gate does not reliably distinguish a string-replacement splice from a safe one, so its green means nothing.`);
    process.exit(1);
  }
  console.log(`✅ gate-idreplace-dos.selftest: ${MUTANTS.length} mutants classified correctly + clean control accepted + live worker.mjs clean. The gate is load-bearing.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
