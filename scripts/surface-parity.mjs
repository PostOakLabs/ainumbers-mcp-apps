#!/usr/bin/env node
/**
 * surface-parity.mjs — validates MCP surface counts after the discovery-layer wave.
 *
 * Checks (static analysis of worker.mjs + data/counts.json):
 *   P1. Hand-authored Prompts ≤ MAX_PROMPTS (target ~12; guard against re-inflation).
 *   P2. Auto-derive loop ABSENT from worker.mjs (guard against re-adding the 283 chain Prompts).
 *   P3. find_chain and find_tool are registered as utility tools in worker.mjs.
 *   P4. counts.json mcp_tools_total = live nodes + pilot + UTIL_TOOL_COUNT (9).
 *
 * This is a fast static gate — it does NOT start the server or make HTTP requests.
 * Run: node scripts/surface-parity.mjs
 * CI: add as a validate-job step after check-tool-names.mjs.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const workerPath   = resolve(here, '..', 'worker.mjs');
const countsPath   = resolve(here, '..', 'data', 'counts.json');

const MAX_PROMPTS = 15; // target ~12; allow headroom for future additions

const errors   = [];
const warnings = [];
let   ok       = true;

const src    = readFileSync(workerPath, 'utf8');
const counts = JSON.parse(readFileSync(countsPath, 'utf8'));

// ── P1: count hand-authored regPrompt calls ──────────────────────────────────
const promptMatches = [...src.matchAll(/regPrompt\('([^']+)'/g)];
const promptCount   = promptMatches.length;
console.log(`[P1] Hand-authored Prompts: ${promptCount} (max allowed: ${MAX_PROMPTS})`);
if (promptCount > MAX_PROMPTS) {
  errors.push(`P1: too many hand-authored Prompts (${promptCount} > ${MAX_PROMPTS}). Remove some or raise MAX_PROMPTS intentionally.`);
  ok = false;
} else {
  console.log(`     Prompt names: ${promptMatches.map(m => m[1]).join(', ')}`);
}

// ── P2: auto-derive loop must be absent ─────────────────────────────────────
const hasAutoDerive = src.includes('Auto-derive a workflow prompt for every chaingraph.chains');
console.log(`[P2] Auto-derive loop absent: ${!hasAutoDerive}`);
if (hasAutoDerive) {
  errors.push('P2: auto-derive chain-Prompt loop still present in worker.mjs — it re-adds 283 agent-invisible Prompts. Remove it.');
  ok = false;
}

// ── P3: discovery tools registered ──────────────────────────────────────────
const hasFindChain = src.includes("registerTool('find_chain'");
const hasFindTool  = src.includes("registerTool('find_tool'");
console.log(`[P3] find_chain registered: ${hasFindChain}, find_tool registered: ${hasFindTool}`);
if (!hasFindChain) { errors.push("P3: find_chain tool not found in worker.mjs registerTool calls."); ok = false; }
if (!hasFindTool)  { errors.push("P3: find_tool tool not found in worker.mjs registerTool calls."); ok = false; }

// ── P4: counts.json mcp_tools_total sanity ──────────────────────────────────
const EXPECTED_UTIL = 9;
const liveNodes  = counts.chaingraph_nodes_live ?? 0;
const pilot      = counts.pilot_widgets ?? 0;
const expected   = liveNodes + pilot + EXPECTED_UTIL;
const actual     = counts.mcp_tools_total ?? 0;
console.log(`[P4] counts.json mcp_tools_total: ${actual} (expected ${liveNodes} nodes + ${pilot} pilot + ${EXPECTED_UTIL} util = ${expected})`);
if (actual !== expected) {
  errors.push(`P4: mcp_tools_total mismatch. counts.json says ${actual}, expected ${expected} (${liveNodes}+${pilot}+${EXPECTED_UTIL}). Re-run node generate.mjs and commit data/counts.json.`);
  ok = false;
}

// ── summary ─────────────────────────────────────────────────────────────────
if (warnings.length) {
  console.log(`\nWARNINGS (${warnings.length}):`);
  for (const w of warnings) console.log('  ⚠  ' + w);
}
if (errors.length) {
  console.error(`\nERRORS (${errors.length}):`);
  for (const e of errors) console.error('  ✗  ' + e);
  console.error('\nFAIL — surface-parity gate blocked deploy.');
  process.exit(1);
}
console.log('\nOK — surface-parity gate passed.');
