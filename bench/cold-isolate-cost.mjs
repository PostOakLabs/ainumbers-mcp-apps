// cold-isolate-cost.mjs — MCP-WORKER-1102-LIMITS-1: measure what ONE request costs on a cold
// isolate (fresh process, empty module-scope caches) for the methods the post-deploy smoke drives
// on the loadData() path. env.ASSETS is served from ./data on disk, so the number is the worker's
// own CPU (parse + build + dispatch), not network. Local CPU != Cloudflare CPU in absolute terms;
// use it for before/after deltas on the same machine.
//
// Run: node bench/cold-isolate-cost.mjs [runs=5]
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CASES = {
  'tools/call find_tool': { method: 'tools/call', params: { name: 'find_tool', arguments: { query: 'reserve' } } },
  'tools/call list_ainumbers_tools': { method: 'tools/call', params: { name: 'list_ainumbers_tools', arguments: {} } },
  'tools/call node(art-129)': { method: 'tools/call', params: { name: '__NODE__', arguments: {} } },
  'prompts/get same-law-three-doorways': { method: 'prompts/get', params: { name: 'same-law-three-doorways', arguments: { node_page: 'https://ainumbers.co/chaingraph/art-129-webbotauth-signature-verifier.html' } } },
};

if (process.argv[2] === '--child') {
  const c = JSON.parse(process.argv[3]);
  const { default: worker } = await import('../worker.mjs');
  const env = { ASSETS: { fetch: async (u) => {
    const p = resolve(ROOT, 'data', decodeURIComponent(new URL(u).pathname.slice(1)));
    try { return new Response(await readFile(p)); } catch { return new Response('miss', { status: 404 }); }
  } } };
  if (c.params.name === '__NODE__') {
    const cg = JSON.parse(await readFile(resolve(ROOT, 'data/chaingraph/chaingraph.json'), 'utf8'));
    c.params.name = cg.nodes.find((n) => n.tool_id?.startsWith('art-129'))?.mcp_name;
  }
  const req = new Request('https://mcp.ainumbers.co/mcp', { method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: c.method, params: c.params }) });
  const ctx = { waitUntil() {}, passThroughOnException() {} };
  const h0 = process.memoryUsage().heapUsed;
  const t0 = performance.now();
  const res = await worker.fetch(req, env, ctx);
  const text = await res.text();
  const ms = performance.now() - t0;
  const heap = (process.memoryUsage().heapUsed - h0) / 1048576;
  process.stdout.write(JSON.stringify({ ms, heap, status: res.status, ok: res.status === 200 && !/"error"\s*:/.test(text.slice(0, 400)), bytes: text.length }));
  process.exit(0);
}

const runs = Number(process.argv[2] ?? 5);
for (const [label, c] of Object.entries(CASES)) {
  const ms = []; let last;
  for (let i = 0; i < runs; i++) {
    const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--child', JSON.stringify(c)], { encoding: 'utf8', maxBuffer: 1 << 26 });
    try { last = JSON.parse(r.stdout); } catch { console.log(label, 'CHILD FAILED', r.stderr.slice(-400)); break; }
    ms.push(last.ms);
  }
  ms.sort((a, b) => a - b);
  console.log(label.padEnd(38), 'median', ms[ms.length >> 1]?.toFixed(1).padStart(7) + 'ms', ' heap+' + last?.heap.toFixed(1) + 'MB', ' status', last?.status, last?.ok ? 'ok' : 'NOT-OK', last?.bytes + 'B');
}
