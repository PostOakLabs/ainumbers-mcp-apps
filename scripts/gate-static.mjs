// gate-static.mjs — OCG v0.8 gate 1 (static decision-gate validation).
//
// Pure, build-time. Reuses the op enum + pointer-syntax check + stepId from the
// single evaluator source (kernels/_gateval.mjs) so the static checks and the
// runtime behavior can never disagree. Imported by validate-chains.mjs (Layer 4)
// and gate-static.test.mjs. Only GATED chains are checked; a linear chain (no
// step carries a `gate`) is returned clean, so existing chains are untouched.
//
// Checks (OCG §21.4):
//   - step ids unique within the chain (id defaults to tool_id)
//   - gate.input is valid RFC 6901
//   - gate.rules non-empty; each rule op in the closed enum; value present &
//     well-typed for value ops (finite number for gt/gte/lt/lte; array for in);
//     no value on present/absent
//   - every rule.next and gate.default resolves to a step id or "end"
//   - gate.default REQUIRED
//   - all targets FORWARD-ONLY (later array index) => acyclic, terminating
//   - no step is UNREACHABLE

import { GATE_OPS, VALUE_OPS, isPointerSyntaxValid, stepId, isTerminalTarget } from '../kernels/_gateval.mjs';

const OP_SET = new Set(GATE_OPS);
const NUMERIC_OPS = new Set(['gt', 'gte', 'lt', 'lte']);

/** @returns {string[]} errors (empty = valid). */
export function validateChainGates(chain) {
  const errs = [];
  const steps = Array.isArray(chain?.steps) ? chain.steps : [];
  const hasGates = steps.some((s) => s && s.gate);
  if (!hasGates) return errs; // linear chain — no §21.4 constraints apply

  // Step ids (default tool_id) — MUST be unique in a gated chain (routing targets).
  const ids = steps.map((s, i) => stepId(s, i));
  const firstIndex = new Map();
  ids.forEach((id, i) => {
    if (firstIndex.has(id)) errs.push(`step ${i + 1}: duplicate step id "${id}" (first used at step ${firstIndex.get(id) + 1}) — ids MUST be unique in a gated chain`);
    else firstIndex.set(id, i);
  });
  // §22.8.1: "escalate" is a terminal target beside "end" — the single-source
  // isTerminalTarget classifier is the gate; never hardcode the literal.
  const isTarget = (t) => isTerminalTarget(t) || firstIndex.has(t);
  const targetIdx = (t) => (isTerminalTarget(t) ? steps.length : firstIndex.get(t));

  steps.forEach((s, i) => {
    if (!s || !s.gate) return;
    const g = s.gate;
    const p = `step ${i + 1} (${ids[i]}) gate`;
    if (typeof g !== 'object' || Array.isArray(g)) { errs.push(`${p}: must be an object`); return; }
    if (!isPointerSyntaxValid(g.input)) errs.push(`${p}: input ${JSON.stringify(g.input)} is not a valid RFC 6901 JSON Pointer`);

    if (!Array.isArray(g.rules) || g.rules.length === 0) {
      errs.push(`${p}: rules[] must be a non-empty array`);
    } else {
      g.rules.forEach((r, ri) => {
        const rp = `${p} rule ${ri + 1}`;
        if (!r || typeof r !== 'object') { errs.push(`${rp}: must be an object`); return; }
        if (!OP_SET.has(r.op)) errs.push(`${rp}: op ${JSON.stringify(r.op)} not in the closed enum {${GATE_OPS.join(',')}}`);
        if (VALUE_OPS.includes(r.op)) {
          if (!('value' in r)) errs.push(`${rp}: op "${r.op}" requires a "value"`);
          else if (NUMERIC_OPS.has(r.op) && !(typeof r.value === 'number' && Number.isFinite(r.value))) errs.push(`${rp}: op "${r.op}" value must be a finite number`);
          else if (r.op === 'in' && !Array.isArray(r.value)) errs.push(`${rp}: op "in" value must be a literal array`);
        } else if (OP_SET.has(r.op) && 'value' in r) {
          errs.push(`${rp}: op "${r.op}" must not carry a "value"`);
        }
        if (typeof r.next !== 'string' || !r.next) errs.push(`${rp}: missing "next" (a step id or "end")`);
        else if (!isTarget(r.next)) errs.push(`${rp}: next "${r.next}" resolves to no step id, "end", or "escalate"`);
        else if (!isTerminalTarget(r.next) && targetIdx(r.next) <= i) errs.push(`${rp}: next "${r.next}" is not forward-only (targets step ${targetIdx(r.next) + 1}, must be > ${i + 1})`);
      });
    }

    if (typeof g.default !== 'string' || !g.default) errs.push(`${p}: "default" is REQUIRED (a step id or "end")`);
    else if (!isTarget(g.default)) errs.push(`${p}: default "${g.default}" resolves to no step id, "end", or "escalate"`);
    else if (!isTerminalTarget(g.default) && targetIdx(g.default) <= i) errs.push(`${p}: default "${g.default}" is not forward-only`);
  });

  // Reachability over the forward-only DAG. Successors: a gated step routes via
  // its rule targets + default (no linear fall-through); a plain step falls to i+1.
  const reachable = new Array(steps.length).fill(false);
  if (steps.length) reachable[0] = true;
  for (let i = 0; i < steps.length; i++) {
    if (!reachable[i]) continue;
    const s = steps[i];
    const succ = [];
    if (s && s.gate) {
      const g = s.gate;
      for (const r of (Array.isArray(g.rules) ? g.rules : [])) {
        if (r && typeof r.next === 'string' && isTarget(r.next) && !isTerminalTarget(r.next)) succ.push(targetIdx(r.next));
      }
      if (typeof g.default === 'string' && isTarget(g.default) && !isTerminalTarget(g.default)) succ.push(targetIdx(g.default));
    } else if (i + 1 < steps.length) {
      succ.push(i + 1);
    }
    for (const j of succ) if (j >= 0 && j < steps.length) reachable[j] = true;
  }
  steps.forEach((s, i) => {
    if (!reachable[i]) errs.push(`step ${i + 1} (${ids[i]}) is UNREACHABLE (no gate routes to it and it is not a linear successor)`);
  });

  return errs;
}

// Enumerate every decision BRANCH of a gated chain: one per rule (<id>#rule<i>)
// plus the default (<id>#default) of each gate. A branch-coverage fixture set
// (gate 4) MUST drive every one of these at least once.
export function enumerateBranches(chain) {
  const out = [];
  const steps = Array.isArray(chain?.steps) ? chain.steps : [];
  steps.forEach((s, i) => {
    if (!s || !s.gate) return;
    const id = stepId(s, i);
    const rules = Array.isArray(s.gate.rules) ? s.gate.rules : [];
    rules.forEach((_, ri) => out.push(`${id}#rule${ri}`));
    out.push(`${id}#default`);
  });
  return out;
}

// Map one run's decisions[] (each {step_id, matched_rule_index}) to the set of
// branch keys it exercised.
export function branchesHitBy(decisions) {
  const hit = new Set();
  for (const d of (decisions || [])) {
    hit.add(`${d.step_id}#${d.matched_rule_index === null ? 'default' : 'rule' + d.matched_rule_index}`);
  }
  return hit;
}

// Given a chain and the decisions[] of each fixture scenario, return the branch
// keys NOT covered by any scenario ([] = full coverage). This is the gate-4 core.
export function coverageGaps(chain, scenarioDecisionsList) {
  const need = new Set(enumerateBranches(chain));
  for (const decisions of (scenarioDecisionsList || [])) {
    for (const b of branchesHitBy(decisions)) need.delete(b);
  }
  return [...need];
}
