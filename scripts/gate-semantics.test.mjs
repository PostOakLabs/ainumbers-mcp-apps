#!/usr/bin/env node
// gate-semantics.test.mjs — OCG v0.8 gate 2 (pinned decision-gate vector suite).
//
// Proves the shared evaluator (kernels/_gateval.mjs) is deterministic, strictly
// typed (no coercion), first-match, total (mandatory default), and that a
// recorded decision is recomputable + tamper-evident. Covers every op × type,
// type mismatches, first-match precedence, default fall-through, and pointer
// (RFC 6901) resolution. Pure — no surfaces, no network.
//
// Run: node scripts/gate-semantics.test.mjs   (exit 0 = all green)

import {
  evaluateGate, applyOp, rfc6901, isPointerSyntaxValid, isValidOp,
  GATE_OPS, VALUE_OPS, stepId,
} from '../kernels/_gateval.mjs';

let fail = 0;
const eq = (label, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { /* pass */ } else { fail++; console.error(`✗ ${label}\n    got:  ${g}\n    want: ${w}`); }
};
const ok = (label, cond) => { if (!cond) { fail++; console.error(`✗ ${label}`); } };

// --- op enum is exactly the closed set -------------------------------------
eq('GATE_OPS closed enum', [...GATE_OPS].sort(), ['absent','eq','gt','gte','in','lt','lte','neq','present'].sort());
ok('isValidOp rejects unknown', !isValidOp('regex') && !isValidOp('') && isValidOp('eq'));

// --- applyOp: every op × representative operands ---------------------------
// eq / neq (strict, structural)
ok('eq number', applyOp('eq', true, 5, 5) === true);
ok('eq no-coerce "5"!=5', applyOp('eq', true, '5', 5) === false);
ok('eq bool', applyOp('eq', true, false, false) === true);
ok('eq null', applyOp('eq', true, null, null) === true);
ok('eq array structural', applyOp('eq', true, [1,2], [1,2]) === true);
ok('eq object structural (key order irrelevant)', applyOp('eq', true, {a:1,b:2}, {b:2,a:1}) === true);
ok('eq object differs', applyOp('eq', true, {a:1}, {a:2}) === false);
ok('neq present+different', applyOp('neq', true, 'A', 'B') === true);
ok('neq present+equal', applyOp('neq', true, 'A', 'A') === false);
ok('neq absent => false (use absent op)', applyOp('neq', false, undefined, 'B') === false);

// numeric comparators — finite-only, strict type
ok('gt', applyOp('gt', true, 7, 6.5) === true);
ok('gt equal not >', applyOp('gt', true, 6.5, 6.5) === false);
ok('gte equal', applyOp('gte', true, 6.5, 6.5) === true);
ok('lt', applyOp('lt', true, 1, 2) === true);
ok('lte', applyOp('lte', true, 2, 2) === true);
ok('gt string operand => false (no coerce)', applyOp('gt', true, '7', 6.5) === false);
ok('gt non-finite observed => false', applyOp('gt', true, Infinity, 6.5) === false);
ok('gt NaN => false', applyOp('gt', true, NaN, 6.5) === false);
ok('gt absent => false', applyOp('gt', false, undefined, 6.5) === false);

// in — membership in a literal array (structural)
ok('in match', applyOp('in', true, 'B', ['A','B','C']) === true);
ok('in miss', applyOp('in', true, 'Z', ['A','B']) === false);
ok('in structural object', applyOp('in', true, {x:1}, [{x:1},{x:2}]) === true);
ok('in non-array value => false', applyOp('in', true, 'A', 'A') === false);
ok('in no-coerce', applyOp('in', true, 1, ['1','2']) === false);

// present / absent — existence only
ok('present found', applyOp('present', true, 0, undefined) === true);
ok('present of null value (key exists)', applyOp('present', true, null, undefined) === true);
ok('present not found', applyOp('present', false, undefined, undefined) === false);
ok('absent not found', applyOp('absent', false, undefined, undefined) === true);
ok('absent found', applyOp('absent', true, 5, undefined) === false);

// --- RFC 6901 pointer resolution -------------------------------------------
const doc = { verdict: 'FAIL', spread: 7.25, flags: ['a','b'], nested: { ok: true, val: null }, 'a/b': 1, 'm~n': 2 };
eq('ptr root', rfc6901(doc, ''), { found: true, value: doc });
eq('ptr /verdict', rfc6901(doc, '/verdict'), { found: true, value: 'FAIL' });
eq('ptr /flags/1', rfc6901(doc, '/flags/1'), { found: true, value: 'b' });
eq('ptr /flags/9 out of range', rfc6901(doc, '/flags/9').found, false);
eq('ptr /nested/val is null (found)', rfc6901(doc, '/nested/val'), { found: true, value: null });
eq('ptr ~1 escapes /', rfc6901(doc, '/a~1b'), { found: true, value: 1 });
eq('ptr ~0 escapes ~', rfc6901(doc, '/m~0n'), { found: true, value: 2 });
eq('ptr missing key', rfc6901(doc, '/nope').found, false);
ok('bad pointer syntax', !isPointerSyntaxValid('verdict') && !isPointerSyntaxValid('/a~2') && isPointerSyntaxValid('') && isPointerSyntaxValid('/a~0'));

// --- evaluateGate: first-match + default (total function) ------------------
const spreadGate = { input: '/spread', rules: [
  { op: 'gte', value: 6.5, next: 'hoepa' },
  { op: 'gt',  value: 2.25, next: 'hpml' },
], default: 'safe' };
eq('first-match: 7.25 -> first rule (hoepa)', evaluateGate(spreadGate, { spread: 7.25 }).next, 'hoepa');
eq('first-match: 3 -> second rule (hpml)', evaluateGate(spreadGate, { spread: 3 }).next, 'hpml');
eq('default: 1 -> safe', evaluateGate(spreadGate, { spread: 1 }).next, 'safe');
eq('default on absent -> safe', evaluateGate(spreadGate, { other: 1 }).next, 'safe');
// full decision record shape
eq('decision record (matched)', evaluateGate(spreadGate, { spread: 7.25 }), {
  input_pointer: '/spread', observed_value: 7.25, matched_rule_index: 0, op: 'gte', value: 6.5, next: 'hoepa',
});
eq('decision record (default)', evaluateGate(spreadGate, { spread: 1 }), {
  input_pointer: '/spread', observed_value: 1, matched_rule_index: null, op: null, value: null, next: 'safe',
});
eq('decision record (absent -> observed null)', evaluateGate(spreadGate, {}), {
  input_pointer: '/spread', observed_value: null, matched_rule_index: null, op: null, value: null, next: 'safe',
});
// present/absent record carries value:null (no comparison value)
eq('present record value null', evaluateGate({ input: '/verdict', rules: [{ op: 'present', next: 'x' }], default: 'y' }, { verdict: 'z' }), {
  input_pointer: '/verdict', observed_value: 'z', matched_rule_index: 0, op: 'present', value: null, next: 'x',
});

// --- determinism: identical inputs -> identical record ---------------------
const r1 = JSON.stringify(evaluateGate(spreadGate, { spread: 7.25 }));
const r2 = JSON.stringify(evaluateGate(spreadGate, { spread: 7.25 }));
ok('determinism: same input -> same record', r1 === r2);

// --- tamper-detect: a verifier recomputes the decision from the recorded ---
// output_payload; mutating observed_value / decision no longer recomputes.
const outputPayload = { spread: 7.25 };
const recorded = evaluateGate(spreadGate, outputPayload);
const recomputed = evaluateGate(spreadGate, outputPayload);
ok('recompute matches recorded', JSON.stringify(recorded) === JSON.stringify(recomputed));
const tampered = { ...recorded, observed_value: 1, next: 'safe' };
ok('tampered decision != recomputed', JSON.stringify(tampered) !== JSON.stringify(recomputed));
// mutate the underlying output -> recompute yields a different route (detectable)
const mutatedOut = { spread: 1 };
ok('mutated output_payload recomputes to a different next', evaluateGate(spreadGate, mutatedOut).next !== recorded.next);

// --- stepId default = tool_id ----------------------------------------------
eq('stepId explicit', stepId({ id: 's0', tool_id: 't' }, 3), 's0');
eq('stepId default tool_id', stepId({ tool_id: 't' }, 3), 't');
eq('stepId empty id falls back', stepId({ id: '', tool_id: 't' }, 3), 't');

// VALUE_OPS excludes present/absent
ok('VALUE_OPS excludes present/absent', !VALUE_OPS.includes('present') && !VALUE_OPS.includes('absent') && VALUE_OPS.includes('eq'));

if (fail) { console.error(`\n✗ gate-semantics: ${fail} assertion(s) FAILED`); process.exit(1); }
console.log('✅ gate-semantics: all decision-gate vectors passed (ops × types × first-match × default × determinism × tamper-detect).');
