// authzen-cert.test.mjs — local proof that the PDP returns the 8 mandated
// AuthZEN certification decisions, that context is optional, that batch works,
// and that the opt-in OCG §21.4 gate mode still functions. No network.
import { authzenEvaluate, authzenEvaluateWithReceipt, authzenEvaluateBatch } from '../_authzen.mjs';

let pass = 0, fail = 0;
function eq(label, got, want) {
  const ok = got === want;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  (got ${got}, want ${want})`);
  ok ? pass++ : fail++;
}

const alice = { type: 'user', id: 'alice' };
const bob = { type: 'user', id: 'bob', properties: { role: 'admin' } };
const rec1 = { type: 'record', id: 'record-1', properties: { status: 'active' } };
const rec2 = { type: 'record', id: 'record-2', properties: { status: 'archived' } };
const read = { name: 'read' }, write = { name: 'write' };
const delSoft = { name: 'delete', properties: { soft: true } };
const delHard = { name: 'delete', properties: { soft: false } };

const d = (s, a, r, c) => authzenEvaluate({ subject: s, action: a, resource: r, ...(c ? { context: c } : {}) }).decision;

// ── 8 mandated fixtures ──
eq('1 alice read record-1', d(alice, read, rec1), true);
eq('2 alice write record-1', d(alice, write, rec1), true);
eq('3 bob read record-1', d(bob, read, rec1), true);
eq('4 bob write record-1', d(bob, write, rec1), false);
eq('5 alice write archived', d(alice, write, rec2), false);
eq('6 admin write archived', d(bob, write, rec2), true);
eq('7 alice delete soft', d(alice, delSoft, rec1), true);
eq('8 alice delete hard', d(alice, delHard, rec1), false);

// ── context is optional AND does not change the outcome ──
eq('ctx-absent == ctx-present (fixture 2)', d(alice, write, rec1), d(alice, write, rec1, {}));
eq('ctx with junk still decides', d(alice, write, rec1, { tenant: 'x' }), true);

// ── malformed still rejected ──
eq('malformed: no subject.id',
   authzenEvaluate({ subject: {}, action: read, resource: rec1 }).context.error, 'malformed_request');

// ── opt-in OCG §21.4 gate mode still works (backward-compat) ──
const gate = { input: '/spread', rules: [{ op: 'gt', value: 5, next: 'escalate' }], default: 'end' };
const gateReq = { subject: alice, action: write, resource: rec1, context: { gate, output_payload: { spread: 10 } } };
eq('gate mode: spread>5 escalates -> deny', authzenEvaluate(gateReq).decision, false);
eq('gate mode: spread<=5 -> permit',
   authzenEvaluate({ ...gateReq, context: { gate, output_payload: { spread: 1 } } }).decision, true);

// ── receipt present in both modes ──
const rcptPolicy = await authzenEvaluateWithReceipt({ subject: alice, action: write, resource: rec1 });
eq('policy-mode receipt has execution_hash', typeof rcptPolicy.context.execution_hash, 'string');
const rcptGate = await authzenEvaluateWithReceipt(gateReq);
eq('gate-mode receipt has execution_hash', typeof rcptGate.context.execution_hash, 'string');

// ── batch endpoint ──
const batch = await authzenEvaluateBatch({
  subject: alice, resource: rec1,
  evaluations: [{ action: read }, { action: write }, { subject: bob, action: write }],
});
eq('batch len', batch.evaluations.length, 3);
eq('batch[0] alice read', batch.evaluations[0].decision, true);
eq('batch[2] bob write', batch.evaluations[2].decision, false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
