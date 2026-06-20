// verify-arc.mjs — explicit live hash_valid check for the 6 Wave-10 Arc tools (art-42..47).
// These were the nodes that previously returned hash_valid:false (unfixtured, non-contract kernels).
// They have since been remediated to the art-12 contract + fixtured + vendored; this confirms the
// DEPLOYED Worker now returns compute_mode:"server" AND execution_hash == golden for each.
//
// Reuses the stateless tools/call pattern from smoke-compute.mjs / verify-wave11.mjs.
// LOCAL ONLY (reads golden hashes from the sibling ../repo fixtures). Diagnostic — no need to commit.
//
// Usage:  node scripts/verify-arc.mjs [mcpUrl]      (default https://mcp.ainumbers.co/mcp)

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');           // mcp-apps-poc/
const FIXDIR = resolve(ROOT, '..', 'repo', 'chaingraph', 'kernels', 'fixtures');
const URL = process.argv[2] || process.env.MCP_SMOKE_URL || 'https://mcp.ainumbers.co/mcp';

const ARC = [
  'art-42-arc-fit-diagnostic', 'art-43-arc-cpn-model', 'art-44-arc-stablefx-model',
  'art-45-arc-xreserve-linter', 'art-46-arc-paymaster-model', 'art-47-arc-cctp-transfer',
];

if (!existsSync(FIXDIR)) {
  console.error(`✗ fixtures dir not found: ${FIXDIR}\n  Run locally with the sibling repo/ checked out.`);
  process.exit(1);
}

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

(async () => {
  let fail = 0;
  for (const tool_id of ARC) {
    const name = mcpName[tool_id];
    if (!name) { console.error(`✗ ${tool_id}: not a live node in vendored chaingraph.json`); fail++; continue; }
    let doc;
    try { doc = JSON.parse(readFileSync(resolve(FIXDIR, `${tool_id}.fixtures.json`), 'utf8')); }
    catch { console.error(`✗ ${tool_id}: fixture missing`); fail++; continue; }
    const v = (doc.vectors ?? [])[0];
    if (!v?.golden_hash) { console.error(`✗ ${tool_id}: no golden_hash in fixture`); fail++; continue; }
    try {
      const { hash, mode } = await callTool(name, v.policy_parameters);
      const ok = mode === 'server' && hash === v.golden_hash;
      if (ok) console.log(`✓ ${name}  compute_mode:server  hash_valid:true`);
      else { console.error(`✗ ${name}  mode=${mode}  hash=${hash}  golden=${v.golden_hash}`); fail++; }
    } catch (e) { console.error(`✗ ${name}: ${e.message}`); fail++; }
  }
  console.log(fail ? `\n✗ ${fail}/6 Arc tools failed — investigate before claiming v0.4 conformance.`
                   : `\n✓ All 6 Arc tools self-execute and verify (hash_valid:true) on the live server.`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('verify-arc failed:', e.message); process.exit(1); });
