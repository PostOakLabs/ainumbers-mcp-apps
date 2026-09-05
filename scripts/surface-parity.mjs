#!/usr/bin/env node
/**
 * surface-parity.mjs — validates MCP surface counts after the discovery-layer wave.
 *
 * Checks (static analysis of worker.mjs + data/counts.json):
 *   P1. Hand-authored Prompts ≤ MAX_PROMPTS (target ~12; guard against re-inflation).
 *   P2. Auto-derive loop ABSENT from worker.mjs (guard against re-adding the 283 chain Prompts).
 *   P3. find_chain and find_tool are registered as utility tools in worker.mjs.
 *   P4. counts.json mcp_tools_total = live nodes + pilot + UTIL_TOOL_COUNT (10).
 *   P5. README.md "flagship widgets" table row count = counts.json pilot_widgets.
 *
 * This is a fast static gate — it does NOT start the server or make HTTP requests.
 * Run: node scripts/surface-parity.mjs
 * CI: add as a validate-job step after check-tool-names.mjs.
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { UTILITY_TOOL_COUNT } from '../utility-tools.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const workerPath   = resolve(here, '..', 'worker.mjs');
const countsPath   = resolve(here, '..', 'data', 'counts.json');
const readmePath   = resolve(here, '..', 'README.md');

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
const EXPECTED_UTIL = UTILITY_TOOL_COUNT; // single source of truth — see utility-tools.mjs
const liveNodes  = counts.chaingraph_nodes_live ?? 0;
const pilot      = counts.pilot_widgets ?? 0;
const expected   = liveNodes + pilot + EXPECTED_UTIL;
const actual     = counts.mcp_tools_total ?? 0;
console.log(`[P4] counts.json mcp_tools_total: ${actual} (expected ${liveNodes} nodes + ${pilot} pilot + ${EXPECTED_UTIL} util = ${expected})`);
if (actual !== expected) {
  errors.push(`P4: mcp_tools_total mismatch. counts.json says ${actual}, expected ${expected} (${liveNodes}+${pilot}+${EXPECTED_UTIL}). Re-run node generate.mjs and commit data/counts.json.`);
  ok = false;
}

// ── P5: README flagship-widgets table row count vs counts.json pilot_widgets ─
const readme = readFileSync(readmePath, 'utf8');
const tableSectionMatch = readme.match(/^### .*flagship widgets[\s\S]*?(?=\n## )/m);
if (!tableSectionMatch) {
  errors.push('P5: could not find a "flagship widgets" table section heading in README.md.');
  ok = false;
} else {
  const rows = [...tableSectionMatch[0].matchAll(/^\| `[^`]+` \|/gm)];
  const readmeWidgetCount = rows.length;
  console.log(`[P5] README flagship-widgets table rows: ${readmeWidgetCount} (counts.json pilot_widgets: ${pilot})`);
  if (readmeWidgetCount !== pilot) {
    errors.push(`P5: README.md flagship-widgets table has ${readmeWidgetCount} rows but counts.json pilot_widgets is ${pilot}. Add/remove the missing widget row(s) in README.md — never hand-type the count.`);
    ok = false;
  }
}

// ── P6: showcase prompts (MCP-SHOWCASE-PROMPTS-1) ────────────────────────────
// The vendored projection data/mcp/showcase-prompts.json must carry exactly 5 prompts with
// the SSOT field set, and worker.mjs must register them through the showcase loop. When the
// site repo is resolvable (AINUMBERS_REPO env or the default ../repo sibling), the projection
// is additionally asserted deep-equal to the site SSOT (single-writer law: the vendored copy
// is a projection, never a fork). Site-repo absence is a warning, not a pass substitute for
// the count — the count check always runs against the vendored file.
{
  const spPath = resolve(here, '..', 'data', 'mcp', 'showcase-prompts.json');
  if (!existsSync(spPath)) {
    errors.push('P6: data/mcp/showcase-prompts.json missing — re-run node generate.mjs and commit data/.');
    ok = false;
  } else {
    const sp = JSON.parse(readFileSync(spPath, 'utf8'));
    const items = sp.prompts ?? [];
    console.log(`[P6] showcase_prompts count: ${items.length} (expected 5)`);
    if (sp.count !== 5 || items.length !== 5) {
      errors.push(`P6: showcase_prompts count is ${sp.count}/${items.length}, expected 5 — regenerate from the site SSOT.`);
      ok = false;
    }
    const reqFields = ['id', 'title', 'one_line', 'doorways', 'arguments', 'body', 'verify_surface'];
    const bad = items.filter((p) => reqFields.some((f) => p[f] === undefined));
    if (bad.length) { errors.push('P6: malformed showcase prompt(s): ' + bad.map((p) => p.id).join(', ')); ok = false; }
    if (!src.includes('showcasePrompts?.prompts ?? []')) {
      errors.push('P6: worker.mjs showcase prompt registration loop missing — prompts will not appear in prompts/list.');
      ok = false;
    }
    const siteCandidates = [process.env.AINUMBERS_REPO, resolve(here, '..', '..', 'repo')].filter(Boolean);
    let siteChecked = false;
    for (const cand of siteCandidates) {
      const ssotPath = resolve(cand, 'mcp', 'showcase-prompts.json');
      if (existsSync(ssotPath)) {
        const ssot = JSON.parse(readFileSync(ssotPath, 'utf8'));
        const ssotItems = Array.isArray(ssot) ? ssot : (ssot.prompts ?? []);
        if (JSON.stringify(ssotItems) !== JSON.stringify(items)) {
          errors.push('P6: data/mcp/showcase-prompts.json diverged from site SSOT ' + ssotPath + ' — re-run node generate.mjs.');
          ok = false;
        } else {
          console.log('     deep-equal to site SSOT: ' + ssotPath);
        }
        siteChecked = true;
        break;
      }
    }
    if (!siteChecked) warnings.push('P6: site SSOT mcp/showcase-prompts.json not resolvable from this checkout — deep-equal check skipped (count check still enforced).');
  }
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
