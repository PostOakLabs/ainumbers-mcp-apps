#!/usr/bin/env node
// gate-branch-coverage.test.mjs — OCG v0.8 gate 4 (both-branch fixtures).
//
// Requirement: any GATED chain must ship fixture scenarios that drive EVERY
// branch (each rule + the default of every gate) at least once. This gate proves
// the coverage checker (gate-static.coverageGaps) is correct AND demonstrates
// end-to-end that a two-scenario fixture set covers both sides of a gate when run
// through the real embed runChain loop (with a fully-controlled mock kernel so
// the routing is deterministic and decoupled from any specific node's output).
//
// No live gated chain exists yet (first ships with Wave 36); this exercises the
// mechanism on a synthetic test-only chain, never written to chaingraph.json.
//
// Run: node scripts/gate-branch-coverage.test.mjs   (exit 0 = all green)

import { runChain as embedRunChain } from '../embed/runChain.mjs';
import { executionHash } from '../embed/lib/_hash.mjs';
import { enumerateBranches, coverageGaps, validateChainGates } from './gate-static.mjs';

let fail = 0;
const ok = (label) => console.log('  ✓ ' + label);
const bad = (label, detail) => { fail++; console.error('  ✗ ' + label + (detail ? ' — ' + detail : '')); };

// A mock kernel that echoes its input `verdict` into output_payload so a gate can
// route on it deterministically. Produces a valid §4 artifact.
const mockKernel = {
  async buildArtifact(pp) {
    const policy_parameters = { execution_backend: 'server', input_parameters: pp };
    const output_payload = { verdict: pp?.verdict ?? 'none' };
    return {
      chaingraph_version: '0.4.0', mandate_type: 'compliance_mandate', tool_id: 'mock',
      execution_hash: await executionHash(policy_parameters, output_payload),
      policy_parameters, output_payload, audit_signature: {},
    };
  },
};
const deps = {
  getKernel: () => mockKernel,
  chaingraph: { nodes: [{ tool_id: 'mock', gpu: false }], chains: [] },
};

// Synthetic gated chain: gate on the echoed verdict — 'fail' ends, else continue.
const chain = { name: 'branch-demo', title: 'branch demo', steps: [
  { tool_id: 'mock', id: 'g', gate: { input: '/verdict', rules: [{ op: 'eq', value: 'fail', next: 'end' }], default: 'cont' } },
  { tool_id: 'mock', id: 'cont' },
] };

// Static validation first (gate 1 must accept it).
if (validateChainGates(chain).length) bad('synthetic chain is statically valid');
else ok('synthetic gated chain passes static validation');

// enumerateBranches: g#rule0 + g#default.
const branches = enumerateBranches(chain);
if (JSON.stringify(branches.sort()) !== JSON.stringify(['g#default', 'g#rule0'])) bad('enumerateBranches', JSON.stringify(branches));
else ok('enumerateBranches -> [g#rule0, g#default]');

// Run both scenarios through the REAL embed loop.
const runScenario = (verdict) => embedRunChain('branch-demo',
  { mock: { verdict } },
  { ...deps, chaingraph: { ...deps.chaingraph, chains: [chain] }, fixtures: {} });

const rFail = await runScenario('fail');   // -> rule0 (next end): skips cont
const rPass = await runScenario('pass');   // -> default (cont): runs both

if (rFail.decisions?.[0]?.matched_rule_index !== 0) bad('fail scenario hits rule0', JSON.stringify(rFail.decisions));
else ok(`fail -> rule0, path=${JSON.stringify(rFail.path_taken)} (${rFail.steps_ran} ran)`);
if (rPass.decisions?.[0]?.matched_rule_index !== null) bad('pass scenario hits default', JSON.stringify(rPass.decisions));
else ok(`pass -> default, path=${JSON.stringify(rPass.path_taken)} (${rPass.steps_ran} ran)`);

// Full coverage from the two-scenario set; a single scenario leaves a gap.
const bothGaps = coverageGaps(chain, [rFail.decisions, rPass.decisions]);
if (bothGaps.length) bad('two-scenario set is FULL coverage', JSON.stringify(bothGaps));
else ok('two-scenario fixture set covers every branch (coverageGaps == [])');

const oneGap = coverageGaps(chain, [rFail.decisions]);
if (!(oneGap.length === 1 && oneGap[0] === 'g#default')) bad('single scenario leaves g#default uncovered', JSON.stringify(oneGap));
else ok('single-scenario set correctly flagged: missing g#default');

if (fail) { console.error(`\n✗ gate-branch-coverage: ${fail} failure(s)`); process.exit(1); }
console.log('✅ gate-branch-coverage: every gate branch is drivable and the coverage checker flags any uncovered branch.');
