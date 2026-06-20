// check-tool-names.mjs — preflight guardrail (CONTRACT §A4.1).
// Every MCP tool name the Worker registers must be unique across:
//   (a) live chaingraph.json nodes (mcp_name)
//   (b) PILOT widget tools (manifest mcp_tool_definition.name, else slug)
//   (c) the fixed utility tools
// A collision threw "Tool X is already registered" → 500 on the /mcp handshake (full outage).
// Reads the VENDORED ./data (what actually deploys). Run after `node generate.mjs`.
//
// Exit 1 (FATAL) on: node-vs-node duplicate, pilot-vs-pilot duplicate, or any reuse of a
//   utility name — these are authoring errors with no safe fallback.
// Exit 0 + WARN on: a single pilot tool and a single node sharing a name — that's the
//   ChainGraph twin of a pilot widget; the Worker's seeded dedup skips the node, so it's
//   non-fatal, but it means the node isn't separately registered (flagged so it's visible).

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PILOT } from '../pilot.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = resolve(ROOT, 'data');

const UTILITY_TOOLS = [
  'list_ainumbers_tools', 'build_workflow_links', 'verify_execution_hash',
  'build_chaingraph', 'emit_chaingraph_artifact', 'build_session_receipt',
  'export_artifact',
];

const names = new Map(); // name -> [sources]
function add(name, source) {
  if (!name) return;
  if (!names.has(name)) names.set(name, []);
  names.get(name).push(source);
}

for (const u of UTILITY_TOOLS) add(u, 'utility');

for (const slug of PILOT) {
  const p = resolve(DATA, 'manifests', slug + '.manifest.json');
  let name = slug.replace(/-/g, '_');
  if (existsSync(p)) {
    try { name = JSON.parse(readFileSync(p, 'utf8'))?.mcp_tool_definition?.name ?? name; } catch { /* keep fallback */ }
  }
  add(name, 'pilot:' + slug);
}

const cgPath = resolve(DATA, 'chaingraph', 'chaingraph.json');
const cg = JSON.parse(readFileSync(cgPath, 'utf8'));
for (const n of (cg.nodes ?? [])) {
  if (n.status === 'live') add(n.mcp_name, 'node:' + n.tool_id);
}

const fatal = [];
const warn = [];
for (const [name, src] of names) {
  if (src.length < 2) continue;
  const nodes = src.filter((s) => s.startsWith('node:')).length;
  const pilots = src.filter((s) => s.startsWith('pilot:')).length;
  const utils = src.filter((s) => s === 'utility').length;
  // Any shared name is now FATAL. A pilot↔node twin MUST use a distinct mcp_name (the art-22 pattern,
  // e.g. compare_agentic_rail_protocols), otherwise the Worker silently skips the node and it never
  // becomes agent-callable. Leaving it a warning is how the 5 art-19/21/23/25/26 collisions persisted.
  void nodes; void pilots; void utils;
  fatal.push([name, src]);
}

for (const [name, src] of warn) {
  console.warn(`⚠ pilot↔node share "${name}"  (${src.join(' , ')}) — Worker skips the node; give it a unique mcp_name when convenient.`);
}

if (fatal.length === 0) {
  console.log(`✓ tool-name check: ${names.size} names, no fatal collisions (${warn.length} pilot↔node warning(s)).`);
  process.exit(0);
}
console.error('\n✗ FATAL duplicate MCP tool name(s) — would break /mcp registration (CONTRACT §A4.1):');
for (const [name, src] of fatal) console.error(`    ${name}  ←  ${src.join(' , ')}`);
console.error('\n  Give the duplicate a unique mcp_name (chaingraph.json node, pilot manifest, or utility).');
process.exit(1);
