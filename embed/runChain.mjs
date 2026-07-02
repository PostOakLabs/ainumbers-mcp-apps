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

// Canonicalizer used only for the §18 compute_proof journal-match guard below.
// Byte-identical to _hash.mjs::cgCanon (re-declared locally to keep this file's
// import surface to the single public executionHash entry point).
const cgCanon = (v) => Array.isArray(v) ? v.map(cgCanon)
  : (v && typeof v === 'object')
    ? Object.keys(v).sort().reduce((o, k) => (o[k] = cgCanon(v[k]), o), {})
    : v;

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
  const results = [];
  let prevHash = null, prevId = null;
  for (let i = 0; i < steps.length; i++) {
    const tid = steps[i];
    const node = nodeById[tid];
    if (!node) { results.push({ order: i + 1, tool_id: tid, status: 'unknown_node' }); continue; }
    if (node.gpu) { results.push({ order: i + 1, tool_id: tid, status: 'gpu_browser_only', browser_url: node.url }); continue; }
    const kernel = getKernel(tid);
    if (!kernel) { results.push({ order: i + 1, tool_id: tid, status: 'no_kernel_browser_only', browser_url: node.url }); continue; }
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
        chain_depth: i,
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
      results.push({ order: i + 1, tool_id: tid, status: 'ok', inputs_source, mandate_type: artifact.mandate_type, execution_hash: artifact.execution_hash, artifact });
      prevHash = artifact.execution_hash; prevId = tid;
    } catch (err) {
      results.push({ order: i + 1, tool_id: tid, status: 'input_required', inputs_source, error: String(err?.message ?? err),
        hint: 'Supply inputs["' + tid + '"] (field names per the node manifest).' });
    }
  }

  const ran = results.filter((r) => r.status === 'ok');
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

  return {
    mode: 'embedded_run_chain', chain: chainName, compute_mode: 'server',
    step_count: steps.length,
    steps_ran: ran.length,
    steps: results.map((r) => ({ order: r.order, tool_id: r.tool_id, status: r.status, inputs_source: r.inputs_source ?? null, execution_hash: r.execution_hash ?? null, error: r.error ?? null, hint: r.hint ?? null })),
    composite_execution_hash: composite_hash,
    composite_artifact,
    spec: 'OpenChainGraph Standard v0.4 §12 (chain-level Compute Binding)',
  };
}

export default runChain;
