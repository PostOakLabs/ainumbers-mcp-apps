// OCGR embedded runner — runChain (OpenChainGraph Runtime, Phase D).
//
// Mirrors the Cloudflare Worker's run_chain (mcp-apps-poc/worker.mjs) server path
// BYTE-FOR-BYTE so the same chain + inputs yields the same composite execution_hash
// inside a regulated firm's own walls: zero egress, zero PII, zero network, no API.
//
// It does NOT re-implement any compute or hash. It loops the SAME deterministic
// kernels (getKernel().buildArtifact) and hashes with the SAME canonical §4 path
// (executionHash from ./lib/_hash.mjs). The only thing this file adds is the
// standalone loop that threads step N's execution_hash into step N+1's parent_hashes
// and folds the step outputs into ONE composite artifact — identical to the Worker.
//
// Dependencies are injectable so the runner is testable and portable:
//   - getKernel:   the deterministic kernel registry (default: ../kernels/index.mjs).
//   - chaingraph:  the node/chain catalog       (default: ../data/chaingraph/chaingraph.json).
//   - fixtures:    representative per-step inputs (default: ../data/chain-fixtures.json).
// A firm that vendors kernels/ + data/ alongside this file gets an identical result;
// see README.md "Packaging a standalone distributable".

import { executionHash } from './lib/_hash.mjs';
import { evaluateGate as gvEvaluateGate, stepId as gvStepId } from './lib/_gateval.mjs';

// Canonicalizer used for the §18 compute_proof journal-match guard and the
// §21.4 route_plan_digest below. Byte-identical to _hash.mjs::cgCanon
// (re-declared locally to keep this file's import surface to the single public
// executionHash entry point).
const cgCanon = (v) => Array.isArray(v) ? v.map(cgCanon)
  : (v && typeof v === 'object')
    ? Object.keys(v).sort().reduce((o, k) => (o[k] = cgCanon(v[k]), o), {})
    : v;
// OCG §21.4 route_plan_digest — bare-hex SHA-256 over the JCS-canonical chain
// steps[] definition. Same canonicalizer as §4; mirrors worker.mjs cgSha256Hex.
async function cgSha256Hex(obj) {
  const buf = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(cgCanon(obj))));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Lazily load the worker repo's kernels + catalog + fixtures when the caller does
// not inject them. Kept out of module top-level so the verifier surface (verify.mjs)
// can be imported with ZERO filesystem/kernel dependencies.
async function loadDefaults() {
  const { getKernel } = await import('../kernels/index.mjs');
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const here = fileURLToPath(new URL('.', import.meta.url));
  const rd = (rel) => JSON.parse(readFileSync(here + rel, 'utf8'));
  return {
    getKernel,
    chaingraph: rd('../data/chaingraph/chaingraph.json'),
    fixtures: rd('../data/chain-fixtures.json'),
  };
}

/**
 * runChain(chainNameOrConfig, inputs?, deps?) -> the same structured result the Worker's
 * run_chain returns for compute:"server": per-step statuses, the composite artifact, and
 * composite_execution_hash. Deterministic; no network; no PII logging.
 *
 * @param {string|object} chainNameOrConfig  Chain name (resolved against the catalog) OR an
 *   inline chain config { name, title?, steps:[{ tool_id }] }.
 * @param {object} [inputs]  Map of step tool_id -> policy_parameters overrides. Omitted steps
 *   fall back to the vendored fixture, else {} (kernels needing required fields are reported
 *   per-step as status:"input_required", never failed silently — same as the Worker).
 * @param {object} [deps]  { getKernel, chaingraph, fixtures } — injected for tests/portability.
 */
export async function runChain(chainNameOrConfig, inputs = undefined, deps = undefined) {
  const d = deps ?? await loadDefaults();
  const { getKernel } = d;
  const chaingraph = d.chaingraph;
  const fixtures = d.fixtures ?? {};

  // Resolve the chain: inline config OR a name against the catalog.
  let chainMeta, chainName;
  if (chainNameOrConfig && typeof chainNameOrConfig === 'object') {
    chainMeta = chainNameOrConfig;
    chainName = chainMeta.name ?? '(inline)';
  } else {
    chainName = String(chainNameOrConfig);
    chainMeta = (chaingraph?.chains ?? []).find((c) => c.name === chainName);
    if (!chainMeta) throw new Error(`Unknown chain "${chainName}". List names in chaingraph.chains[].name.`);
  }
  const nodeById = {};
  for (const n of (chaingraph?.nodes ?? [])) nodeById[n.tool_id] = n;

  const steps = (chainMeta.steps ?? []).map((s) => s.tool_id);
  if (!steps.length) throw new Error(`Chain "${chainName}" has no steps.`);

  // --- run each kernel-backed step, threading parent hashes (mirrors worker.mjs) ---
  // OCG §21: linear array order unless a step carries a decision `gate` (§21.4) that
  // routes control FORWARD. Skipped steps get status "skipped_by_gate". A chain with no
  // gate is pure linear and its composite_execution_hash is UNCHANGED — every §21.4
  // composite key is conditional-presence. Byte-for-byte identical to worker.mjs.
  const chainSteps = chainMeta.steps ?? [];
  const hasGates = chainSteps.some((s) => s && s.gate);
  const idToIndex = {};
  chainSteps.forEach((s, i) => { idToIndex[gvStepId(s, i)] = i; });

  const results = new Array(chainSteps.length).fill(null);
  const decisions = [];
  const path_taken = [];
  let prevHash = null, prevId = null;
  let idx = 0;
  while (idx < chainSteps.length) {
    const step = chainSteps[idx];
    const tid = steps[idx];
    const node = nodeById[tid];
    let ranArtifact = null;
    if (!node) { results[idx] = { order: idx + 1, tool_id: tid, status: 'unknown_node' }; }
    else if (node.gpu) { results[idx] = { order: idx + 1, tool_id: tid, status: 'gpu_browser_only', browser_url: node.url }; }
    else {
      const kernel = getKernel(tid);
      if (!kernel) { results[idx] = { order: idx + 1, tool_id: tid, status: 'no_kernel_browser_only', browser_url: node.url }; }
      else {
        const callerPp = inputs?.[tid];
        const fixturePp = fixtures?.[chainName]?.[tid];
        const pp = callerPp ?? fixturePp ?? {};
        const inputs_source = callerPp !== undefined ? 'caller' : (fixturePp !== undefined ? 'fixture' : 'none');
        try {
          // Determinism: `now` never enters the composite preimage (per-step timestamps/mandate_ids
          // are excluded below), so a fixed value keeps the run reproducible. The Worker passes the
          // wall clock here; the composite hash is identical either way.
          const now = '1970-01-01T00:00:00.000Z';
          const artifact = await kernel.buildArtifact(pp, {
            now,
            parent_hashes: prevHash ? [prevHash] : [],
            parent_tool_ids: prevId ? [prevId] : [],
            chain_depth: idx,
          });
          // §17 build_identity (advisory — which SOURCE ran; hash-excluded). Mirror worker.mjs.
          const srcImg = Array.isArray(node.compute_images) && node.compute_images.find((im) => im.system === 'sha256-source');
          if (srcImg && srcImg.image_id) {
            artifact.audit_signature = { ...(artifact.audit_signature || {}), build_identity: {
              kernel_digest: srcImg.image_id,
              buildType: 'https://ainumbers.co/chaingraph/context/v0.2#WebCryptoSHA256',
              source_ref: 'kernels/' + node.tool_id + '.kernel.mjs',
            } };
          }
          // §18 compute_proof — attach iff the receipt is about THIS exact output (hash-excluded).
          if (node.compute_proof && node.compute_proof.journal
              && JSON.stringify(cgCanon(node.compute_proof.journal.output)) === JSON.stringify(cgCanon(artifact.output_payload))) {
            artifact.audit_signature = { ...(artifact.audit_signature || {}), compute_proof: node.compute_proof };
          }
          results[idx] = { order: idx + 1, tool_id: tid, status: 'ok', inputs_source, mandate_type: artifact.mandate_type, execution_hash: artifact.execution_hash, artifact };
          prevHash = artifact.execution_hash; prevId = tid;
          ranArtifact = artifact;
        } catch (err) {
          results[idx] = { order: idx + 1, tool_id: tid, status: 'input_required', inputs_source, error: String(err?.message ?? err),
            hint: 'Supply inputs["' + tid + '"] (field names per the node manifest).' };
        }
      }
    }
    if (results[idx].status === 'ok') path_taken.push(gvStepId(step, idx));
    // §21.4 decision gate — evaluate ONLY when the step produced output; route forward.
    if (hasGates && step && step.gate && ranArtifact) {
      const dec = { step_id: gvStepId(step, idx), ...gvEvaluateGate(step.gate, ranArtifact.output_payload) };
      decisions.push(dec);
      let target;
      if (dec.next === 'end') target = chainSteps.length;
      else { target = idToIndex[dec.next]; if (target === undefined || target <= idx) target = idx + 1; }
      for (let j = idx + 1; j < target && j < chainSteps.length; j++) {
        if (results[j] === null) results[j] = { order: j + 1, tool_id: steps[j], status: 'skipped_by_gate' };
      }
      idx = target;
      continue;
    }
    idx++;
  }
  const resultsList = results.filter((r) => r !== null);

  const ran = resultsList.filter((r) => r.status === 'ok');
  // Composite preimage: ONLY mandate_type + execution_hash + output_payload per step
  // (per-step timestamps / mandate_ids excluded) — reproducible. Identical to worker.mjs.
  const composite_policy = {
    compute_mode: 'server',
    chain: chainName,
    chain_title: chainMeta.title ?? chainName,
    step_count: ran.length,
    step_tool_ids: ran.map((r) => r.tool_id),
  };
  const composite_output = {
    chain: chainName,
    steps: ran.map((r) => ({ tool_id: r.tool_id, mandate_type: r.mandate_type, execution_hash: r.execution_hash, output_payload: r.artifact.output_payload })),
  };
  // §21.4 conditional-presence: gate metadata enters the preimage ONLY for chains that
  // define >=1 gate, so every linear chain's composite_execution_hash stays frozen.
  if (hasGates) {
    composite_policy.route_plan_digest = await cgSha256Hex(chainSteps);
    composite_output.decisions = decisions;
    composite_output.path_taken = path_taken;
  }
  const composite_hash = ran.length ? await executionHash(composite_policy, composite_output) : null;
  const composite_artifact = ran.length ? {
    '@context': 'https://ainumbers.co/chaingraph/context/v0.3/context.jsonld',
    chaingraph_version: '0.4.0',
    compute_mode: 'server',
    mandate_type: 'compliance_mandate',
    tool_id: 'chaingraph/chains/' + chainName,
    tool_version: '1.0.0',
    execution_hash: composite_hash,
    chain: {
      parent_hashes: ran.map((r) => r.execution_hash),
      parent_tool_ids: ran.map((r) => r.tool_id),
      chain_depth: ran.length,
    },
    policy_parameters: composite_policy,
    output_payload: composite_output,
    compliance_flags: [],
    audit_signature: { server_side_executed: true, zero_pii_verified: true, deterministic_run: true },
  } : null;

  const out = {
    mode: 'embedded_run_chain', chain: chainName, compute_mode: 'server',
    step_count: chainSteps.length,
    steps_ran: ran.length,
    steps: resultsList.map((r) => ({ order: r.order, tool_id: r.tool_id, status: r.status, inputs_source: r.inputs_source ?? null, execution_hash: r.execution_hash ?? null, error: r.error ?? null, hint: r.hint ?? null })),
    composite_execution_hash: composite_hash,
    composite_artifact,
    spec: hasGates
      ? 'OpenChainGraph Standard v0.8 §21 Chain Execution (decision gates)'
      : 'OpenChainGraph Standard v0.4 §12 (chain-level Compute Binding)',
  };
  if (hasGates) { out.route_plan_digest = composite_policy.route_plan_digest; out.decisions = decisions; out.path_taken = path_taken; }
  return out;
}

export default runChain;
