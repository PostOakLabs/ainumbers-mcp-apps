// errata-check-tool.mjs -- the errata_check utility tool (KERNEL-ERRATA-MCP-1).
//
// Agent-facing mirror of the site verify pages' errata line (KERNEL-ERRATA-READER-1):
// an agent holding a receipt can ask whether a published kernel erratum affects it, the
// same question errata.html answers for a person. Both surfaces run the SAME vendored
// reader (./errata/errata-check.mjs) over the SAME generated page-load snapshot
// (./errata/errata-snapshot.mjs), so a receipt that classifies one way here classifies
// the same way in the browser, and the fixed digest + tree size reported here are the
// log's own recorded values, not a worker-side copy.
//
// Verdict contract (BUILD-SPEC §3): exactly three verdict states, NOT-LISTED,
// LISTED-UNAFFECTED, LISTED-AFFECTED. The vendored reader also returns three honest
// non-verdict outcomes so the tool never has to guess: NOT-ENGAGED (the input carries no
// module digest at all), STALE (past the checkpoint's expires_at; the answer is the log's
// own staleness sentence, verbatim), LISTED-INPUTS-NEEDED (an erratum names the digest
// but the receipt carries no policy_parameters, so the affected region cannot be
// evaluated here). All three pass through unchanged with state set accordingly.
//
// Posture: the errata log is optional due diligence and never a verification step. This
// tool does NOT verify the receipt's hash or signature — pair it with
// verify_execution_hash for integrity. Zero network egress.
//
// Wiring (see README.md): worker.mjs imports { registerErrataCheck } and calls it once
// among the utility tools inside buildServer, passing (server, z, { requestId });
// utility-tools.mjs carries the name (the SSOT the collision gate and counts read);
// generate.mjs vendors both module files from the site repo into data/errata/ (ASSETS)
// and ./errata/ (Worker bundle) — re-run generate.mjs after any site errata merge.

import { ERRATA_SNAPSHOT } from './errata/errata-snapshot.mjs';
import { errataCheck, errataSentence, extractKernelDigest, extractPolicyParameters } from './errata/errata-check.mjs';
import { toolErrorResult } from './errors.mjs';

// The MCP tool name — must stay unique across nodes + PILOT widgets + utility tools
// (CONTRACT §A4.1 / check-tool-names.mjs). Also listed in utility-tools.mjs.
export const ERRATA_CHECK_TOOL_NAME = 'errata_check';

/**
 * Pure classifier: one receipt against the vendored errata snapshot.
 * Returns { ok:false, error } for a non-object input, else { ok:true, ...result fields }.
 * nowMs: the caller's clock in epoch ms (the tool layer passes nothing and the vendored
 * reader contract's nowMs defaults to Date.now() here; tests plant a fixed moment).
 * @param {object} p
 * @param {object} p.receipt   full artifact envelope or receipt-shaped object (REQUIRED)
 * @param {number} [p.nowMs]   caller clock override (epoch ms); defaults to Date.now()
 */
export function runErrataCheck({ receipt, nowMs } = {}) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    return { ok: false, error: 'A receipt object is required: pass the full artifact envelope (policy_parameters + output_payload + execution_hash) or a receipt-shaped object carrying kernel_digest (top level or under journal).' };
  }
  const digest = extractKernelDigest(receipt);
  const policyParameters = extractPolicyParameters(receipt);
  const result = errataCheck(ERRATA_SNAPSHOT, { kernelDigest: digest, policyParameters }, nowMs === undefined ? Date.now() : nowMs);
  const cp = ERRATA_SNAPSHOT.checkpoint ?? {};
  const out = {
    ok: true,
    state: result.state,
    kernel_digest_checked: digest,
    erratum_id: result.entry?.id ?? null,
    erratum_class: result.entry?.class ?? null,
    kernel_digest_fixed: result.fixedDigest ?? null,
    published_at: result.entry?.published_at ?? null,
    tree_size: typeof cp.tree_size === 'number' ? cp.tree_size : null,
    checkpoint_origin: cp.origin ?? null,
    defect_summary: result.entry?.summary ?? null,
    sentence: result.state === 'NOT-ENGAGED'
      ? 'The receipt carries no module digest, so no erratum can be checked for it. Pass the full artifact envelope (policy_parameters + output_payload + execution_hash) or an object carrying kernel_digest.'
      : errataSentence(result),
  };
  return out;
}

/**
 * Register the errata_check tool on an MCP server.
 * @param {object} server      the McpServer instance (same one the utility tools use)
 * @param {object} z           zod, already imported in worker.mjs
 * @param {object} [opts]
 * @param {string|null} [opts.requestId]  the per-request correlation id (errors.mjs envelope)
 */
export function registerErrataCheck(server, z, opts = {}) {
  const { requestId } = opts;
  server.registerTool(ERRATA_CHECK_TOOL_NAME, {
    title: 'Check a receipt against the public kernel-errata log',
    description:
      'Look up a held receipt in the public kernel-errata log (the registry/errata transparency log) and report whether a published erratum affects it. ' +
      'Returns one of three verdict states with the erratum id, the fixed kernel digest and the tree size the answer was checked against: ' +
      'NOT-LISTED (no erratum names this kernel digest), LISTED-UNAFFECTED (an erratum names the digest; these inputs sit outside the affected region), ' +
      'LISTED-AFFECTED (an erratum names the digest; these inputs fall in the affected region: re-run the receipt on the fixed kernel). ' +
      'Data-flow honesty: the worker sees the receipt you send -- it is processed transiently to produce this answer and is never stored or logged; ' +
      'if you prefer that no server sees the receipt at all, the equivalent check runs in the browser: the errata page path (errata.html and the verify pages) ships the same log snapshot with the page and needs no server. ' +
      'Accepts a full artifact envelope or a receipt-shaped object carrying kernel_digest, with policy_parameters at the top level or under journal. ' +
      'This tool does NOT verify the receipt itself and never revokes anything -- pair it with verify_execution_hash for integrity; the log is optional due diligence. Zero network egress.',
    inputSchema: {
      receipt: z.record(z.any()).describe('The receipt or full artifact envelope to check: a v0.4 artifact (policy_parameters + output_payload + execution_hash) or any object carrying kernel_digest (top level or under journal) plus optional policy_parameters for the affected-region evaluation.'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ receipt }) => {
    const result = runErrataCheck({ receipt });
    if (!result.ok) return toolErrorResult('tool.invalid_args.errata_receipt', { requestId, text: result.error });
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], structuredContent: result };
  });
}
