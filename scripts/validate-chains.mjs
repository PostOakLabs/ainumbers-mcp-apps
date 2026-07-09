#!/usr/bin/env node
/**
 * validate-chains.mjs — pre-deploy integrity check for the AINumbers MCP server.
 *
 * THREE VALIDATION LAYERS:
 *
 * Layer 1 — NAMED_CHAINS cross-check (worker.mjs against ../repo).
 *   1. ERROR — every chain step `slug` resolves to repo/tools/<slug>.html (or chaingraph/<slug>.html)
 *   2. ERROR — every chain `composer_url` resolves to repo/guides/<file>.html OR repo/chaingraph/chains/<file>.html
 *   3. WARN  — chain ordered slug list equals the composer's STAGES slug list
 *
 * Layer 2 — chaingraph.json chains[] (LIVE schema).
 *   The live chains[] entries are { name, title, description, composer_url, steps:[{tool_id, handoff}] }.
 *   (The old A3 schema — chain_id / steps[].order / node_id / page_url — was never adopted; validating
 *   against it produced a spurious error on every chain. This layer validates the real shape.)
 *   S1. name + non-empty steps[] required; title recommended.
 *   S2. name uniqueness across chains[].
 *   S3. each step has tool_id (+ handoff); tool_id resolves to a nodes[] entry, a catalog tool
 *       (repo/tools/<id>.html), or a promoted node page (repo/chaingraph/<id>.html).
 *   S4. composer_url resolves to a file on disk (WARN; Layer 1 errors on NAMED_CHAINS composer drift).
 *
 * Layer 3 — mcp_name uniqueness gate (2026-06-19 outage class prevention).
 *   Errors if two live nodes share an mcp_name, or a node mcp_name collides with a PILOT/utility name.
 *
 * Exit code: 1 if any ERROR in any layer, else 0. In CI (server repo only, no sibling ../repo)
 * Layers 1+2 self-skip and Layer 3 runs against ../repo only when present — the real CI gates are
 * the wrangler dry-run bundle, check-tool-names.mjs, and kernel-coverage.mjs.
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { UTILITY_TOOL_NAMES as UTILITY_NAMES } from '../utility-tools.mjs';
import { validateChainGates } from './gate-static.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const REPO          = resolve(here, '..', '..', 'repo');
const WORKER_PATH   = process.env.WORKER_PATH    || resolve(here, '..', 'worker.mjs');
const TOOLS_DIR     = process.env.TOOLS_DIR      || join(REPO, 'tools');
const GUIDES_DIR    = process.env.GUIDES_DIR     || join(REPO, 'guides');
const CHAINGRAPH_JSON = process.env.CHAINGRAPH_JSON || join(REPO, 'chaingraph', 'chaingraph.json');
const CHAINS_DIR    = process.env.CHAINS_DIR     || join(REPO, 'chaingraph', 'chains');

const errors   = [];
const warnings = [];

// ════════════════════════════════════════════════════════════════
// LAYER 1 — NAMED_CHAINS in worker.mjs
// ════════════════════════════════════════════════════════════════

function extractNamedChainsBlock(src) {
  const start = src.indexOf('const NAMED_CHAINS');
  if (start === -1) throw new Error('NAMED_CHAINS not found in worker.mjs');
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return src.slice(open, i + 1); }
  }
  throw new Error('Unbalanced braces in NAMED_CHAINS');
}

function parseChains(block) {
  const headerRe = /\n  '([a-z0-9-]+)':\s*\{/g;
  const heads = [];
  let m;
  while ((m = headerRe.exec(block)) !== null) heads.push({ id: m[1], at: m.index });
  const slugRe    = /slug:\s*'([^']+)'/g;
  const composerRe = /composer_url:\s*BASE_URL\s*\+\s*'([^']+)'/;
  return heads.map((h, i) => {
    const seg = block.slice(h.at, i + 1 < heads.length ? heads[i + 1].at : block.length);
    const slugs = [];
    let s;
    slugRe.lastIndex = 0;
    while ((s = slugRe.exec(seg)) !== null) slugs.push(s[1]);
    const cm = seg.match(composerRe);
    const composerFile = cm ? cm[1].replace(/^\/guides\//, '').replace(/^\/chaingraph\/chains\//, '') : null;
    const composerIsChain = cm ? cm[1].startsWith('/chaingraph/chains/') : false;
    return { id: h.id, slugs, composerFile, composerIsChain };
  });
}

function composerSlugs(html) {
  const re = /slug:\s*'([^']+)'/g;
  const out = [];
  let m;
  while ((m = re.exec(html)) !== null) { if (/^(\d+|rbe-)/.test(m[1])) out.push(m[1]); }
  return out;
}

let ncChains = [];

if (!existsSync(TOOLS_DIR)) {
  console.log(`TOOLS_DIR not found: ${TOOLS_DIR} — skipping Layer 1 chain validation (repo not checked out).`);
} else {
  const src = readFileSync(WORKER_PATH, 'utf8');
  ncChains = parseChains(extractNamedChainsBlock(src));
  let stepCount = 0;
  for (const c of ncChains) {
    for (const slug of c.slugs) {
      stepCount++;
      const toolPath = join(TOOLS_DIR, `${slug}.html`);
      const chainNodePath = join(REPO, 'chaingraph', `${slug}.html`);
      if (!existsSync(toolPath) && !existsSync(chainNodePath)) {
        errors.push(`[L1:${c.id}] missing tool/node file: tools/${slug}.html (also checked chaingraph/${slug}.html)`);
      }
    }
    if (c.composerFile) {
      if (c.composerIsChain) {
        if (!existsSync(join(CHAINS_DIR, c.composerFile))) {
          errors.push(`[L1:${c.id}] missing chain page: chaingraph/chains/${c.composerFile}`);
        }
      } else {
        const fp = join(GUIDES_DIR, c.composerFile);
        if (!existsSync(fp)) {
          errors.push(`[L1:${c.id}] missing composer page: guides/${c.composerFile}`);
        } else {
          const compSlugs = composerSlugs(readFileSync(fp, 'utf8'));
          const a = c.slugs.join(' > ');
          const b = compSlugs.join(' > ');
          if (a !== b) {
            warnings.push(`[L1:${c.id}] chain/composer sequence mismatch:\n    chain    : ${a || '(none)'}\n    composer : ${b || '(none)'}`);
          }
        }
      }
    }
  }
  console.log(`[Layer 1] Validated ${ncChains.length} NAMED_CHAINS, ${stepCount} step slugs against ${TOOLS_DIR}`);
}

// ════════════════════════════════════════════════════════════════
// LAYER 2 — chaingraph.json chains[] (LIVE {name, steps[{tool_id, handoff}]} schema)
// ════════════════════════════════════════════════════════════════

if (!existsSync(CHAINGRAPH_JSON)) {
  console.log(`CHAINGRAPH_JSON not found: ${CHAINGRAPH_JSON} — skipping Layer 2 chains[] validation.`);
} else {
  let cg;
  try { cg = JSON.parse(readFileSync(CHAINGRAPH_JSON, 'utf8')); }
  catch (e) { errors.push(`[L2] chaingraph.json parse error: ${e.message}`); cg = null; }

  if (cg) {
    const chains = cg.chains || [];
    const nodeIds = new Set((cg.nodes || []).map((n) => n.tool_id));
    const repoPresent = existsSync(TOOLS_DIR);
    const seenNames = new Set();

    console.log(`[Layer 2] Validating ${chains.length} chains[] entries in chaingraph.json v${cg.version}`);

    for (const chain of chains) {
      const id = chain.name || '(missing name)';
      const prefix = `[L2:${id}]`;

      // S1 — required fields
      if (!chain.name) errors.push(`${prefix} missing name`);
      if (!chain.title) warnings.push(`${prefix} missing title`);
      if (!Array.isArray(chain.steps) || chain.steps.length === 0) {
        errors.push(`${prefix} steps[] missing or empty`);
      }

      // S2 — name uniqueness
      if (chain.name) {
        if (seenNames.has(chain.name)) errors.push(`${prefix} duplicate chain name`);
        else seenNames.add(chain.name);
      }

      // S3 — step tool_id resolution
      (chain.steps || []).forEach((step, i) => {
        if (!step.tool_id) { errors.push(`${prefix} step ${i + 1} missing tool_id`); return; }
        if (!step.handoff) warnings.push(`${prefix} step ${i + 1} (${step.tool_id}) missing handoff`);
        if (nodeIds.has(step.tool_id)) return; // resolves to a chaingraph node
        if (repoPresent) {
          const asCatalog = join(TOOLS_DIR, `${step.tool_id}.html`);
          const asNode = join(REPO, 'chaingraph', `${step.tool_id}.html`);
          if (!existsSync(asCatalog) && !existsSync(asNode)) {
            errors.push(`${prefix} step ${i + 1} tool_id '${step.tool_id}' resolves to neither a nodes[] entry nor tools/${step.tool_id}.html nor chaingraph/${step.tool_id}.html`);
          }
        }
      });

      // S4 — composer_url existence (WARN; Layer 1 errors on NAMED_CHAINS composer drift)
      if (!chain.composer_url) {
        warnings.push(`${prefix} missing composer_url`);
      } else if (repoPresent) {
        const rel = chain.composer_url.replace('https://ainumbers.co/', '');
        if (!existsSync(join(REPO, rel))) warnings.push(`${prefix} composer_url not found on disk: ${rel}`);
      }

      // S5 (OCG §21.4, v0.8) — decision-gate static validation. No-op for linear chains.
      for (const ge of validateChainGates(chain)) errors.push(`${prefix} ${ge}`);
    }

    const gatedCount = chains.filter((c) => (c.steps || []).some((s) => s && s.gate)).length;
    console.log(`[Layer 2] Done — ${chains.length} chains checked (${gatedCount} with decision gates).\n`);
  }
}

// ════════════════════════════════════════════════════════════════
// LAYER 3 — mcp_name uniqueness (2026-06-19 outage class prevention)
// ════════════════════════════════════════════════════════════════

// Derived from the single source of truth (utility-tools.mjs) — never hardcode this list.
const UTILITY_TOOL_NAMES = new Set(UTILITY_NAMES);

const MANIFEST_DIR = resolve(here, '..', 'data', 'manifests');
const PILOT_MJS    = resolve(here, '..', 'pilot.mjs');

if (!existsSync(CHAINGRAPH_JSON)) {
  console.log(`CHAINGRAPH_JSON not found — skipping Layer 3 mcp_name uniqueness check.`);
} else {
  let cg3;
  try { cg3 = JSON.parse(readFileSync(CHAINGRAPH_JSON, 'utf8')); }
  catch (e) { cg3 = null; }

  if (cg3) {
    const reserved = new Set(UTILITY_TOOL_NAMES);
    let pilotSlugs = [];
    try {
      // Dynamic import() requires a file:// URL for absolute paths on Windows
      // (a bare "C:\..." path is parsed as URL scheme "c:" and throws
      // ERR_UNSUPPORTED_ESM_URL_SCHEME) — pathToFileURL() makes this work
      // identically on Windows and POSIX. See scripts/hash-sweep.mjs for the
      // same pattern already in use elsewhere in this repo.
      const pilotMod = await import(pathToFileURL(PILOT_MJS).href);
      pilotSlugs = pilotMod.PILOT ?? [];
    } catch (err) {
      warnings.push(`[L3] Could not import pilot.mjs — PILOT widget names not included in collision check (${err.code || err.message})`);
    }
    for (const slug of pilotSlugs) {
      const manifestPath = join(MANIFEST_DIR, `${slug}.manifest.json`);
      if (existsSync(manifestPath)) {
        try {
          const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
          reserved.add(m.mcp_tool_definition?.name ?? slug.replace(/-/g, '_'));
        } catch (_) {
          warnings.push(`[L3] Could not parse manifest for pilot slug '${slug}' — skipping its name from collision check`);
        }
      } else {
        warnings.push(`[L3] Manifest not found for pilot slug '${slug}' at data/manifests/ — skipping its name from collision check`);
      }
    }

    const seenNodeNames = new Map();
    let l3NodeCount = 0;
    for (const node of (cg3.nodes ?? [])) {
      if (node.status !== 'live') continue;
      const toolName = node.mcp_name;
      if (!toolName) { warnings.push(`[L3:${node.tool_id}] live node has no mcp_name — will be skipped by worker`); continue; }
      l3NodeCount++;
      if (reserved.has(toolName)) {
        errors.push(`[L3:${node.tool_id}] mcp_name '${toolName}' collides with a PILOT widget or utility tool name. The worker's _registeredMcpNames Set will skip this node silently — rename the mcp_name in chaingraph.json.`);
      }
      if (seenNodeNames.has(toolName)) {
        errors.push(`[L3:${node.tool_id}] mcp_name '${toolName}' is already used by node '${seenNodeNames.get(toolName)}'. Duplicate mcp_names cause buildServer() to throw "Tool already registered" and crash /mcp. Give this node a unique mcp_name in chaingraph.json.`);
      } else {
        seenNodeNames.set(toolName, node.tool_id);
      }
    }

    const l3Collisions = errors.filter((e) => e.startsWith('[L3')).length;
    if (l3Collisions === 0) console.log(`[Layer 3] OK — ${l3NodeCount} live nodes, ${reserved.size} reserved names, 0 collisions.\n`);
    else console.error(`[Layer 3] FAIL — ${l3Collisions} mcp_name collision(s) detected.\n`);
  }
}

// ════════════════════════════════════════════════════════════════
// Summary
// ════════════════════════════════════════════════════════════════

if (warnings.length) {
  console.log(`WARNINGS (${warnings.length}):`);
  for (const w of warnings) console.log('  ⚠ ' + w);
  console.log('');
}
if (errors.length) {
  console.error(`ERRORS (${errors.length}):`);
  for (const e of errors) console.error('  ✗ ' + e);
  console.error('\nFAIL — fix the above before deploying.');
  process.exit(1);
}
console.log('OK — all chain slugs, composer/chain pages, and chains[] entries validate.');
