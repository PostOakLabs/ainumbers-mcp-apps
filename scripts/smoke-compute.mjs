// smoke-compute.mjs — LIVE agent-native correctness check (run locally).
// For every kernel fixture, calls the DEPLOYED /mcp tool with compute:"server" and asserts the
// returned execution_hash equals the fixture's pinned golden_hash. This proves the MCP layer is
// genuinely self-executing end-to-end: agent → server compute → verifiable artifact, no browser,
// no human JSON export. It is the runtime complement to golden-parity.test.mjs (which checks the
// kernel in Node) — this checks the actual deployed Worker.
//
// Stateless `tools/call` (verified 2026-06-19): one POST per vector, no session handshake.
// LOCAL ONLY (not a CI step): fixtures live in the sibling site repo (../repo), which is absent in
// the server-repo cloud build — same reason generate.mjs can't run there. Run it after a deploy,
// or before pushing kernel changes.
//
// Usage:  node scripts/smoke-compute.mjs [mcpUrl]      (default https://mcp.ainumbers.co/mcp)

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');          // mcp-apps-poc/
const FIXDIR = resolve(ROOT, '..', 'repo', 'chaingraph', 'kernels', 'fixtures');
const URL = process.argv[2] || process.env.MCP_SMOKE_URL || 'https://mcp.ainumbers.co/mcp';

if (!existsSync(FIXDIR)) {
  console.error(`✗ fixtures dir not found: ${FIXDIR}\n  Run locally with the sibling repo/ checked out (this is a local-only verifier).`);
  process.exit(1);
}

// tool_id -> mcp_name, from the vendored graph the Worker actually serves.
const cg = JSON.parse(readFileSync(resolve(ROOT, 'data', 'chaingraph', 'chaingraph.json'), 'utf8'));
const mcpName = {};
for (const n of (cg.nodes ?? [])) mcpName[n.tool_id] = n.mcp_name;

function parseRpc(text) {
  const t = text.trim();
  if (t.startsWith('{')) return JSON.parse(t);
  const l = t.split('\n').find((x) => x.startsWith('data:'));
  return l ? JSON.parse(l.slice(5).trim()) : null;
}

async function callTool(name, policy_parameters) {
  const r = await fetch(URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name, arguments: { compute: 'server', policy_parameters } } }),
  });
  const j = parseRpc(await r.text());
  if (j?.error) throw new Error(`rpc ${j.error.code}: ${j.error.message}`);
  const sc = j?.result?.structuredContent ?? {};
  return { hash: sc.computed_hash ?? sc.artifact?.execution_hash ?? null, mode: sc.compute_mode ?? sc.artifact?.compute_mode ?? null };
}

let pass = 0, fail = 0, skip = 0;
const files = readdirSync(FIXDIR).filter((f) => f.endsWith('.fixtures.json'));
for (const f of files) {
  const doc = JSON.parse(readFileSync(resolve(FIXDIR, f), 'utf8'));
  const name = mcpName[doc.tool_id];
  if (!name) { console.warn(`⚠ ${doc.tool_id}: not a live node — skip`); skip++; continue; }
  for (const v of (doc.vectors ?? [])) {
    if (!v.golden_hash) { console.warn(`⚠ ${doc.tool_id}/${v.name}: no golden_hash — skip`); skip++; continue; }
    try {
      const { hash, mode } = await callTool(name, v.policy_parameters);
      if (mode !== 'server') { console.warn(`⚠ ${doc.tool_id}/${v.name}: not server-computed (mode=${mode}) — still browser-delegated`); skip++; continue; }
      if (hash === v.golden_hash) { pass++; }
      else { console.error(`✗ ${doc.tool_id}/${v.name}: live hash ${hash} != golden ${v.golden_hash}`); fail++; }
    } catch (e) { console.error(`✗ ${doc.tool_id}/${v.name}: ${e.message}`); fail++; }
  }
}
console.log(`\nsmoke-compute (live /mcp server-compute vs golden): ${pass} passed, ${fail} failed, ${skip} skipped.`);
process.exit(fail ? 1 : 0);
