// Selftest for embed/stdio.mjs (MCPB-LOCAL-SERVER-1). No network, node builtins only.
//
//   node embed/stdio.selftest.mjs        Exit 0 = parity; non-zero = a divergence (fails loud).
//
// Spawns the real stdio server and drives it over JSON-RPC. Proves:
//   1. protocol: initialize / ping / tools/list / unknown method / unknown tool / bad JSON.
//   2. tools/list names == the worker's catalog mcp_names (+ run_chain), all unique.
//   3. PARITY SAMPLE: for N nodes the local tools/call execution_hash equals the hash the remote
//      worker's pipeline produces from the repo's own data + kernels (oracle below re-runs the
//      worker.mjs Compute Binding path: normalizeNullMembers -> buildArtifact -> executionHash).
//      Sample rule (deterministic): every non-GPU kernel-backed node that has a fixture in
//      data/chain-fixtures.json, fixture taken from the alphabetically first chain naming it;
//      sorted by tool_id; every ceil(M/SAMPLE_N)-th entry, starting at index 0.
//   4. GPU nodes (first 3 by tool_id) and compute:"browser" return needs_remote_worker with NO
//      execution_hash.
//   5. run_chain reproduces the pinned composite hashes in embed/fixtures/conformance.json.
//   6. Source grep: stdio.mjs imports no network module and calls no fetch.

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getKernel } from '../kernels/index.mjs';
import { executionHash } from '../kernels/_hash.mjs';
import { normalizeNullMembers } from '../_null_normalize.mjs';

const SAMPLE_N = 40;
const here = fileURLToPath(new URL('.', import.meta.url));
const rd = (rel) => JSON.parse(readFileSync(here + rel, 'utf8'));
const chaingraph = rd('../data/chaingraph/chaingraph.json');
const fixtures = rd('../data/chain-fixtures.json');
let nullExemptions = {};
try { nullExemptions = rd('../data/mcp/null-exemptions.json'); } catch { /* optional */ }

let failures = 0;
const ok = (l) => console.log('  ✓ ' + l);
const bad = (l, d) => { failures++; console.log('  ✗ ' + l + (d ? ' — ' + d : '')); };

// --- JSON-RPC client over the child's stdio ---------------------------------------------------
const child = spawn(process.execPath, [here + 'stdio.mjs'], { stdio: ['pipe', 'pipe', 'inherit'] });
const pending = new Map();
const rawLines = [];
let buf = '';
child.stdout.on('data', (d) => {
  buf += d.toString('utf8');
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line) continue;
    rawLines.push(line);
    let m; try { m = JSON.parse(line); } catch { bad('stdout line is not JSON', line.slice(0, 80)); continue; }
    pending.get(m.id)?.(m); pending.delete(m.id);
  }
});
let nextId = 1;
const rpc = (method, params) => new Promise((res) => {
  const id = nextId++; pending.set(id, res);
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
});
const call = (name, args) => rpc('tools/call', { name, arguments: args }).then((m) => m.result);

// --- 1 protocol -----------------------------------------------------------------------------
console.log('\n[1] protocol');
const init = (await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'selftest', version: '0' } })).result;
init?.protocolVersion === '2025-06-18' && init.capabilities?.tools && init.serverInfo?.name ? ok('initialize') : bad('initialize', JSON.stringify(init));
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
(await rpc('ping')).result && Object.keys((await rpc('ping')).result).length === 0 ? ok('ping') : bad('ping');
(await rpc('nope')).error?.code === -32601 ? ok('unknown method -> -32601') : bad('unknown method');
(await rpc('tools/call', { name: 'no_such_tool_xyz', arguments: {} })).error?.code === -32602 ? ok('unknown tool -> -32602') : bad('unknown tool');
child.stdin.write('{not json\n');
await new Promise((r) => setTimeout(r, 200));
rawLines.some((l) => l.includes('-32700')) ? ok('bad JSON -> -32700') : bad('bad JSON not answered');

// --- 2 tool list ----------------------------------------------------------------------------
console.log('\n[2] tools/list == worker catalog names');
const tools = (await rpc('tools/list')).result.tools;
const names = tools.map((t) => t.name);
const expect = [...chaingraph.nodes.filter((n) => n.mcp_name).map((n) => n.mcp_name), 'run_chain'];
names.length === new Set(names).size ? ok(names.length + ' tools, all unique') : bad('duplicate tool names');
JSON.stringify([...names].sort()) === JSON.stringify([...expect].sort()) ? ok('names identical to catalog mcp_name set (+ run_chain)') : bad('tool names differ from catalog');
tools.every((t) => t.inputSchema?.type === 'object') ? ok('every tool has an object inputSchema') : bad('inputSchema missing');

// --- 3 parity sample ------------------------------------------------------------------------
console.log('\n[3] parity sample vs the worker pipeline (data + kernels in repo)');
const nodeById = Object.fromEntries(chaingraph.nodes.map((n) => [n.tool_id, n]));
const pool = new Map(); // tool_id -> pp from the alphabetically first chain
for (const chain of Object.keys(fixtures).sort()) {
  for (const [tid, pp] of Object.entries(fixtures[chain])) {
    const n = nodeById[tid];
    if (n && n.mcp_name && !n.gpu && getKernel(tid) && !pool.has(tid)) pool.set(tid, pp);
  }
}
const ids = [...pool.keys()].sort();
const step = Math.ceil(ids.length / SAMPLE_N);
const sample = ids.filter((_, i) => i % step === 0);
console.log('  pool=' + ids.length + ' step=' + step + ' sample=' + sample.length);
let matched = 0;
for (const tid of sample) {
  const node = nodeById[tid];
  const pp = pool.get(tid);
  let remoteHash, remoteErr = null;
  try {
    const a = await getKernel(tid).buildArtifact(normalizeNullMembers(pp, nullExemptions?.[tid] ?? null), { now: new Date().toISOString(), parent_hashes: [], parent_tool_ids: [], chain_depth: node.chain_depth ?? 0 });
    remoteHash = await executionHash(a.policy_parameters, a.output_payload);
  } catch (e) { remoteErr = String(e?.message ?? e); }
  const r = await call(node.mcp_name, { policy_parameters: pp });
  if (remoteErr) {
    // the worker would answer tool.compute_error; the local server must refuse the same way
    r?.isError ? matched++ : bad(tid, 'worker errors (' + remoteErr + ') but local returned a result');
    continue;
  }
  const art = r?.structuredContent?.artifact;
  if (!art) { bad(tid, 'no artifact: ' + JSON.stringify(r).slice(0, 120)); continue; }
  if (art.execution_hash !== remoteHash) bad(tid, art.execution_hash + ' != ' + remoteHash);
  else if (r.structuredContent.hash_valid !== true) bad(tid, 'hash_valid not true');
  else matched++;
}
matched === sample.length ? ok(matched + '/' + sample.length + ' execution_hash match') : bad('parity', matched + '/' + sample.length);

// --- 4 GPU / browser refusal ----------------------------------------------------------------
console.log('\n[4] GPU-only and compute:"browser" never return a computed answer');
const gpuNodes = chaingraph.nodes.filter((n) => n.gpu && n.mcp_name).sort((a, b) => a.tool_id < b.tool_id ? -1 : 1).slice(0, 3);
for (const n of gpuNodes) {
  const r = await call(n.mcp_name, { policy_parameters: pool.get(n.tool_id) ?? { x: 1 } });
  r?.structuredContent?.status === 'needs_remote_worker' && r.structuredContent.execution_hash === undefined && r.structuredContent.artifact === undefined
    ? ok(n.tool_id + ' -> needs_remote_worker') : bad(n.tool_id, JSON.stringify(r).slice(0, 120));
}
if (!gpuNodes.length) bad('no gpu nodes found to test');
{
  const tid = sample[0];
  const r = await call(nodeById[tid].mcp_name, { policy_parameters: pool.get(tid), compute: 'browser' });
  r?.structuredContent?.status === 'needs_remote_worker' ? ok('compute:"browser" -> needs_remote_worker') : bad('compute:"browser"');
}

// --- 5 run_chain vs pinned composite hashes -------------------------------------------------
console.log('\n[5] run_chain reproduces pinned composite hashes');
for (const v of rd('fixtures/conformance.json').vectors) {
  const r = await call('run_chain', { chain: v.chain });
  const h = r?.structuredContent?.composite_execution_hash;
  h === v.expected_composite_execution_hash ? ok(v.chain + ' ' + h.slice(0, 8) + '…') : bad(v.chain, h + ' != ' + v.expected_composite_execution_hash);
}

// --- 6 no network ---------------------------------------------------------------------------
console.log('\n[6] no network in stdio.mjs');
const src = readFileSync(here + 'stdio.mjs', 'utf8').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
/\bfetch\s*\(|node:(http|https|net|dgram|tls|dns)|XMLHttpRequest|WebSocket|child_process/.test(src) ? bad('network/exec reference found') : ok('no fetch / net / child_process references');

child.stdin.end();
await new Promise((r) => child.on('close', r));
console.log('\n' + (failures ? 'FAIL: ' + failures + ' divergence(s)' : 'PASS: stdio parity green'));
process.exit(failures ? 1 : 0);
