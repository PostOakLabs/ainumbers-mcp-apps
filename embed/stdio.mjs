// AINumbers local stdio MCP server over the embed package (MCPB-LOCAL-SERVER-1).
//
// Hand-written JSON-RPC 2.0 over newline-delimited stdin/stdout (MCP stdio transport): initialize,
// ping, tools/list, tools/call. Node builtins only, zero dependencies, zero network. Needs no
// AINumbers server; the host model still sees tool inputs and outputs.
//
//   node embed/stdio.mjs        (from the mcp-apps-poc/ repo root, or anywhere: paths are file-relative)
//
// Tools: one per chaingraph node, named by the node's mcp_name (identical to the remote worker),
// plus run_chain. A gpu:true node, a node without a kernel, or compute:"browser" returns a clear
// status:"needs_remote_worker" result with NO execution_hash: never a computed answer the remote
// worker would not have given. Server-compute path mirrors worker.mjs "Compute Binding" byte for
// byte (null-member normalisation, buildArtifact, hash round-trip, build_identity, compute_proof).
//
// stdout carries ONLY JSON-RPC messages; logs go to stderr.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { getKernel } from '../kernels/index.mjs';
import { executionHash, jcsStringify } from '../kernels/_hash.mjs';
import { normalizeNullMembers } from '../_null_normalize.mjs';
import { runChain } from './runChain.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const rd = (rel) => JSON.parse(readFileSync(here + rel, 'utf8'));

const SERVER_INFO = { name: 'ainumbers-local', version: '0.1.0' };
const SUPPORTED_PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const REMOTE_ENDPOINT = 'https://mcp.ainumbers.co/mcp';
const RUN_CHAIN = 'run_chain';

const chaingraph = rd('../data/chaingraph/chaingraph.json');
const fixtures = rd('../data/chain-fixtures.json');
let nullExemptions = {};
try { nullExemptions = rd('../data/mcp/null-exemptions.json'); } catch { /* optional registry */ }

const nodes = (chaingraph.nodes ?? []).filter((n) => n && n.mcp_name);
const nodeByName = new Map(nodes.map((n) => [n.mcp_name, n]));

const NODE_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    policy_parameters: { type: 'object', additionalProperties: true, description: 'Input parameters for this tool\'s decision function.' },
    compute: { type: 'string', enum: ['auto', 'server', 'browser'], description: '"auto"/"server" compute locally for gpu:false nodes; "browser" returns the browser URL instead.' },
    parent_hashes: { type: 'array', items: { type: 'string' }, description: 'execution_hash values of upstream artifacts to chain from.' },
    parent_tool_ids: { type: 'array', items: { type: 'string' }, description: 'tool_id values matching parent_hashes, same order.' },
  },
};
const RUN_CHAIN_SCHEMA = {
  type: 'object',
  properties: {
    chain: { type: 'string', description: 'Chain name from the catalog (chaingraph.chains[].name).' },
    inputs: { type: 'object', additionalProperties: { type: 'object' }, description: 'Map of step tool_id -> policy_parameters; omitted steps use the shipped fixture.' },
  },
  required: ['chain'],
};

function toolList() {
  const list = nodes.map((n) => ({
    name: n.mcp_name,
    title: n.display_name,
    description: n.display_name + ': OpenChainGraph compute node (' + n.mandate_type + '). ' +
      (n.gpu ? 'gpu:true node: needs the remote worker or the browser, not computed locally. '
             : 'Computed locally, deterministic, no network. ') +
      'Use synthetic or anonymised inputs only. Open at: ' + n.url,
    inputSchema: NODE_INPUT_SCHEMA,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }));
  list.push({
    name: RUN_CHAIN,
    title: 'Run a ChainGraph chain locally',
    description: 'Runs a named chain step by step with threaded parent hashes and returns the composite execution hash. gpu:true steps report gpu_browser_only.',
    inputSchema: RUN_CHAIN_SCHEMA,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  });
  return list;
}

const ok = (structured) => ({ content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }], structuredContent: structured });
const err = (text) => ({ isError: true, content: [{ type: 'text', text }] });

function needsRemote(node, reason, extra = {}) {
  return ok({
    status: 'needs_remote_worker',
    tool_id: node.tool_id,
    mcp_name: node.mcp_name,
    gpu: !!node.gpu,
    reason,
    browser_url: node.url ?? null,
    remote_endpoint: REMOTE_ENDPOINT,
    note: 'Not computed locally; no execution_hash was produced. Call this tool on the remote worker or open browser_url.',
    ...extra,
  });
}

// Mirrors worker.mjs per-node server compute (Compute Binding v0.4).
export async function callNode(node, args) {
  const { policy_parameters, compute, parent_hashes, parent_tool_ids } = args ?? {};
  const effective = compute ?? 'auto';
  if (node.gpu) return needsRemote(node, 'gpu:true node: compute stays in the browser GPU lane (ChainGraph Standard v0.1 section 9.2).');
  if (effective === 'browser') return needsRemote(node, 'compute:"browser" requested.');
  const kernel = getKernel(node.tool_id);
  if (!kernel) return needsRemote(node, 'no kernel is registered for this node.');
  if (!policy_parameters || typeof policy_parameters !== 'object' || Array.isArray(policy_parameters)) {
    return ok({ status: 'inputs_required', tool_id: node.tool_id, mcp_name: node.mcp_name, browser_url: node.url ?? null,
      hint: 'Pass policy_parameters (an object) to compute locally.' });
  }
  try {
    const pp = normalizeNullMembers(policy_parameters, nullExemptions?.[node.tool_id] ?? null);
    const artifact = await kernel.buildArtifact(pp, {
      now: new Date().toISOString(),
      parent_hashes: parent_hashes ?? [],
      parent_tool_ids: parent_tool_ids ?? [],
      chain_depth: node.chain_depth ?? 0,
    });
    const computed_hash = await executionHash(artifact.policy_parameters, artifact.output_payload);
    const hash_valid = computed_hash === artifact.execution_hash;
    const srcImg = Array.isArray(node.compute_images) && node.compute_images.find((i) => i.system === 'sha256-source');
    if (srcImg && srcImg.image_id) {
      artifact.audit_signature = { ...(artifact.audit_signature || {}), build_identity: {
        kernel_digest: srcImg.image_id,
        buildType: 'https://ainumbers.co/chaingraph/context/v0.2#WebCryptoSHA256',
        source_ref: 'kernels/' + node.tool_id + '.kernel.mjs',
      } };
    }
    if (node.compute_proof && node.compute_proof.journal) {
      if (jcsStringify(node.compute_proof.journal.output) === jcsStringify(artifact.output_payload)) {
        artifact.audit_signature = { ...(artifact.audit_signature || {}), compute_proof: node.compute_proof };
        artifact.compute_proof_ready = 'ready';
        delete artifact.deferred_reason;
      } else {
        artifact.compute_proof_ready = 'deferred';
        artifact.deferred_reason = 'a compute_proof exists for this kernel but its journal.output does not match this input\'s output_payload -- the receipt attests a different output';
      }
    }
    return ok({ compute_mode: 'local', hash_valid, computed_hash, artifact,
      note: 'Kernel computed locally. Pass artifact.execution_hash as parent_hashes to downstream tools.' });
  } catch (e) {
    return err('Kernel compute error: ' + String(e?.message ?? e));
  }
}

async function callTool(name, args) {
  if (name === RUN_CHAIN) {
    if (!args || typeof args.chain !== 'string') return err('run_chain requires { chain: string }.');
    try {
      return ok(await runChain(args.chain, args.inputs, { getKernel, chaingraph, fixtures }));
    } catch (e) {
      return err(String(e?.message ?? e));
    }
  }
  const node = nodeByName.get(name);
  if (!node) return null; // unknown tool -> protocol error
  return callNode(node, args);
}

async function handle(msg) {
  const { id, method, params } = msg;
  switch (method) {
    case 'initialize': {
      const want = params?.protocolVersion;
      return { protocolVersion: SUPPORTED_PROTOCOLS.includes(want) ? want : SUPPORTED_PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO,
        instructions: 'AINumbers tools computed locally; needs no AINumbers server. gpu:true nodes return needs_remote_worker.' };
    }
    case 'ping': return {};
    case 'tools/list': return { tools: toolList() };
    case 'tools/call': {
      if (typeof params?.name !== 'string') throw rpcError(-32602, 'tools/call requires params.name');
      const r = await callTool(params.name, params.arguments);
      if (r === null) throw rpcError(-32602, 'Unknown tool: ' + params.name);
      return r;
    }
    default: throw rpcError(-32601, 'Method not found: ' + method);
  }
}

function rpcError(code, message) { const e = new Error(message); e.rpcCode = code; return e; }

function main() {
  const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
  let chain = Promise.resolve(); // sequential: responses leave in request order
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    chain = chain.then(async () => {
      let msg;
      try { msg = JSON.parse(line); } catch { return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
      if (!msg || Array.isArray(msg) || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
        if (msg && typeof msg === 'object' && !Array.isArray(msg) && msg.method === undefined && ('result' in msg || 'error' in msg)) return; // stray response
        return send({ jsonrpc: '2.0', id: msg?.id ?? null, error: { code: -32600, message: 'Invalid Request' } });
      }
      const isNotification = msg.id === undefined;
      try {
        const result = await handle(msg);
        if (!isNotification) send({ jsonrpc: '2.0', id: msg.id, result });
      } catch (e) {
        if (isNotification) return;
        send({ jsonrpc: '2.0', id: msg.id, error: { code: e.rpcCode ?? -32603, message: String(e?.message ?? e) } });
      }
    });
  });
  rl.on('close', () => { chain.then(() => process.exit(0)); });
}

// Run the loop only when executed directly, so the selftest can import callNode.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
