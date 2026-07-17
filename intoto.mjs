// intoto.mjs — INTOTO-ACT-1 IA-3 shared logic for the worker's MCP-call link
// recorder. Wraps a run_chain result as in-toto links (one per executed step)
// plus a generated layout matching the chain's topology, DSSE-signed.
//
// This is "in-toto for MCP" per RESEARCH-ACTIVITY-INFRA-2026-07-16 Tier-1 #3:
// materials = the previous step's product digest (execution_hash), products =
// this step's own execution_hash, byproducts = the raw execution_hash again
// (named explicitly, matching the site composer's in-toto Link shape). One
// ephemeral Ed25519 keypair per recorded run (not persisted) signs every link
// in that run plus the generated layout, so the layout's `keys`/`pubkeys`
// stay internally consistent for that bundle — the same session-key model as
// chaingraph/intoto-layout-composer.html and intoto-link-builder.html on the
// site repo. Same DSSE PAE construction, verified byte-identical against the
// securesystemslib reference implementation (see INTOTO-ACT-1 IA-1 board note).
import { rawPubkeyToDidKey } from './kernels/_proof.mjs';
import { cgCanon } from './kernels/_hash.mjs';

function b64encode(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function dssePAE(payloadType, payloadBytes) {
  const enc = new TextEncoder();
  const typeBytes = enc.encode(payloadType);
  const parts = [
    enc.encode('DSSEv1'), enc.encode(' '),
    enc.encode(String(typeBytes.length)), enc.encode(' '), typeBytes, enc.encode(' '),
    enc.encode(String(payloadBytes.length)), enc.encode(' '), payloadBytes,
  ];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

async function dsseSignEnvelope(payloadObj, payloadType, { verificationMethod, privateKey }) {
  const payloadBytes = new TextEncoder().encode(JSON.stringify(payloadObj));
  const pae = dssePAE(payloadType, payloadBytes);
  const sigBytes = new Uint8Array(await crypto.subtle.sign('Ed25519', privateKey, pae));
  return {
    payload: b64encode(payloadBytes),
    payloadType,
    signatures: [{ keyid: verificationMethod, sig: b64encode(sigBytes) }],
  };
}

/**
 * recordChainRunAsLinks(runResult) -> { links, dsse_envelopes, layout, layout_envelope, functionary }
 *
 * runResult: the object returned by the worker's run_chain tool (server/auto
 * compute mode) — specifically its `steps` array (order/tool_id/status/
 * execution_hash) and `chain` name. Only steps with status "ok" become links;
 * everything else (input_required, skipped_by_gate, gpu_browser_only, ...) is
 * reported in `skipped` so the caller can see why a step has no link, rather
 * than the bundle silently going short.
 */
export async function recordChainRunAsLinks(runResult) {
  if (!runResult || typeof runResult !== 'object') throw new Error('runResult must be the object returned by run_chain');
  const chainName = runResult.chain;
  if (!chainName) throw new Error('runResult.chain is required');
  const allSteps = Array.isArray(runResult.steps) ? runResult.steps : [];
  const ranSteps = allSteps.filter((s) => s.status === 'ok');
  const skipped = allSteps.filter((s) => s.status !== 'ok').map((s) => ({ tool_id: s.tool_id, status: s.status }));
  if (ranSteps.length === 0) throw new Error('No successfully-executed steps to record (see skipped[] for why).');

  const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const functionary = await rawPubkeyToDidKey(kp.publicKey);

  const links = [];
  const dsse_envelopes = [];
  let prevToolId = null;
  for (const step of ranSteps) {
    const materials = prevToolId ? { [prevToolId]: { sha256: ranSteps.find((s) => s.tool_id === prevToolId).execution_hash } } : {};
    const link = {
      _type: 'link',
      name: step.tool_id,
      materials: cgCanon(materials),
      products: cgCanon({ [step.tool_id]: { sha256: step.execution_hash } }),
      byproducts: { execution_hash: step.execution_hash },
      environment: { chain: chainName },
      command: [],
    };
    const envelope = await dsseSignEnvelope(link, 'application/vnd.in-toto+json', { verificationMethod: functionary, privateKey: kp.privateKey });
    links.push(link);
    dsse_envelopes.push(envelope);
    prevToolId = step.tool_id;
  }

  // Generated layout mirrors the chain's linear topology: each step after the
  // first MATCHes the previous step's product, same rule vocabulary as the
  // site composer/verifier (MATCH ... WITH PRODUCTS FROM step-name).
  const layoutSteps = ranSteps.map((step, i) => ({
    _type: 'step',
    name: step.tool_id,
    threshold: 1,
    pubkeys: [functionary],
    expected_materials: i === 0 ? [] : [['MATCH', ranSteps[i - 1].tool_id, 'WITH', 'PRODUCTS', 'FROM', ranSteps[i - 1].tool_id]],
    expected_products: [['CREATE', step.tool_id]],
    expected_command: [],
  }));
  const layout = {
    _type: 'layout',
    name: 'mcp-chain-run:' + chainName,
    readme: 'Auto-generated in-toto layout for one recorded run of the "' + chainName + '" ChainGraph chain over the AINumbers MCP worker.',
    expires: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
    keys: [functionary],
    steps: layoutSteps,
    inspect: [],
  };
  const layout_envelope = await dsseSignEnvelope(layout, 'application/vnd.in-toto+json', { verificationMethod: functionary, privateKey: kp.privateKey });

  return {
    chain: chainName,
    functionary,
    step_count: ranSteps.length,
    skipped,
    links,
    dsse_envelopes,
    layout,
    layout_envelope,
    note: 'Ephemeral key, not persisted — this run\'s functionary identity is scoped to this bundle only, matching the site composer/link-builder session-key model.',
  };
}
