#!/usr/bin/env node
/**
 * validate-chains.mjs — pre-deploy integrity check for the AINumbers MCP server.
 *
 * THREE VALIDATION LAYERS:
 *
 * Layer 1 (original) — NAMED_CHAINS cross-check
 *   Validates every NAMED_CHAINS entry in worker.mjs against the actual deployable
 *   site in ../repo, catching the class of drift where a chain references a tool
 *   slug or composer page that doesn't exist, or where a chain's tool sequence
 *   disagrees with its orchestrated composer.
 *
 *   Three checks:
 *     1. ERROR — every chain step `slug` resolves to repo/tools/<slug>.html
 *     2. ERROR — every chain `composer_url` resolves to repo/guides/<file>.html
 *                OR to repo/chaingraph/chains/<file>.html (after conversion)
 *     3. WARN  — for chains with a composer, the chain's ordered slug list
 *                equals the composer's STAGES slug list (catches divergence
 *                even when both files exist).
 *
 * Layer 2 (Amendment A3) — chaingraph.json chains[] validation
 *   Validates the `chains[]` array in repo/chaingraph/chaingraph.json against
 *   the schema defined in CONTRACT A3 / Appendix D:
 *     R1. Referential integrity: every steps[].node_id and consumes[] and branch
 *         step_overrides value resolves to a nodes[].tool_id in the same file.
 *     R2. mcp_name agreement: each steps[].mcp_name equals the referenced node's.
 *     R3. Ordering: steps[].order contiguous 1..N; consumes[] for order:1 is [].
 *     R4. chain_id ↔ worker: chain_id equals its NAMED_CHAINS key (when NAMED_CHAINS
 *         is populated from chains[]); composer_url equals page_url.
 *     R5. Page exists: page_url resolves to a real repo/chaingraph/chains/<id>.html.
 *     R6. Branching: branches present iff branching:true; every override node resolves.
 *     R7. Deletion provenance: every path in supersedes[] in the delete manifest;
 *         none may still exist in guides/ after the chain goes live.
 *     R8. Discoverability: every live chain_id appears in llms.txt and sitemap.xml.
 *     R9. Curation: status:"live" requires five_tests_pass:true.
 *
 * Layer 3 — mcp_name uniqueness gate (2026-06-19 outage prevention)
 *   Reads live nodes from chaingraph.json and PILOT tool names from data/manifests/.
 *   Errors if any two live nodes share an mcp_name, or if any live node mcp_name
 *   collides with a PILOT widget name or one of the 6 hardcoded utility tool names.
 *   This is the pre-deploy version of the runtime dedup guard in worker.mjs
 *   (_registeredMcpNames Set) — it catches the collision BEFORE deploying rather
 *   than silently skipping at runtime.
 *
 *   Why: buildServer() registers PILOT widget tools first (via registerAppTool), then
 *   the 6 utility tools, then ChainGraph live nodes. If a node mcp_name collides with
 *   any previously registered name the SDK throws "Tool X is already registered",
 *   buildServer() aborts, and every /mcp handshake fails with 500 while /health stays
 *   green. Happened twice through green CI (2026-06-19) because "bundle compiles" ≠
 *   "/mcp initializes". This layer closes that gap pre-deploy.
 *
 * Exit code: 1 if any ERROR in any layer, else 0.
 * Run before `npx wrangler deploy` (or `npm run validate:chains` from mcp-apps-poc/).
 *
 * Paths resolve relative to this script (mcp-apps-poc/scripts/), assuming the
 * canonical workspace layout where repo/ and mcp-apps-poc/ are siblings.
 * Override with env vars: WORKER_PATH, TOOLS_DIR, GUIDES_DIR, CHAINGRAPH_JSON,
 *   CHAINS_DIR, LLMS_TXT, SITEMAP_XML.
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const REPO          = resolve(here, '..', '..', 'repo');
const WORKER_PATH   = process.env.WORKER_PATH    || resolve(here, '..', 'worker.mjs');
const TOOLS_DIR     = process.env.TOOLS_DIR      || join(REPO, 'tools');
const GUIDES_DIR    = process.env.GUIDES_DIR     || join(REPO, 'guides');
const CHAINGRAPH_JSON = process.env.CHAINGRAPH_JSON || join(REPO, 'chaingraph', 'chaingraph.json');
const CHAINS_DIR    = process.env.CHAINS_DIR     || join(REPO, 'chaingraph', 'chains');
const LLMS_TXT      = process.env.LLMS_TXT       || join(REPO, 'llms.txt');
const SITEMAP_XML   = process.env.SITEMAP_XML    || join(REPO, 'sitemap.xml');

const errors   = [];
const warnings = [];

// ════════════════════════════════════════════════════════════════
// LAYER 1 — NAMED_CHAINS in worker.mjs
// ════════════════════════════════════════════════════════════════

/** Extract the `const NAMED_CHAINS = { ... };` object body by brace-matching. */
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

/** Parse chains into { id, slugs[], composerFile|null } using top-level keys. */
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

/** Pull tool slugs from a composer's STAGES (slug:'…' entries that look like tools). */
function composerSlugs(html) {
  const re = /slug:\s*'([^']+)'/g;
  const out = [];
  let m;
  while ((m = re.exec(html)) !== null) {
    if (/^(\d+|rbe-)/.test(m[1])) out.push(m[1]);
  }
  return out;
}

let layer1Ran = false;
let ncChains  = [];

if (!existsSync(TOOLS_DIR)) {
  console.log(`TOOLS_DIR not found: ${TOOLS_DIR} — skipping Layer 1 chain validation (repo not checked out).`);
} else {
  layer1Ran = true;
  const src = readFileSync(WORKER_PATH, 'utf8');
  ncChains = parseChains(extractNamedChainsBlock(src));

  let stepCount = 0;
  for (const c of ncChains) {
    // Check 1: tool files exist
    for (const slug of c.slugs) {
      stepCount++;
      const toolPath = join(TOOLS_DIR, `${slug}.html`);
      const chainNodePath = join(REPO, 'chaingraph', `${slug}.html`); // promoted node
      if (!existsSync(toolPath) && !existsSync(chainNodePath)) {
        errors.push(`[L1:${c.id}] missing tool/node file: tools/${slug}.html (also checked chaingraph/${slug}.html)`);
      }
    }
    // Check 2: composer/chain page exists
    if (c.composerFile) {
      let fp;
      if (c.composerIsChain) {
        fp = join(CHAINS_DIR, c.composerFile);
        if (!existsSync(fp)) {
          errors.push(`[L1:${c.id}] missing chain page: chaingraph/chains/${c.composerFile}`);
        }
        // No sequence divergence check for chain pages (they don't have STAGES)
      } else {
        fp = join(GUIDES_DIR, c.composerFile);
        if (!existsSync(fp)) {
          errors.push(`[L1:${c.id}] missing composer page: guides/${c.composerFile}`);
        } else {
          // Check 3: chain slug sequence == composer STAGES slug sequence
          const compSlugs = composerSlugs(readFileSync(fp, 'utf8'));
          const a = c.slugs.join(' > ');
          const b = compSlugs.join(' > ');
          if (a !== b) {
            warnings.push(
              `[L1:${c.id}] chain/composer sequence mismatch:\n` +
              `    chain    : ${a || '(none)'}\n` +
              `    composer : ${b || '(none)'}`
            );
          }
        }
      }
    }
  }
  console.log(`[Layer 1] Validated ${ncChains.length} NAMED_CHAINS, ${stepCount} step slugs against ${TOOLS_DIR}`);
}

// ════════════════════════════════════════════════════════════════
// LAYER 2 — chaingraph.json chains[] (CONTRACT Amendment A3)
// ════════════════════════════════════════════════════════════════

if (!existsSync(CHAINGRAPH_JSON)) {
  console.log(`CHAINGRAPH_JSON not found: ${CHAINGRAPH_JSON} — skipping Layer 2 chains[] validation.`);
} else {
  let cg;
  try {
    cg = JSON.parse(readFileSync(CHAINGRAPH_JSON, 'utf8'));
  } catch (e) {
    errors.push(`[L2] chaingraph.json parse error: ${e.message}`);
    cg = null;
  }

  if (cg) {
    const chains = cg.chains || [];
    // Build a lookup of node tool_ids from nodes[]
    const nodeMap = new Map(); // tool_id -> node
    for (const node of (cg.nodes || [])) {
      nodeMap.set(node.tool_id, node);
    }

    // Read discoverability files (best-effort; skip if absent)
    const llmsTxt   = existsSync(LLMS_TXT)   ? readFileSync(LLMS_TXT, 'utf8')   : '';
    const sitemapXml = existsSync(SITEMAP_XML) ? readFileSync(SITEMAP_XML, 'utf8') : '';
    // Build a set of chain_ids present in NAMED_CHAINS (worker)
    const ncIds = new Set(ncChains.map(c => c.id));

    console.log(`[Layer 2] Validating ${chains.length} chains[] entries in chaingraph.json v${cg.version}`);

    for (const chain of chains) {
      const id = chain.chain_id || '(missing chain_id)';
      const prefix = `[L2:${id}]`;

      // R1. Referential integrity
      const allNodeRefs = [];
      for (const step of (chain.steps || [])) {
        if (step.node_id) allNodeRefs.push({ ref: step.node_id, ctx: `step ${step.order} node_id` });
        for (const c of (step.consumes || [])) {
          allNodeRefs.push({ ref: c, ctx: `step ${step.order} consumes[]` });
        }
      }
      if (chain.branching && chain.branches) {
        for (const [branchKey, branch] of Object.entries(chain.branches)) {
          for (const [, nodeId] of Object.entries(branch.step_overrides || {})) {
            allNodeRefs.push({ ref: nodeId, ctx: `branch '${branchKey}' step_override` });
          }
        }
      }
      for (const { ref, ctx } of allNodeRefs) {
        if (!nodeMap.has(ref)) {
          errors.push(`${prefix} R1: ${ctx} references unknown node_id '${ref}' — not in nodes[]`);
        }
      }

      // R2. mcp_name agreement
      for (const step of (chain.steps || [])) {
        if (!step.node_id) continue;
        const node = nodeMap.get(step.node_id);
        if (node && step.mcp_name && step.mcp_name !== node.mcp_name) {
          errors.push(`${prefix} R2: step ${step.order} mcp_name '${step.mcp_name}' ≠ node mcp_name '${node.mcp_name}'`);
        }
      }

      // R3. Ordering — contiguous 1..N; root step consumes []
      const steps = (chain.steps || []).slice().sort((a, b) => a.order - b.order);
      for (let i = 0; i < steps.length; i++) {
        if (steps[i].order !== i + 1) {
          errors.push(`${prefix} R3: steps[].order is not contiguous — got ${steps.map(s => s.order).join(',')}, expected 1..${steps.length}`);
          break;
        }
      }
      if (steps.length > 0 && steps[0].consumes && steps[0].consumes.length > 0) {
        errors.push(`${prefix} R3: root step (order:1) consumes[] must be [] — got [${steps[0].consumes.join(',')}]`);
      }

      // R4. chain_id ↔ worker NAMED_CHAINS (warn if not yet generated)
      if (chains.some(c => c.status === 'live') && ncIds.size > 0) {
        if (chain.status === 'live' && !ncIds.has(id)) {
          warnings.push(`${prefix} R4: chain_id '${id}' is live but missing from NAMED_CHAINS — regenerate worker projection`);
        }
      }

      // R5. Page exists
      if (chain.page_url) {
        // Extract path portion from URL
        const urlPath = chain.page_url.replace('https://ainumbers.co', '');
        const chainSlug = urlPath.replace('/chaingraph/chains/', '').replace('.html', '');
        const chainFile = join(CHAINS_DIR, `${chainSlug}.html`);
        if (chain.status === 'live' && !existsSync(chainFile)) {
          errors.push(`${prefix} R5: page_url resolves to chaingraph/chains/${chainSlug}.html but file does not exist`);
        } else if (chain.status !== 'live' && !existsSync(chainFile)) {
          warnings.push(`${prefix} R5: page_url resolves to chaingraph/chains/${chainSlug}.html — file not yet built (status: ${chain.status})`);
        }
      } else {
        errors.push(`${prefix} R5: missing page_url`);
      }

      // R6. Branching consistency
      if (chain.branching && !chain.branches) {
        errors.push(`${prefix} R6: branching:true but branches object is absent`);
      }
      if (!chain.branching && chain.branches) {
        warnings.push(`${prefix} R6: branches object present but branching:false`);
      }

      // R7. Deletion provenance — warn if superseded guide files still exist
      for (const sup of (chain.supersedes || [])) {
        const supPath = join(REPO, sup);
        if (existsSync(supPath) && chain.status === 'live') {
          warnings.push(`${prefix} R7: superseded file '${sup}' still exists — delete after Tim's parity sign-off`);
        }
      }

      // R8. Discoverability — every live chain in llms.txt and sitemap
      if (chain.status === 'live') {
        if (llmsTxt && !llmsTxt.includes(id)) {
          errors.push(`${prefix} R8: live chain '${id}' not found in llms.txt`);
        }
        if (sitemapXml && !sitemapXml.includes(id)) {
          errors.push(`${prefix} R8: live chain '${id}' not found in sitemap.xml`);
        }
      }

      // R9. Curation gate
      if (chain.status === 'live' && chain.five_tests_pass !== true) {
        errors.push(`${prefix} R9: status is 'live' but five_tests_pass is not true`);
      }
    }

    console.log(`[Layer 2] Done — ${chains.length} chains checked.\n`);
  }
}

// ════════════════════════════════════════════════════════════════
// LAYER 3 — mcp_name uniqueness (2026-06-19 outage class prevention)
// Runs from data/manifests/ (committed, available in CI without ../repo).
// ════════════════════════════════════════════════════════════════

// Utility tool names hardcoded to match the set in worker.mjs _registeredMcpNames seed.
// If worker.mjs adds or removes utility tools, update this list to match.
const UTILITY_TOOL_NAMES = new Set([
  'list_ainumbers_tools',
  'build_workflow_links',
  'verify_execution_hash',
  'build_chaingraph',
  'emit_chaingraph_artifact',
  'build_session_receipt',
]);

// data/manifests/ is committed and available in CI (unlike ../repo).
// Use CHAINGRAPH_JSON path we already know about; the manifest dir is parallel.
const MANIFEST_DIR = resolve(here, '..', 'data', 'manifests');
const PILOT_MJS    = resolve(here, '..', 'pilot.mjs');

// Only run Layer 3 when chaingraph.json is reachable (same guard as Layer 2).
if (!existsSync(CHAINGRAPH_JSON)) {
  console.log(`CHAINGRAPH_JSON not found — skipping Layer 3 mcp_name uniqueness check.`);
} else {
  let cg3;
  try {
    cg3 = JSON.parse(readFileSync(CHAINGRAPH_JSON, 'utf8'));
  } catch (e) {
    // parse error already reported by Layer 2; skip Layer 3 quietly
    cg3 = null;
  }

  if (cg3) {
    // Build the set of reserved names: PILOT widget names + utility tool names.
    // PILOT manifest files live in data/manifests/<slug>.manifest.json (committed).
    const reserved = new Set(UTILITY_TOOL_NAMES);
    let pilotSlugs = [];
    try {
      // Dynamic import of pilot.mjs to get the PILOT slug list.
      const pilotMod = await import(PILOT_MJS);
      pilotSlugs = pilotMod.PILOT ?? [];
    } catch (_) {
      warnings.push('[L3] Could not import pilot.mjs — PILOT widget names not included in collision check');
    }
    for (const slug of pilotSlugs) {
      const manifestPath = join(MANIFEST_DIR, `${slug}.manifest.json`);
      if (existsSync(manifestPath)) {
        try {
          const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
          const toolName = m.mcp_tool_definition?.name ?? slug.replace(/-/g, '_');
          reserved.add(toolName);
        } catch (_) {
          warnings.push(`[L3] Could not parse manifest for pilot slug '${slug}' — skipping its name from collision check`);
        }
      } else {
        warnings.push(`[L3] Manifest not found for pilot slug '${slug}' at data/manifests/ — skipping its name from collision check`);
      }
    }

    // Check live nodes for duplicate mcp_names and collisions with reserved names.
    const seenNodeNames = new Map(); // mcp_name → tool_id
    let l3NodeCount = 0;

    for (const node of (cg3.nodes ?? [])) {
      if (node.status !== 'live') continue;
      const toolName = node.mcp_name;
      if (!toolName) {
        warnings.push(`[L3:${node.tool_id}] live node has no mcp_name — will be skipped by worker`);
        continue;
      }
      l3NodeCount++;

      // Check collision with PILOT/utility names
      if (reserved.has(toolName)) {
        errors.push(
          `[L3:${node.tool_id}] mcp_name '${toolName}' collides with a PILOT widget or utility tool name. ` +
          `The worker's _registeredMcpNames Set will skip this node silently — rename the mcp_name in chaingraph.json.`
        );
      }

      // Check duplicate among live nodes
      if (seenNodeNames.has(toolName)) {
        errors.push(
          `[L3:${node.tool_id}] mcp_name '${toolName}' is already used by node '${seenNodeNames.get(toolName)}'. ` +
          `Duplicate mcp_names cause buildServer() to throw "Tool already registered" and crash /mcp. ` +
          `Give this node a unique mcp_name in chaingraph.json.`
        );
      } else {
        seenNodeNames.set(toolName, node.tool_id);
      }
    }

    const l3Collisions = errors.filter(e => e.startsWith('[L3')).length;
    if (l3Collisions === 0) {
      console.log(`[Layer 3] OK — ${l3NodeCount} live nodes, ${reserved.size} reserved names, 0 collisions.\n`);
    } else {
      console.error(`[Layer 3] FAIL — ${l3Collisions} mcp_name collision(s) detected.\n`);
    }
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
