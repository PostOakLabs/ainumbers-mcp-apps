#!/usr/bin/env node
/**
 * sync-registry.mjs — auto-update server.json before mcp-publisher.exe publish
 *
 * Usage:
 *   node scripts/sync-registry.mjs          # dry-run (prints what would change)
 *   node scripts/sync-registry.mjs --write  # writes server.json in-place
 *
 * Run this immediately before:  .\mcp-publisher.exe publish
 *
 * What it does:
 *   1. Reads data/counts.json — the vendored SSOT (generate.mjs writes it; never
 *      hand-derive counts here, that's how this script went stale before — S4 2026-07-09)
 *   2. Bumps server.json patch version (X.Y.Z → X.Y.Z+1)
 *   3. Writes server.json (with --write) or prints the diff (dry-run)
 */

import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));
const root  = join(__dir, '..');
const write = process.argv.includes('--write');

// ── 1. Read current server.json ───────────────────────────────────────────
const serverJsonPath = join(root, 'server.json');
const serverJson = JSON.parse(readFileSync(serverJsonPath, 'utf8'));

// ── 2. Read vendored SSOT counts ──────────────────────────────────────────
const counts = JSON.parse(readFileSync(join(root, 'data', 'counts.json'), 'utf8'));
const mcpToolsTotal = counts.mcp_tools_total;
const catalogTools = counts.catalog_tools;

// ── 3. Build new description (≤100 chars) ─────────────────────────────────
const desc = `${mcpToolsTotal} MCP tools across ${catalogTools} fintech tools: ChainGraph AP2 decisions, execution_hash. Zero PII.`;
if (desc.length > 100) {
  console.error(`❌  Description too long (${desc.length} chars, max 100): "${desc}"`);
  process.exit(1);
}

// ── 4. Bump patch version ──────────────────────────────────────────────────
const [maj, min, pat] = (serverJson.version || '0.1.0').split('.').map(Number);
const newVersion = `${maj}.${min}.${pat + 1}`;

// ── 5. Apply or preview ────────────────────────────────────────────────────
const updated = { ...serverJson, version: newVersion, description: desc };

console.log('\n── sync-registry.mjs ─────────────────────────────────────');
console.log(`  mcp tools    : ${mcpToolsTotal}`);
console.log(`  catalog tools: ${catalogTools}`);
console.log(`  version      : ${serverJson.version}  →  ${newVersion}`);
console.log(`  description  : "${desc}"  (${desc.length} chars)`);
console.log('──────────────────────────────────────────────────────────\n');

if (write) {
  writeFileSync(serverJsonPath, JSON.stringify(updated, null, 2) + '\n', 'utf8');
  console.log(`✅  server.json written (v${newVersion})`);
  console.log('    Next: commit and push (Cloudflare auto-deploys):');
  console.log('      git add server.json');
  console.log('      git commit -m "chore: bump registry to v' + newVersion + '"');
  console.log('      git push origin master');
} else {
  console.log('ℹ️   Dry run — no files written.  Pass --write to apply.');
}
