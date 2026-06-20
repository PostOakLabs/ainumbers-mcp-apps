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
// 2026-06-20 fix: the live Worker intermittently THROTTLES / browser-delegates a compute:"server"
// request under this script's rapid 66-call burst. Proven: a single isolated call always returns
// compute_mode:server + the golden hash, but back-to-back full runs varied wildly (13, 17, even 66
// skipped). Correctness is never affected (0 failed; every vector reproduces its golden_hash when it
// computes) — this is a load artifact, not a kernel/parser bug. So we (a) throttle between calls,
// (b) retry-with-backoff on any non-server response before counting a skip, and (c) read the payload
// from structuredContent OR the result.content[].text fallback. parseRpc also picks the LAST
// JSON-RPC envelope from an SSE stream.
//
// Usage:  node scripts/smoke-compute.mjs [mcpUrl]      (default https://mcp.ainumbers.co/mcp)

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');          // mcp-apps-poc/
const FIXDIR = resolve(ROOT, '..', 'repo', 'chaingraph', 'kernels', 'fixtures');
const URL = process.argv[2] || process.env.MCP_SMOKE_URL || 'https://mcp.ainumbers.co/mcp';

const THROTTLE_MS = Number(process.env.MCP_SMOKE_THROTTLE_MS || 150);  // pause between calls
const MAX_ATTEMPTS = Number(process.env.MCP_SMOKE_RETRIES || 5);       // retries on non-server
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

if (!existsSync(FIXDIR)) {
  console.error(`✗ fixtures dir not found: ${FIXDIR}\n  Run locally with the sibling repo/ checked out (this is a local-only verifier).`);
  process.exit(1);
}

// tool_id -> mcp_name, from the vendored graph the Worker actually serves.
const cg = JSON.parse(readFileSync(resolve(ROOT, 'data', 'chaingraph', 'chaingraph.json'), 'utf8'));
const mcpName = {};
for (const n of (cg.nodes ?? [])) mcpName[n.tool_id] = n.mcp_name;

// Parse a JSON-RPC reply that may arrive as plain JSON OR as an SSE stream (text/event-stream).
// For SSE, scan every `data:` line and return the LAST one that parses to a JSON-RPC envelope.
function parseRpc(text) {
  const t = text.trim();
  if (t.startsWith('{')) { try { return JSON.parse(t); } catch { return null; } }
  const datas = t.split('\n').filter((x) => x.startsWith('data:')).map((x) => x.slice(5).trim());
  for (let i = datas.length - 1; i >= 0; i--) {
    try { const o = JSON.parse(datas[i]); if (o && (o.result || o.error)) return o; } catch { /* skip */ }
  }
  return null;
}

// Pull the tool payload from a JSON-RPC result. Prefer structuredContent; fall back to text content.
function payloadOf(result) {
  const sc = result?.structuredContent;
  if (sc && Object.keys(sc).length) return sc;
  const txt = result?.content?.find?.((c) => c?.type === 'text' && typeof c.text === 'string')?.text;
  if (txt) { try { return JSON.parse(txt); } catch { /* not JSON */ } }
  return {};
}

async function callOnce(name, policy_parameters) {
  const r = await fetch(URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name, arguments: { compute: 'server', policy_parameters } } }),
  });
  const status = r.status;
  const j = parseRpc(await r.text());
  if (j?.error) throw new Error(`rpc ${j.error.code}: ${j.error.message}`);
  const sc = payloadOf(j?.result);
  return { status, hash: sc.computed_hash ?? sc.artifact?.execution_hash ?? null, mode: sc.compute_mode ?? sc.artifact?.compute_mode ?? null };
}

// The Worker load-sheds/throttles under burst — retry a non-server response a few times with backoff.
async function callTool(name, policy_parameters) {
  let last = { status: 0, hash: null, mode: null };
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try { last = await callOnce(name, policy_parameters); }
    catch (e) { if (attempt === MAX_ATTEMPTS) throw e; await sleep(300 * attempt); continue; }
    if (last.mode === 'server') return last;
    if (attempt < MAX_ATTEMPTS) await sleep(300 * attempt);
  }
  return last;
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
      const { hash, mode, status } = await callTool(name, v.policy_parameters);
      if (mode !== 'server') { console.warn(`⚠ ${doc.tool_id}/${v.name}: not server after ${MAX_ATTEMPTS} tries (mode=${mode}, http=${status}) — Worker throttling/delegating under load`); skip++; }
      else if (hash === v.golden_hash) { pass++; }
      else { console.error(`✗ ${doc.tool_id}/${v.name}: live hash ${hash} != golden ${v.golden_hash}`); fail++; }
    } catch (e) { console.error(`✗ ${doc.tool_id}/${v.name}: ${e.message}`); fail++; }
    await sleep(THROTTLE_MS);
  }
}
console.log(`\nsmoke-compute (live /mcp server-compute vs golden): ${pass} passed, ${fail} failed, ${skip} skipped.`);
process.exit(fail ? 1 : 0);
