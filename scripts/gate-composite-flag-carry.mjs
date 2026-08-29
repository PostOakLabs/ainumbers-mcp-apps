#!/usr/bin/env node
// gate-composite-flag-carry.mjs — COMPOSITE-FLAG-AGGREGATE-1 (audit finding FB-01 / FB-04).
//
// WHY: both chain runners used to stamp the composite artifact with a HARDCODED
// `compliance_flags: []` over children that may have raised flags — an affirmative
// all-clear the run never earned, and the exact inverse of SPEC §27.10's honesty
// doctrine ("omitting that flag rather than setting it false is the honest encoding").
// The 2026-08-23 flag-blind-consumers audit measured the consequence: of 1843 consumer
// instances only 497 carry flags at all, and the composite fold — the one artifact
// designed to summarise a chain — discarded them by construction.
//
// This gate is the standing proof of the fix, and it is deliberately adversarial about
// the one thing that must NOT change: the composite execution_hash.
//
//   1. CARRIED       — composite_artifact.compliance_flags is the deduped, sorted union of the
//                      RAN steps' flags (derived, never asserted).
//   2. PER-STEP      — output_payload.step_compliance_flags names every flag-bearing step.
//   3. RESPONSE      — FB-04: steps[].compliance_flags reaches the MCP/library caller.
//   4. ADJACENCY     — STRUCTURAL, not coincidental: re-running the §4 execution hash over the
//                      payload with the adjacent members REMOVED reproduces the published
//                      composite_execution_hash, and leaving them IN produces a different hash.
//                      The second half is the mutation control (SO #34): without it, "the hash
//                      didn't move" would also pass for a gate that computes nothing.
//   5. NO-FABRICATION— a chain whose children raise no flags gets `[]` because it earned `[]`,
//                      and carries no step_compliance_flags member at all.
//
// Zero-dep, no network, no node_modules: imports only the embedded runner and the hash SSOT.
//
// Usage: node scripts/gate-composite-flag-carry.mjs

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runChain } from '../embed/runChain.mjs';
import { executionHash } from '../embed/lib/_hash.mjs';
import { getKernel } from '../kernels/index.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = resolve(ROOT, 'data');
const rd = (p) => JSON.parse(readFileSync(resolve(DATA, p), 'utf8'));

const chaingraph = rd('chaingraph/chaingraph.json');
const fixtures = rd('chain-fixtures.json');
const deps = { getKernel, chaingraph, fixtures };

// Adjacent (hash-EXCLUDED) members of composite output_payload. Every entry here is attached
// AFTER the composite hash is taken; assertion 4 proves that claim rather than trusting it.
const ADJACENT_MEMBERS = ['step_compliance_flags', 'escalation_record'];

let failed = 0;
const fail = (m) => { console.error(`  ✗ ${m}`); failed++; };
const ok = (m) => console.log(`  ✓ ${m}`);
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const known = new Set((chaingraph.chains ?? []).map((c) => c.name));
const chainNames = Object.keys(fixtures).filter((n) => known.has(n)).sort();

async function run(name) {
  try { return await runChain(name, fixtures[name], deps); } catch { return null; }
}

function unionOfChildFlags(res) {
  const ran = (res.composite_artifact?.output_payload?.steps ?? []);
  void ran; // the composite projection deliberately has no flags — read them off the response instead
  const flags = (res.steps ?? [])
    .filter((s) => s.status === 'ok' && Array.isArray(s.compliance_flags))
    .flatMap((s) => s.compliance_flags);
  return [...new Set(flags)].sort();
}

async function main() {
  console.log(`▶ composite flag carriage (FB-01/FB-04) — scanning ${chainNames.length} fixture-runnable chains`);

  let flagged = null, flaggedName = null, clean = null, cleanName = null;
  for (const name of chainNames) {
    const res = await run(name);
    if (!res || !res.composite_artifact) continue;
    const anyFlags = (res.steps ?? []).some((s) => s.status === 'ok' && Array.isArray(s.compliance_flags) && s.compliance_flags.length > 0);
    if (anyFlags && !flagged) { flagged = res; flaggedName = name; }
    if (!anyFlags && !clean) { clean = res; cleanName = name; }
    if (flagged && clean) break;
  }

  // Absence is not a pass (SO #34c): if no chain in the corpus raises a child flag, this gate
  // cannot prove carriage and must say so rather than reporting green.
  if (!flagged) {
    console.error('✗ no fixture-runnable chain produced a flag-raising step — carriage is UNPROVEN, not proven.');
    process.exit(1);
  }

  const art = flagged.composite_artifact;
  const payload = art.output_payload;
  const expected = unionOfChildFlags(flagged);
  console.log(`\n  chain under test: ${flaggedName}  (composite_execution_hash ${art.execution_hash})`);
  console.log(`  child flags observed: ${JSON.stringify(expected)}`);

  // 1. CARRIED
  if (!Array.isArray(art.compliance_flags) || art.compliance_flags.length === 0) {
    fail(`composite compliance_flags is ${JSON.stringify(art.compliance_flags)} while children raised ${JSON.stringify(expected)} — the fabricated all-clear (FB-01) is still live.`);
  } else if (!eq(art.compliance_flags, expected)) {
    fail(`composite compliance_flags ${JSON.stringify(art.compliance_flags)} != union of child flags ${JSON.stringify(expected)}.`);
  } else {
    ok(`composite compliance_flags = ${JSON.stringify(art.compliance_flags)} (deduped, sorted union of the RAN steps')`);
  }

  // 2. PER-STEP adjacency member
  const perStep = payload.step_compliance_flags;
  if (!Array.isArray(perStep) || perStep.length === 0) {
    fail('output_payload.step_compliance_flags missing — per-step attribution lost in the fold.');
  } else if (!perStep.every((s) => typeof s.tool_id === 'string' && Number.isInteger(s.order) && Array.isArray(s.compliance_flags) && s.compliance_flags.length)) {
    fail(`step_compliance_flags entries malformed: ${JSON.stringify(perStep).slice(0, 200)}`);
  } else {
    ok(`step_compliance_flags carries ${perStep.length} flag-bearing step(s): ${perStep.map((s) => s.tool_id).join(', ')}`);
  }

  // 3. RESPONSE surface (FB-04)
  const okSteps = (flagged.steps ?? []).filter((s) => s.status === 'ok');
  if (!okSteps.length || !okSteps.every((s) => Array.isArray(s.compliance_flags))) {
    fail('steps[].compliance_flags absent on ran steps — an MCP agent still has no path to step caveats (FB-04).');
  } else {
    ok(`steps[].compliance_flags present on all ${okSteps.length} ran step(s)`);
  }

  // 4. ADJACENCY — structural, with a mutation control.
  const frozen = JSON.parse(JSON.stringify(payload));
  const removed = ADJACENT_MEMBERS.filter((k) => k in frozen);
  for (const k of removed) delete frozen[k];
  const withoutAdjacent = await executionHash(art.policy_parameters, frozen);
  const withAdjacent = await executionHash(art.policy_parameters, payload);

  if (withoutAdjacent !== art.execution_hash) {
    fail(`ADJACENCY BROKEN — hash over the payload minus ${JSON.stringify(removed)} is ${withoutAdjacent}, published hash is ${art.execution_hash}. The flags entered the preimage.`);
  } else {
    ok(`adjacency structural: removing ${JSON.stringify(removed)} reproduces the published composite_execution_hash exactly`);
  }
  if (withAdjacent === art.execution_hash) {
    fail('MUTATION CONTROL FAILED — leaving the adjacent members in the preimage yields the SAME hash, so this check proves nothing. Either the members are empty or the hash ignores output_payload.');
  } else {
    ok(`mutation control: leaving them in yields ${withAdjacent.slice(0, 16)}… ≠ published hash — exclusion is real, not vacuous`);
  }
  // Top-level compliance_flags is outside the §4 preimage by construction (executionHash takes
  // policy_parameters + output_payload only), so the roll-up cannot move a hash at all.
  ok('composite compliance_flags is a top-level artifact member — outside executionHash(policy_parameters, output_payload) by construction');

  // 5. NO-FABRICATION on a genuinely flag-free chain.
  if (!clean) {
    console.log('  ⚠ no flag-free chain in the corpus — the no-fabrication half is unexercised this run.');
  } else {
    const cArt = clean.composite_artifact;
    if (!eq(cArt.compliance_flags, [])) fail(`flag-free chain ${cleanName} reports ${JSON.stringify(cArt.compliance_flags)} — expected [].`);
    else if ('step_compliance_flags' in cArt.output_payload) fail(`flag-free chain ${cleanName} carries an empty step_compliance_flags member — conditional presence broken (would move nothing, but it is noise the old code's shape did not have).`);
    else ok(`flag-free chain ${cleanName}: compliance_flags [] earned, no step_compliance_flags member emitted`);
  }

  console.log('');
  if (failed) { console.error(`✗ composite flag carriage FAILED — ${failed} assertion(s) red.`); process.exit(1); }
  console.log('✅ composite flag carriage: children\'s flags carried as hash-excluded adjacent metadata; zero preimage movement.');
}

main().catch((e) => { console.error('✗ gate-composite-flag-carry ERROR:', e); process.exit(1); });
