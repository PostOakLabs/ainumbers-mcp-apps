#!/usr/bin/env node
// gate-hash-ssot.selftest.mjs — proves gate-hash-ssot.mjs can actually FAIL.
//
// SO #34c: absence is not a pass. A gate that has only ever been observed green has not been
// observed at all. So this file mutation-tests the gate: it feeds gate-hash-ssot's OWN rule
// function (auditSource — the exact function CI runs, imported, never re-typed) a set of fixtures
// that each re-introduce the WORKER-HASH-SSOT-1 defect, and fails if any of them is accepted.
//
// SO #34 security rider: nothing here is `require`d or evaluated. The fixtures are inert strings.
//
// Run: node scripts/gate-hash-ssot.selftest.mjs

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { auditSource } from './gate-hash-ssot.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// A minimal source that SATISFIES every rule — the clean control. If this is rejected the gate is
// over-strict, which is just as broken as under-strict (it would block every honest change).
const CLEAN = `
import { cgCanon as sharedCgCanon, assertIJson, executionHash as sharedExecutionHash } from './kernels/_hash.mjs';
function ijsonErrorResult(detail, where) {
  return { isError: true, structuredContent: { error: { code: -32602, data: { reason: 'ijson_violation', where, detail } } } };
}
const h = await sharedExecutionHash(pp, op);
const c = JSON.stringify(sharedCgCanon(v));
`;

// Each fixture re-introduces the defect a different way. `expect` names the rule id that must fire.
const MUTANTS = [
  {
    name: 'verbatim pre-fix copy (the actual 2026-08-29 defect)',
    expect: 'local-cgExecutionHash-decl',
    src: CLEAN + `
  const cgCanon = (v) => Array.isArray(v) ? v.map(cgCanon)
    : (v && typeof v === 'object')
      ? Object.keys(v).sort().reduce((o, k) => (o[k] = cgCanon(v[k]), o), {})
      : v;
  async function cgExecutionHash(policy_parameters, output_payload) {
    const preimage = JSON.stringify(cgCanon({ policy_parameters, output_payload }));
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(preimage));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
`,
  },
  {
    name: 'local hasher as an arrow const (declaration keyword, not `function`)',
    expect: 'local-cgExecutionHash-decl',
    src: CLEAN + `\nconst cgExecutionHash = async (pp, op) => sha256(JSON.stringify({ pp, op }));\n`,
  },
  {
    name: 'a surviving call site to a local hasher',
    expect: 'local-cgExecutionHash-call',
    src: CLEAN + `\nconst recomputed = await cgExecutionHash(artifact.policy_parameters, artifact.output_payload);\n`,
  },
  {
    name: 'a local canonicalizer only (the half that silently drops assertIJson)',
    expect: 'local-cgCanon-decl',
    src: CLEAN + `\nconst cgCanon = (v) => (v && typeof v === 'object') ? Object.keys(v).sort() : v;\n`,
  },
  {
    name: 'a re-declared I-JSON rule (the drift one level down)',
    expect: 'local-assertIJson-decl',
    src: CLEAN + `\nfunction assertIJson(v) { return true; }\n`,
  },
  {
    name: 'SSOT import dropped entirely',
    expect: 'imports-ssot-hash',
    src: `\nconst h = await sharedExecutionHash(pp, op);\nconst x = { reason: 'ijson_violation' };\n`,
  },
  {
    name: 'imports the SSOT but not its executionHash',
    expect: 'imports-executionHash',
    src: `
import { cgCanon as sharedCgCanon, assertIJson } from './kernels/_hash.mjs';
const x = { reason: 'ijson_violation' };
`,
  },
  {
    name: 'imports the SSOT but not assertIJson (the exact 2026-08-29 omission)',
    expect: 'imports-assertIJson',
    src: `
import { cgCanon as sharedCgCanon, executionHash as sharedExecutionHash } from './kernels/_hash.mjs';
const x = { reason: 'ijson_violation' };
`,
  },
  {
    name: 'non-I-JSON input answered without the structured error',
    expect: 'ijson-structured-error',
    src: `
import { cgCanon as sharedCgCanon, assertIJson, executionHash as sharedExecutionHash } from './kernels/_hash.mjs';
const h = await sharedExecutionHash(pp, op);
`,
  },
  {
    // The instrument bug this gate shipped with, kept as a permanent regression test. worker.mjs:871
    // is a LINE comment quoting an Accept header, so it contains a literal `*/*`. Stripping block
    // comments BEFORE line comments treats that stray `/*` as an opener and deletes everything up to
    // the next `*/` — thousands of lines, including any re-introduced local hasher. The gate would
    // then pass on a file it never read. This fixture reproduces that exact shape and requires the
    // defect below the stray delimiter to still be caught.
    name: 'stray `*/*` inside a line comment must not blind the gate (worker.mjs:871 shape)',
    expect: 'local-cgExecutionHash-decl',
    src: `
import { cgCanon as sharedCgCanon, assertIJson, executionHash as sharedExecutionHash } from './kernels/_hash.mjs';
// Accept header, or one that doesn't mention text/event-stream at all (bare \`*/*\`, or no header
const x = { reason: 'ijson_violation' };
async function cgExecutionHash(pp, op) { return sha256(pp, op); }
const y = 1; /* a later block comment whose closer the stray opener would otherwise have consumed */
`,
  },
  {
    name: 'defect hidden inside a block comment must NOT be enough to red the gate (comment-only)',
    expect: null, // negative control: prose about the defect stays legal
    src: CLEAN + `\n/* history: worker.mjs used to define cgExecutionHash() and a local cgCanon() here. */\n`,
  },
  {
    name: 'defect described in a line comment must NOT red the gate (comment-only)',
    expect: null, // negative control
    src: CLEAN + `\n// WORKER-HASH-SSOT-1 deleted the local cgCanon / cgExecutionHash parity copy.\n`,
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
    const violations = auditSource(m.src);
    const ids = violations.map((v) => v.id);
    if (m.expect === null) {
      const ok = violations.length === 0;
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

  console.log('\n════ gate-hash-ssot selftest (mutation) ════');
  for (const r of rows) console.log(`  ${r.ok ? '✓' : '✗'} ${r.name} — ${r.note}`);
  console.log('');

  if (fail) {
    console.error(`✗ gate-hash-ssot.selftest: ${fail} case(s) failed — the gate does not reliably distinguish a forked hash implementation from a clean one, so its green means nothing.`);
    process.exit(1);
  }
  console.log(`✅ gate-hash-ssot.selftest: ${MUTANTS.length} mutants classified correctly + clean control accepted + live worker.mjs clean. The gate is load-bearing.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
