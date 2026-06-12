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
 *   1. Reads pilot.mjs to get current pilot tool count
 *   2. Reads repo's tool count from catalog.json (via ASSETS data/ directory)
 *   3. Bumps server.json patch version (X.Y.Z → X.Y.Z+1)
 *   4. Writes server.json (with --write) or prints the diff (dry-run)
 */

import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import { join, dirname } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));
const root  = join(__dir, '..');
const write = process.argv.includes('--write');

// ── 1. Read current server.json ───────────────────────────────────────────
const serverJsonPath = join(root, 'server.json');
const serverJson = JSON.parse(readFileSync(serverJsonPath, 'utf8'));

// ── 2. Count pilot tools ──────────────────────────────────────────────────
const { PILOT } = await import(pathToFileURL(join(root, 'pilot.mjs')));
const pilotCount = PILOT.length;

// ── 3. Count ainumbers tools from vendored catalog ────────────────────────
let ainCount = '468+'; // fallback
try {
  const catalog = JSON.parse(readFileSync(join(root, 'data', 'catalog.json'), 'utf8'));
  const n = Array.isArray(catalog) ? catalog.length
          : Array.isArray(catalog?.tools) ? catalog.tools.length
          : 0;
  if (n > 0) ainCount = `${n}+`;
} catch { /* catalog not vendored yet — use fallback */ }

// ── 4. Count ChainGraph tools from chaingraph.json ───────────────────────
let chainCount = 19; // fallback
try {
  const cg = JSON.parse(readFileSync(join(root, 'data', 'chaingraph.json'), 'utf8'));
  if (Array.isArray(cg?.nodes)) chainCount = cg.nodes.length;
} catch { /* use fallback */ }

// ── 5. Build new description (≤100 chars) ────────────────────────────────
// Format: "<ainCount> zero-egress fintech tools + <chainCount> ChainGraph AP2 tools. Zero PII."
const desc = `${ainCount} zero-egress fintech tools + ${chainCount} ChainGraph AP2-emitting decision tools. Zero PII.`;
if (desc.length > 100) {
  console.error(`❌  Description too long (${desc.length} chars, max 100): "${desc}"`);
  process.exit(1);
}

// ── 6. Bump patch version ─────────────────────────────────────────────────
const [maj, min, pat] = (serverJson.version || '0.1.0').split('.').map(Number);
const newVersion = `${maj}.${min}.${pat + 1}`;

// ── 7. Apply or preview ───────────────────────────────────────────────────
const updated = { ...serverJson, version: newVersion, description: desc };

console.log('\n── sync-registry.mjs ─────────────────────────────────────');
console.log(`  pilot tools  : ${pilotCount}`);
console.log(`  ain tools    : ${ainCount}`);
console.log(`  chaingraph   : ${chainCount}`);
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
