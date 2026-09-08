#!/usr/bin/env node
// check-delegation-reason.mjs — WORKER-DELEGATION-REASON-1.
//
// WHY: a node tool's browser-delegation branch is reached for FOUR distinct causes — no
// policy_parameters, an explicit compute:"browser", a gpu:true node, or genuinely no registered
// kernel — and it emitted ONE sentence for three of them: "No kernel registered for this node
// yet." A live probe of ALL 644 live non-GPU nodes found ZERO with a missing kernel, so on the
// non-GPU estate that sentence was false in 100% of the cases an agent can actually hit. An
// external agent read it, believed it, and published a (since retracted) report asserting a
// missing wave-1 kernel that does not exist. `instruction` is a machine-readable field an agent
// acts on: the worker handed an agent a false fact about the product.
//
// Paired defect (D2): every field of the node input schema is optional, so zod STRIPS unknown
// top-level keys — a FLAT call (fields at the top level instead of nested under
// policy_parameters) validates, arrives with policy_parameters undefined, and silently degrades
// to delegation instead of telling the caller its arguments were discarded.
//
// WHAT THIS ASSERTS (all offline — drives the real worker.mjs default export against a local
// ASSETS stub backed by the committed ./data tree; no network, no deployed worker):
//   A. unit    — delegationReason() returns a DISTINCT reason token AND a DISTINCT instruction
//                for each of the four causes, and only the genuinely-kernel-less one is allowed
//                to say "No kernel registered". This is the branch no live node can reach, which
//                is exactly why it is exercised through the pure function.
//   B. e2e     — a real tools/call for each REACHABLE cause carries the matching
//                delegation_reason, and a missing-inputs call no longer claims a missing kernel.
//   C. negative— a flat-arguments call returns a tool ERROR naming policy_parameters.
//   D. control — a call with NO arguments at all still delegates (absence of arguments is not
//                wrong-shaped arguments).
//   E. regression — a correctly-nested call is unchanged and still computes server-side with an
//                execution_hash.
//
// SO #34c (a gate only ever observed green has not been observed): this gate goes RED against
// pre-change worker.mjs — every assertion in A fails there because three of the four causes
// produce byte-identical instructions. The failing output is quoted in the PR body.
//
// Usage: node scripts/check-delegation-reason.mjs

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const DATA_DIR = join(ROOT, 'data');

const { delegationReason, buildServer, loadData } = await import('../worker.mjs');
const { getKernel } = await import('../kernels/index.mjs');

const env = {
  ASSETS: {
    fetch: async (url) => {
      const u = new URL(typeof url === 'string' ? url : url.url);
      const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '');
      const filePath = join(DATA_DIR, rel);
      if (!existsSync(filePath)) return new Response('Not Found', { status: 404 });
      return new Response(readFileSync(filePath), { status: 200 });
    },
  },
};

const failures = [];
function check(ok, label, detail) {
  if (ok) { console.log(`  ✓ ${label}`); return; }
  console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`);
  failures.push(label + (detail ? ' — ' + detail : ''));
}

// ── A. unit: all four causes, including the one no live node can reach ────────────────────────
console.log('\nA. delegationReason() — four causes, four answers');

if (typeof delegationReason !== 'function') {
  console.error('✗ worker.mjs does not export delegationReason() — the four causes are not separable.');
  process.exit(1);
}

const cases = [
  { name: 'gpu node',                 args: { gpu: true,  compute: 'auto',    hasPolicyParameters: true,  hasKernel: false }, reason: 'gpu_node' },
  { name: 'compute:"browser"',        args: { gpu: false, compute: 'browser', hasPolicyParameters: true,  hasKernel: true  }, reason: 'browser_requested' },
  { name: 'no policy_parameters',     args: { gpu: false, compute: 'auto',    hasPolicyParameters: false, hasKernel: true  }, reason: 'missing_policy_parameters' },
  { name: 'no registered kernel',     args: { gpu: false, compute: 'auto',    hasPolicyParameters: true,  hasKernel: false }, reason: 'no_kernel_registered' },
];

const seenInstructions = new Map();
for (const c of cases) {
  const got = delegationReason(c.args);
  check(got && got.reason === c.reason, `${c.name} → reason "${c.reason}"`, got ? `got "${got.reason}"` : 'no result');
  check(!!(got && typeof got.instruction === 'string' && got.instruction.length > 40),
    `${c.name} → carries an instruction`, got ? JSON.stringify(got.instruction) : 'no result');
  if (got && got.instruction) {
    if (seenInstructions.has(got.instruction)) {
      check(false, `${c.name} → instruction is DISTINCT`,
        `identical to the "${seenInstructions.get(got.instruction)}" instruction: ${JSON.stringify(got.instruction.slice(0, 90))}…`);
    } else {
      seenInstructions.set(got.instruction, c.name);
      check(true, `${c.name} → instruction is DISTINCT`);
    }
  }
}

// The false-fact assertion: only the genuinely-kernel-less cause may claim a missing kernel.
for (const c of cases) {
  const got = delegationReason(c.args) || {};
  const claimsMissingKernel = /no kernel registered/i.test(String(got.instruction ?? ''));
  const mayClaim = c.reason === 'no_kernel_registered' || c.args.hasKernel === false;
  check(!claimsMissingKernel || mayClaim,
    `${c.name} → does not falsely assert a missing kernel`,
    JSON.stringify(String(got.instruction ?? '').slice(0, 120)));
}
check(/no kernel registered/i.test(delegationReason(cases[3].args).instruction),
  'the genuinely-kernel-less cause DOES say so');

// ── pick real nodes out of the vendored graph ─────────────────────────────────────────────────
const cg = JSON.parse(readFileSync(join(DATA_DIR, 'chaingraph', 'chaingraph.json'), 'utf8'));
const live = (cg.nodes ?? []).filter((n) => n.status === 'live');
const byToolId = new Map(live.map((n) => [n.tool_id, n]));

// Deterministic, never hard-coded to one node id: the first live gpu:false node WITH a kernel for
// which the vendored chain-fixtures carry real inputs, in sorted order.
const fixtures = JSON.parse(readFileSync(join(DATA_DIR, 'chain-fixtures.json'), 'utf8'));
let computeNode = null, computeParams = null;
outer:
for (const chain of Object.keys(fixtures).sort()) {
  for (const toolId of Object.keys(fixtures[chain]).sort()) {
    const n = byToolId.get(toolId);
    if (n && !n.gpu && n.mcp_name && getKernel(toolId)) {
      computeNode = n; computeParams = fixtures[chain][toolId]; break outer;
    }
  }
}
const gpuNode = live.filter((n) => n.gpu && n.mcp_name).sort((a, b) => a.tool_id.localeCompare(b.tool_id))[0] ?? null;

if (!computeNode) { console.error('✗ no live gpu:false node with a kernel AND a vendored fixture — cannot drive the e2e cases.'); process.exit(1); }
if (!gpuNode)     { console.error('✗ no live gpu:true node in the vendored graph — cannot drive the gpu case.'); process.exit(1); }

// A real tools/call over the SDK — the zod validation that STRIPS unknown keys is the whole point
// of the D2 assertions, so the call must go through the registered schema, not around it. Driven
// in-process over an in-memory transport rather than worker.fetch(): fetch-to-node's
// toReqRes/StreamableHTTPServerTransport pair returns an empty HTTP 400 under plain Node for any
// real-args tools/call, with or without this change (a harness limitation already documented in
// scripts/gate-mcp-era.mjs). `mrtr.args` is handed the same arguments object the client sends —
// exactly what the /mcp handler does at the tools/call dispatch (`args: body?.params?.arguments`).
const data = await loadData(env);
async function callTool(name, args) {
  const server = buildServer(data, {
    onlyTool: name,
    mrtr: { env, args, requestState: null, inputResponses: null, clientCaps: null, principal: 'delegation-reason-gate' },
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'delegation-reason-gate', version: '1.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    return await client.callTool({ name, arguments: args });
  } catch (e) {
    return { _rpcError: String(e?.message ?? e) };
  } finally {
    await client.close();
  }
}
function textOf(result) {
  return (result?.content ?? []).filter((c) => c?.type === 'text').map((c) => c.text).join('\n');
}

// ── B. e2e: each reachable cause reports itself ───────────────────────────────────────────────
console.log(`\nB. live tools/call — reachable causes (compute node: ${computeNode.mcp_name}, gpu node: ${gpuNode.mcp_name})`);

const missing = await callTool(computeNode.mcp_name, { compute: 'auto' });
check(missing?.structuredContent?.delegation_reason === 'missing_policy_parameters',
  'no policy_parameters → delegation_reason "missing_policy_parameters"',
  JSON.stringify(missing?.structuredContent?.delegation_reason ?? missing?._rpcError));
check(!/no kernel registered/i.test(String(missing?.structuredContent?.instruction ?? '')),
  'no policy_parameters → instruction does NOT claim a missing kernel',
  JSON.stringify(String(missing?.structuredContent?.instruction ?? '').slice(0, 140)));
check(/policy_parameters/.test(textOf(missing)),
  'no policy_parameters → the TEXT half names policy_parameters too');

const browser = await callTool(computeNode.mcp_name, { compute: 'browser', policy_parameters: computeParams });
check(browser?.structuredContent?.delegation_reason === 'browser_requested',
  'compute:"browser" → delegation_reason "browser_requested"',
  JSON.stringify(browser?.structuredContent?.delegation_reason ?? browser?._rpcError));
check(!/no kernel registered/i.test(String(browser?.structuredContent?.instruction ?? '')),
  'compute:"browser" → instruction does NOT claim a missing kernel',
  JSON.stringify(String(browser?.structuredContent?.instruction ?? '').slice(0, 140)));

const gpu = await callTool(gpuNode.mcp_name, { policy_parameters: {} });
check(gpu?.structuredContent?.delegation_reason === 'gpu_node',
  'gpu:true node → delegation_reason "gpu_node"',
  JSON.stringify(gpu?.structuredContent?.delegation_reason ?? gpu?._rpcError));
check(/§9\.2/.test(String(gpu?.structuredContent?.instruction ?? '')),
  'gpu:true node → keeps the SPEC §9.2 sentence (unchanged surface)');

// ── C. negative: a flat call is refused, not silently degraded ────────────────────────────────
console.log('\nC. flat arguments (defect D2) — refused with a message naming the wrapper');

const flatKeys = Object.keys(computeParams);
const flat = await callTool(computeNode.mcp_name, computeParams);
check(flat?.isError === true, 'flat arguments → tool error', JSON.stringify(flat?.structuredContent?.delegation_reason ?? Object.keys(flat ?? {})));
check(/policy_parameters/.test(textOf(flat)), 'flat arguments → error names policy_parameters', JSON.stringify(textOf(flat).slice(0, 160)));
check(flatKeys.some((k) => textOf(flat).includes(k)), 'flat arguments → error quotes the discarded key(s)');

// ── D. control: no arguments at all is NOT wrong-shaped ───────────────────────────────────────
console.log('\nD. no arguments at all — still delegates (unchanged behaviour)');
const bare = await callTool(computeNode.mcp_name, {});
check(bare?.isError !== true, 'no arguments → not an error');
check(bare?.structuredContent?.delegation_reason === 'missing_policy_parameters',
  'no arguments → delegation_reason "missing_policy_parameters"',
  JSON.stringify(bare?.structuredContent?.delegation_reason ?? bare?._rpcError));

// ── E. regression: the correct call still computes ────────────────────────────────────────────
console.log('\nE. correctly-nested call — unchanged, still computes server-side');
const ok = await callTool(computeNode.mcp_name, { policy_parameters: computeParams });
check(ok?.structuredContent?.compute_mode === 'server',
  'nested policy_parameters → compute_mode "server"',
  JSON.stringify(ok?.structuredContent?.compute_mode ?? ok?._rpcError ?? textOf(ok).slice(0, 160)));
check(typeof ok?.structuredContent?.artifact?.execution_hash === 'string' && ok.structuredContent.artifact.execution_hash.length === 64,
  'nested policy_parameters → returns a 64-hex execution_hash',
  JSON.stringify(ok?.structuredContent?.artifact?.execution_hash));
check(ok?.structuredContent?.hash_valid === true, 'nested policy_parameters → hash_valid true');

if (failures.length) {
  console.error(`\n✗ check-delegation-reason: ${failures.length} assertion(s) failed:`);
  for (const f of failures) console.error('    - ' + f);
  process.exit(1);
}
console.log('\n✓ check-delegation-reason: four delegation causes are distinguishable; flat arguments are refused; nested calls unchanged.');
