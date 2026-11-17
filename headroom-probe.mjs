// headroom-probe.mjs — probe_headroom core (HEADROOM-MCP-1).
//
// Distance to the nearest verdict change found on a declared grid, evaluated IN the worker: the
// caller's policy_parameters are run through the vendored kernel here, on this server. The worker
// sees the inputs it is sent (the MCP-path wording rule; "needs no AINumbers server" belongs to the
// page and local paths only, never here).
//
// No second implementation of the search: the arithmetic and the search come from the vendored site
// library kernels/_headroom.mjs. The hashes come from kernels/_hash.mjs (executionHash,
// policyParametersHash) and nowhere else (SPEC §7 hash path). The verdict reader below is a
// verbatim port of the estate's shared reader (site scripts/lib/verdict-read.mjs) — scripts/ does
// not vendor into the worker bundle, and the fail-open gate, the headroom search and the receipt
// replay must agree on what a verdict is.
//
// Worker scan cap: 500 (spec §4: 10,000 in Node, 500 in the worker). H5: a probe on a pointer
// declared private under SPEC §25 is refused with a structured entry { status: 'refused',
// code: 'private-input', detail }, the same refusal shape the site runner
// (chaingraph/kernels/__headroom__/headroom-gates.mjs refusePrivate) emits. The private pointer
// list travels in the vendored registry data/mcp/headroom-declarations.json, projected by
// generate.mjs from the site's chaingraph/kernels/__headroom__/*.headroom.json declarations.
//
// Copy rule: say "distance to the nearest verdict change found on the declared grid". A result
// whose basis is `bracketed` says "a verdict change exists at this distance", never "the nearest".
// Never "safe margin", "guaranteed" or "compliant up to".

import {
  probeHeadroom, runClass, getPointer, setPointer, gridValue, placesOf, toScaled, fromScaled,
} from './kernels/_headroom.mjs';
import { executionHash, policyParametersHash } from './kernels/_hash.mjs';

export const HEADROOM_REPORT_PROFILE = 'ocg-headroom-report@1';
export const HEADROOM_SCAN_CAP_WORKER = 500;

// ---- the shared verdict reader (verbatim port of site scripts/lib/verdict-read.mjs) ----

// Verdict-bearing keys of an output payload, in the order they are tried.
export const VERDICT_KEYS = ['verdict', 'status', 'decision', 'outcome', 'result', 'readiness', 'eligibility', 'profile_status', 'ready', 'eligible', 'compliant', 'valid', 'passed', 'pass', 'met', 'approved', 'conserved', 'within_mandate'];

// The small explicit token map. Anything outside it is UNCLASSIFIED, never guessed.
const POSITIVE = new Set(['READY', 'SPEND', 'MET', 'PASS', 'PASSED', 'OK', 'APPROVED', 'ELIGIBLE', 'COMPLIANT', 'VALID', 'CONFIRMED', 'SETTLED', 'SUCCESS', 'ALLOW', 'ALLOWED', 'ACCEPT', 'ACCEPTED', 'FINAL', 'CLEAR', 'WITHIN_MANDATE', 'CONSERVED']);
const REFUSAL = new Set(['REFUSE', 'REFUSED', 'REFUSAL', 'INDETERMINATE', 'NOT_EVALUATED', 'NOT_EVALUABLE', 'NOTEVALUATED', 'NOTEVALUABLE', 'ERROR', 'INVALID_INPUT', 'MISSING_INPUT', 'UNKNOWN']);
const NEGATIVE = new Set(['FAIL', 'FAILED', 'NOT_READY', 'NOT_MET', 'UNMET', 'REJECT', 'REJECTED', 'DENY', 'DENIED', 'INELIGIBLE', 'NON_COMPLIANT', 'INVALID', 'BLOCKED', 'NO_SPEND', 'NOT_ELIGIBLE', 'BREACH', 'OUTSIDE_MANDATE', 'NOT_CONSERVED', 'EXCEEDS_MANDATE']);
const BOOL_KEYS = new Set(['ready', 'eligible', 'compliant', 'valid', 'passed', 'pass', 'met', 'approved', 'conserved', 'within_mandate']);

/** @returns {'positive'|'refusal'|'negative'|'unclassified'} */
export function classifyValue(key, value) {
  if (typeof value === 'boolean') return BOOL_KEYS.has(key) ? (value ? 'positive' : 'negative') : 'unclassified';
  if (typeof value !== 'string') return 'unclassified';
  const t = value.trim().toUpperCase().replace(/[\s-]+/g, '_');
  if (POSITIVE.has(t)) return 'positive';
  if (REFUSAL.has(t)) return 'refusal';
  if (NEGATIVE.has(t)) return 'negative';
  return 'unclassified';
}

/** Find the verdict key/class of a payload: first VERDICT_KEYS entry present. */
export function readVerdict(payload) {
  if (!payload || typeof payload !== 'object') return null;
  for (const k of VERDICT_KEYS) {
    if (Object.prototype.hasOwnProperty.call(payload, k)) return { key: k, value: payload[k], cls: classifyValue(k, payload[k]) };
  }
  return null;
}

// ---- declaration handling (port of headroom-gates.mjs classifierFor/refusePrivate) ----

/** Verdict classifier for a declaration: the declared map when present, else the shared reader. */
export function classifierFor(decl) {
  const v = decl.verdict;
  if (!v) return (payload) => { const r = readVerdict(payload); return r ? r.cls : 'unclassified'; };
  return (payload) => {
    const x = getPointer(payload, v.pointer);
    if (typeof x === 'boolean') return x ? 'positive' : 'negative';
    return (v.map && v.map[x]) || 'unclassified';
  };
}

const verdictLabel = (decl, payload) => {
  if (decl.verdict) { const x = getPointer(payload, decl.verdict.pointer); return x === undefined ? null : String(x); }
  const r = readVerdict(payload);
  return r ? String(r.value) : null;
};

/** H5: a pointer equal to, or under, a declared private input is refused. */
export function refusePrivate(pointer, privateInputs) {
  for (const e of privateInputs || []) {
    const p = typeof e === 'string' ? e : e && e.pointer;
    if (p && (pointer === p || pointer.startsWith(`${p}/`))) return { code: 'private-input', detail: `${pointer} is declared under private_inputs (${p})` };
  }
  return null;
}

const clone = (o) => JSON.parse(JSON.stringify(o));

/** Witness hashes from executionHash/policyParametersHash and nowhere else (SPEC §7). */
async function attachWitnessHashes(e, compute, pp, probe, dir, decl, classify) {
  const sign = dir === '+' ? 1 : -1;
  const baseValue = getPointer(pp, probe.pointer);
  for (const [slot, n] of [['last_same', e.lo], ['first_other', e.hi]]) {
    const q = clone(pp);
    const text = gridValue(String(baseValue), probe.step, sign * n);
    setPointer(q, probe.pointer, typeof baseValue === 'string' ? text : Number(text));
    const r = await runClass(compute, q, classify);
    e.witness[slot].policy_parameters_hash = await policyParametersHash(q);
    e.witness[slot].execution_hash = r.payload ? await executionHash(q, r.payload) : null;
    e.witness[slot].verdict = r.payload ? verdictLabel(decl, r.payload) : `thrown: ${r.thrown}`;
  }
}

/**
 * Run the declared probes for one tool_id against the caller's policy_parameters.
 *
 * @param {{
 *   tool_id: string,
 *   policy_parameters: object,
 *   pointers?: string[]|null,
 *   declarations: object|null,           // the vendored headroom-declarations registry
 *   getKernel: (tool_id: string) => any, // kernels/index.mjs getKernel
 *   scanCap?: number,
 * }} args
 * @returns {Promise<object>} the ocg-headroom-report@1 report (structured; refusals are entries)
 */
export async function probeHeadroomCore(args) {
  const { tool_id, policy_parameters, pointers, declarations, getKernel } = args;
  const scanCap = args.scanCap ?? HEADROOM_SCAN_CAP_WORKER;
  const decl = declarations && declarations[tool_id];
  if (!decl) {
    return {
      profile: HEADROOM_REPORT_PROFILE,
      base: { tool_id, kernel_digest: null, execution_hash: null, verdict: null },
      entries: [],
      evaluations: 0,
      skipped: 'no headroom declaration for this tool_id (probes are declared per node in the site repo chaingraph/kernels/__headroom__/)',
    };
  }
  const kernelMod = getKernel(tool_id);
  const compute = kernelMod && typeof kernelMod.compute === 'function' ? kernelMod.compute : null;
  if (!compute) {
    return {
      profile: HEADROOM_REPORT_PROFILE,
      base: { tool_id, kernel_digest: null, execution_hash: null, verdict: null },
      entries: [],
      evaluations: 0,
      skipped: 'no vendored compute kernel for this tool_id',
    };
  }
  const wanted = Array.isArray(pointers) && pointers.length > 0 ? pointers : null;
  const probes = decl.probes || [];
  const selected = wanted ? probes.filter((p) => wanted.includes(p.pointer)) : probes;
  const classify = classifierFor(decl);
  const base = await runClass(compute, policy_parameters, classify);
  const report = {
    profile: HEADROOM_REPORT_PROFILE,
    // kernel_digest stays null here: the worker bundles kernels as modules, not text, so the
    // source digest is stamped by the Node runner (run-headroom.mjs) and not reproducible in the
    // worker isolate. The witness hashes below are the recomputable anchors.
    base: {
      tool_id,
      kernel_digest: null,
      execution_hash: base.payload ? await executionHash(policy_parameters, base.payload) : null,
      verdict: base.payload ? verdictLabel(decl, base.payload) : null,
      class: base.cls,
    },
    entries: [],
    evaluations: 0,
  };
  for (const p of wanted || []) {
    if (!probes.some((d) => d.pointer === p)) {
      report.entries.push({ pointer: p, status: 'skipped', reason: 'no declared probe for this pointer' });
    }
  }
  if (base.cls !== 'positive' && base.cls !== 'negative') {
    report.skipped = `base class ${base.cls}`;
    return report;
  }
  for (const probe of selected) {
    const refused = refusePrivate(probe.pointer, decl.private_inputs);
    if (refused) { report.entries.push({ pointer: probe.pointer, status: 'refused', ...refused }); continue; }
    for (const dir of ['+', '-']) {
      const e = await probeHeadroom({ compute, pp: policy_parameters, probe, dir, classify, base, scanCap });
      report.evaluations += e.evaluations || 0;
      if ((e.status === 'flip' || e.status === 'domain_edge') && e.witness) {
        await attachWitnessHashes(e, compute, policy_parameters, probe, dir, decl, classify);
      }
      report.entries.push(e);
    }
  }
  return report;
}
