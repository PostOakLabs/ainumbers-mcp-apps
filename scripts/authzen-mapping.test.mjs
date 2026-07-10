#!/usr/bin/env node
// authzen-mapping.test.mjs — AuthZEN 1.0 request/response veneer (GAP-b).
//
// Proves _authzen.mjs is a pure mapping over the shared evaluator
// (kernels/_gateval.mjs) with zero comparator-gate semantic drift: it does not
// duplicate gate logic, only shapes AuthZEN requests in and decisions out.
// Covers happy (allow), deny (escalate), and malformed-request paths.
//
// Run: node scripts/authzen-mapping.test.mjs   (exit 0 = all green)

import { authzenEvaluate } from '../_authzen.mjs';
import { evaluateGate } from '../kernels/_gateval.mjs';

let fail = 0;
const eq = (label, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { /* pass */ } else { fail++; console.error(`✗ ${label}\n    got:  ${g}\n    want: ${w}`); }
};
const ok = (label, cond) => { if (!cond) { fail++; console.error(`✗ ${label}`); } };

const subject  = { type: 'agent', id: 'agent-1' };
const action   = { name: 'approve_transfer' };
const resource = { type: 'chain_step', id: 'step-1' };

// --- happy path: gate routes to a normal step id -> decision:true ----------
const gate = { input: '/spread', rules: [
  { op: 'gte', value: 6.5, next: 'escalate' },
  { op: 'gt',  value: 2.25, next: 'hpml' },
], default: 'safe' };

const happy = authzenEvaluate({ subject, action, resource, context: { gate, output_payload: { spread: 1 } } });
eq('happy: default route -> decision true', happy.decision, true);
eq('happy: gate_decision matches raw evaluateGate', happy.context.gate_decision, evaluateGate(gate, { spread: 1 }));
eq('happy: subject/action/resource echoed', [happy.context.subject_id, happy.context.action_name, happy.context.resource_id], ['agent-1', 'approve_transfer', 'step-1']);

const midRoute = authzenEvaluate({ subject, action, resource, context: { gate, output_payload: { spread: 3 } } });
eq('happy: non-terminal step route -> decision true', midRoute.decision, true);
eq('happy: next is the matched step id', midRoute.context.gate_decision.next, 'hpml');

// --- deny path: gate routes to escalate -> decision:false -------------------
const deny = authzenEvaluate({ subject, action, resource, context: { gate, output_payload: { spread: 7.25 } } });
eq('deny: escalate route -> decision false', deny.decision, false);
eq('deny: gate_decision.next is escalate', deny.context.gate_decision.next, 'escalate');

const endGate = { input: '/x', rules: [], default: 'end' };
const endRoute = authzenEvaluate({ subject, action, resource, context: { gate: endGate, output_payload: {} } });
eq('happy: "end" route -> decision true (only escalate denies)', endRoute.decision, true);

// --- malformed requests ------------------------------------------------------
ok('malformed: no request', authzenEvaluate(undefined).decision === false && authzenEvaluate(undefined).context.error === 'malformed_request');
ok('malformed: missing subject.id', authzenEvaluate({ subject: {}, action, resource, context: { gate, output_payload: {} } }).context.error === 'malformed_request');
ok('malformed: missing action.name', authzenEvaluate({ subject, action: {}, resource, context: { gate, output_payload: {} } }).context.error === 'malformed_request');
ok('malformed: missing resource.id', authzenEvaluate({ subject, action, resource: {}, context: { gate, output_payload: {} } }).context.error === 'malformed_request');
ok('malformed: missing context', authzenEvaluate({ subject, action, resource }).context.error === 'malformed_request');
ok('malformed: context.gate not a gate shape', authzenEvaluate({ subject, action, resource, context: { gate: { input: '/x' }, output_payload: {} } }).context.error === 'malformed_request');
ok('malformed: missing output_payload', authzenEvaluate({ subject, action, resource, context: { gate } }).context.error === 'malformed_request');
ok('malformed: output_payload not an object', authzenEvaluate({ subject, action, resource, context: { gate, output_payload: 'nope' } }).context.error === 'malformed_request');
ok('malformed never throws', (() => { try { authzenEvaluate(null); authzenEvaluate(42); authzenEvaluate({}); return true; } catch { return false; } })());

// --- zero comparator-gate semantic drift: raw evaluateGate output byte-identical
// to what the mapping wraps, for every op family -----------------------------
const opGate = { input: '/v', rules: [
  { op: 'eq', value: 'A', next: 'a' },
  { op: 'in', value: ['B','C'], next: 'bc' },
  { op: 'present', next: 'p' },
], default: 'd' };
for (const v of ['A', 'B', 'Z', undefined]) {
  const payload = v === undefined ? {} : { v };
  const raw = evaluateGate(opGate, payload);
  const wrapped = authzenEvaluate({ subject, action, resource, context: { gate: opGate, output_payload: payload } }).context.gate_decision;
  eq(`no drift for v=${JSON.stringify(v)}`, wrapped, raw);
}

if (fail) { console.error(`\n✗ authzen-mapping: ${fail} assertion(s) FAILED`); process.exit(1); }
console.log('✅ authzen-mapping: AuthZEN 1.0 veneer maps to evaluateGate with zero semantic drift (happy/deny/malformed).');
