#!/usr/bin/env node
// gate-static.test.mjs — OCG v0.8 gate 1 enforcement proof.
//
// Asserts validateChainGates() (used by validate-chains.mjs Layer 4) ACCEPTS a
// well-formed gated chain and REJECTS each malformed pattern: bad pointer,
// unknown op, mistyped value, missing default, backward (non-forward) target,
// unresolved target, duplicate step id, and an unreachable step. Also confirms
// linear chains are untouched.
//
// Run: node scripts/gate-static.test.mjs   (exit 0 = all green)

import { validateChainGates } from './gate-static.mjs';

let fail = 0;
const clean = (label, chain) => {
  const e = validateChainGates(chain);
  if (e.length) { fail++; console.error(`✗ ${label} — expected CLEAN, got:\n    ${e.join('\n    ')}`); }
};
const flags = (label, chain, needle) => {
  const e = validateChainGates(chain);
  if (!e.some((x) => x.toLowerCase().includes(needle.toLowerCase()))) {
    fail++; console.error(`✗ ${label} — expected an error containing "${needle}", got:\n    ${e.join('\n    ') || '(none)'}`);
  }
};

// A representative well-formed gated chain (the mortgage-preflight shape).
const good = { name: 'mortgage-compliance-preflight', steps: [
  { tool_id: 'compute-apr', id: 'apr' },
  { tool_id: 'check-qm', id: 'qm', gate: { input: '/qm_status', rules: [
    { op: 'eq', value: 'fail', next: 'hoepa' },
    { op: 'eq', value: 'pass', next: 'end' },
  ], default: 'hoepa' } },
  { tool_id: 'test-hoepa', id: 'hoepa', gate: { input: '/spread', rules: [
    { op: 'gte', value: 6.5, next: 'adverse' },
  ], default: 'end' } },
  { tool_id: 'adverse-action', id: 'adverse' },
] };
clean('well-formed gated chain', good);

// Linear chain (no gates) — untouched even with a repeated tool_id.
clean('linear chain untouched', { name: 'x', steps: [ { tool_id: 't' }, { tool_id: 't' }, { tool_id: 'u' } ] });

const withGate = (gate, extra = []) => ({ name: 'c', steps: [
  { tool_id: 'a', id: 'a', gate }, { tool_id: 'b', id: 'b' }, { tool_id: 'c', id: 'c' }, ...extra,
] });

flags('bad pointer', withGate({ input: 'no-slash', rules: [{ op: 'present', next: 'b' }], default: 'end' }), 'RFC 6901');
flags('unknown op', withGate({ input: '/x', rules: [{ op: 'matches', value: 1, next: 'b' }], default: 'end' }), 'closed enum');
flags('numeric value mistyped', withGate({ input: '/x', rules: [{ op: 'gt', value: '5', next: 'b' }], default: 'end' }), 'finite number');
flags('in value not array', withGate({ input: '/x', rules: [{ op: 'in', value: 'a', next: 'b' }], default: 'end' }), 'array');
flags('present carries value', withGate({ input: '/x', rules: [{ op: 'present', value: 1, next: 'b' }], default: 'end' }), 'must not carry');
flags('missing default', withGate({ input: '/x', rules: [{ op: 'present', next: 'b' }] }), 'default');
flags('unresolved target', withGate({ input: '/x', rules: [{ op: 'present', next: 'zzz' }], default: 'end' }), 'resolves to no step id');
flags('backward target', { name: 'c', steps: [
  { tool_id: 'a', id: 'a' },
  { tool_id: 'b', id: 'b', gate: { input: '/x', rules: [{ op: 'present', next: 'a' }], default: 'end' } },
  { tool_id: 'c', id: 'c' },
] }, 'forward-only');
flags('duplicate id', { name: 'c', steps: [
  { tool_id: 'a', id: 'dup', gate: { input: '/x', rules: [{ op: 'present', next: 'end' }], default: 'end' } },
  { tool_id: 'b', id: 'dup' },
] }, 'duplicate step id');
// step 'b' can never be reached: gate on step 'a' only routes to c or end.
flags('unreachable step', { name: 'c', steps: [
  { tool_id: 'a', id: 'a', gate: { input: '/x', rules: [{ op: 'present', next: 'c' }], default: 'c' } },
  { tool_id: 'b', id: 'b' },
  { tool_id: 'c', id: 'c' },
] }, 'unreachable');

if (fail) { console.error(`\n✗ gate-static: ${fail} assertion(s) FAILED`); process.exit(1); }
console.log('✅ gate-static: validateChainGates accepts a good gated chain and rejects every malformed pattern.');
