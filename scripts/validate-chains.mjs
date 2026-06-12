#!/usr/bin/env node
/**
 * validate-chains.mjs — pre-deploy integrity check for the AINumbers MCP server.
 *
 * Cross-checks every `NAMED_CHAINS` entry in worker.mjs against the actual
 * deployable site in ../repo, catching the class of drift where a chain
 * references a tool slug or composer page that doesn't exist, or where a
 * chain's tool sequence disagrees with its orchestrated composer.
 *
 * Three checks:
 *   1. ERROR — every chain step `slug` resolves to repo/tools/<slug>.html
 *   2. ERROR — every chain `composer_url` resolves to repo/guides/<file>.html
 *   3. WARN  — for chains with a composer, the chain's ordered slug list
 *              equals the composer's STAGES slug list (catches divergence
 *              even when both files exist).
 *
 * Exit code: 1 if any ERROR, else 0. Run before `npx wrangler deploy`.
 *
 * Paths resolve relative to this script (mcp-apps-poc/scripts/), assuming the
 * canonical workspace layout where repo/ and mcp-apps-poc/ are siblings.
 * Override with env vars: WORKER_PATH, TOOLS_DIR, GUIDES_DIR.
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = process.env.WORKER_PATH || resolve(here, '..', 'worker.mjs');
const TOOLS_DIR   = process.env.TOOLS_DIR   || resolve(here, '..', '..', 'repo', 'tools');
const GUIDES_DIR  = process.env.GUIDES_DIR  || resolve(here, '..', '..', 'repo', 'guides');

const errors = [];
const warnings = [];

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
  // Top-level chain keys sit at 2-space indent: e.g.  'aml-programme': {
  const headerRe = /\n  '([a-z0-9-]+)':\s*\{/g;
  const heads = [];
  let m;
  while ((m = headerRe.exec(block)) !== null) heads.push({ id: m[1], at: m.index });

  const slugRe = /slug:\s*'([^']+)'/g;
  const composerRe = /composer_url:\s*BASE_URL\s*\+\s*'([^']+)'/;

  return heads.map((h, i) => {
    const seg = block.slice(h.at, i + 1 < heads.length ? heads[i + 1].at : block.length);
    const slugs = [];
    let s;
    while ((s = slugRe.exec(seg)) !== null) slugs.push(s[1]);
    const cm = seg.match(composerRe);
    const composerFile = cm ? cm[1].replace(/^\/guides\//, '') : null;
    return { id: h.id, slugs, composerFile };
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

// ---- run ----
const src = readFileSync(WORKER_PATH, 'utf8');
const chains = parseChains(extractNamedChainsBlock(src));

if (!existsSync(TOOLS_DIR)) {
  console.log(`TOOLS_DIR not found: ${TOOLS_DIR} — skipping chain validation (repo not checked out).`);
  process.exit(0);
}

let stepCount = 0;
for (const c of chains) {
  // Check 1: tool files exist
  for (const slug of c.slugs) {
    stepCount++;
    if (!existsSync(join(TOOLS_DIR, `${slug}.html`))) {
      errors.push(`[${c.id}] missing tool file: tools/${slug}.html`);
    }
  }
  // Check 2: composer file exists
  if (c.composerFile) {
    const gp = join(GUIDES_DIR, c.composerFile);
    if (!existsSync(gp)) {
      errors.push(`[${c.id}] missing composer page: guides/${c.composerFile}`);
    } else {
      // Check 3: chain slug sequence == composer STAGES slug sequence
      const compSlugs = composerSlugs(readFileSync(gp, 'utf8'));
      const a = c.slugs.join(' > ');
      const b = compSlugs.join(' > ');
      if (a !== b) {
        warnings.push(
          `[${c.id}] chain/composer sequence mismatch:\n` +
          `    chain    : ${a || '(none)'}\n` +
          `    composer : ${b || '(none)'}`
        );
      }
    }
  }
}

console.log(`Validated ${chains.length} chains, ${stepCount} step slugs against ${TOOLS_DIR}\n`);
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
console.log('OK — all chain slugs and composer pages resolve.');
