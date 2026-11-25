// hash-sweep-classify.test.mjs — HASH-SWEEP-REFUSAL-CODE-1 controls.
// Zero-dep, offline. The art-809 case is the exact text from master's post-deploy
// hash-sweep on 2026-11-25 (run 45683212304).
import { classifyToolError } from './hash-sweep-classify.mjs';

let fail = 0;
const ok = (c, m) => { if (!c) { fail++; console.error('  ✗ ' + m); } else console.log('  ✓ ' + m); };
const t = (text, fixture, want, why) => ok(classifyToolError(text, fixture) === want, `${why}: ${JSON.stringify(text)} fixture=${fixture} -> ${want}`);

console.log('HASH-SWEEP-REFUSAL-CODE-1 — sweep error classification\n');

// The regression: a bare refusal code on empty inputs.
t('Kernel compute error: UNIT', false, 'needs-input', 'bare refusal code (art-809)');
t('Kernel compute error: REFUSED_BAD_BASE_SALARY: base_salary must be a finite number', false, 'needs-input', 'code with detail');
t('OUTSTANDING_SHAPE', false, 'needs-input', 'code with no prefix');

// Unchanged: English needs-input phrasing.
t('Kernel compute error: amount is required', false, 'needs-input', 'English phrasing');

// Still failures.
t('Kernel compute error: UNIT', true, 'fail', 'a fixture-backed call fails on any error');
t('Kernel compute error: Cannot read properties of null (reading x)', false, 'fail', 'a crash is not a refusal');
t('Kernel compute error: TypeError: x is not a function', false, 'fail', 'a JS exception name is not a refusal');
t('Kernel compute error: oops', false, 'fail', 'lower-case text is not a code');
t('', false, 'fail', 'empty error text');

if (fail) { console.error(`\n✗ ${fail} assertion(s) failed`); process.exit(1); }
console.log('\n✅ hash-sweep classification: refusal codes on empty inputs are needs-input; crashes and fixture-backed errors still fail');
