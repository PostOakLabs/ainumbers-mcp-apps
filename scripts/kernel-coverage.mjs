// kernel-coverage.mjs — agent-native coverage report (read-only; no kernel files touched).
// For every LIVE chaingraph.json node, reports whether it has a registered kernel
// (server-computable / agent-native) or still browser-delegates:
//   ✓ agent-native  — kernel present → MCP returns a verifiable artifact server-side, no browser
//   ⏳ gpu-delegated — gpu:true, no kernel → browser-delegated (Workstream B: port the seeded sim)
//   ⚠ UNPORTED      — gpu:false, no kernel → SHOULD be agent-native but isn't (a gap — e.g. a new
//                     tool added without a kernel; close it per CONTRACT §A4 / the agent-native spec)
//
// Reads the VENDORED set the Worker actually uses: ./data/chaingraph.json + ./kernels/index.mjs
// (run `node generate.mjs` first to refresh). Pure text parse of index.mjs — does not import the
// kernels, so it won't break if one is mid-edit.
//
// Usage:  node scripts/kernel-coverage.mjs            (strict by default — exit 1 if any gpu:false node is UNPORTED)
//         node scripts/kernel-coverage.mjs --no-strict (report only, exit 0)

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Kernel ids = the keys of the KERNELS object in kernels/index.mjs (text-parsed, decoupled).
const idx = readFileSync(resolve(ROOT, 'kernels', 'index.mjs'), 'utf8');
const start = idx.indexOf('KERNELS = {');
const block = start >= 0 ? idx.slice(start, idx.indexOf('};', start)) : '';
const kernelIds = new Set([...block.matchAll(/['"]([a-z0-9][a-z0-9-]+)['"]\s*:/g)].map((m) => m[1]));

const cg = JSON.parse(readFileSync(resolve(ROOT, 'data', 'chaingraph', 'chaingraph.json'), 'utf8'));
const live = (cg.nodes ?? []).filter((n) => n.status === 'live');

const agentNative = [], gpuDelegated = [], unported = [];
for (const n of live) {
  if (kernelIds.has(n.tool_id)) agentNative.push(n.tool_id);
  else if (n.gpu) gpuDelegated.push(n.tool_id);
  else unported.push(n.tool_id);
}

const pct = live.length ? Math.round((agentNative.length / live.length) * 100) : 0;
console.log(`\nOpenChainGraph agent-native coverage — ${live.length} live nodes, ${kernelIds.size} kernels registered\n`);
console.log(`  ✓ agent-native (server-computable):  ${agentNative.length}/${live.length}  (${pct}%)`);
console.log(`  ⏳ gpu-delegated (Workstream B):      ${gpuDelegated.length}`);
if (gpuDelegated.length) console.log(`       ${gpuDelegated.join(', ')}`);
console.log(`  ⚠ UNPORTED gpu:false (gap):          ${unported.length}`);
if (unported.length) console.log(`       ${unported.join(', ')}`);
console.log('');

if (!process.argv.includes('--no-strict') && unported.length) {
  console.error(`✗ ${unported.length} gpu:false node(s) have no kernel — each should be agent-native (add kernel + index.mjs entry, CONTRACT §A4).`);
  process.exit(1);
}
process.exit(0);
