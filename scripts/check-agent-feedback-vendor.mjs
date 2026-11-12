// check-agent-feedback-vendor.mjs — WEBMCP-FEEDBACK-COLLECTOR-1 vendor twin byte-equality gate.
//
// The vendored twin (data/mcp/agent-feedback.schema.json) is the schema the /feedback route
// ENFORCES; the site's .well-known/agent-feedback.schema.json is the schema reporting agents
// READ. They must stay byte-equal or the two ends of the feedback loop disagree.
//
// Source precedence (mirrors check-vendor-fresh.mjs's committed-HEAD posture — never a
// working-tree read, which could carry uncommitted site edits):
//   1. the local site repo's origin/main via `git show` (site checkout present — local dev
//      and the GLM/worker lanes);
//   2. raw.githubusercontent.com main (worker CI has no site checkout — needs network).
// RED means: re-run `node generate.mjs` (it vendors from the site repo) and commit the
// refreshed twin in the same push as the site-side schema change. Never hand-edit the vendored
// copy — it is generate.mjs output.
//
// Run: node scripts/check-agent-feedback-vendor.mjs

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VENDORED = resolve(ROOT, 'data', 'mcp', 'agent-feedback.schema.json');
const SITE_PATH = '.well-known/agent-feedback.schema.json';
const SITE_RAW_URL = 'https://raw.githubusercontent.com/PostOakLabs/ainumbers/main/' + SITE_PATH;

function siteFromLocalRepo() {
  const candidates = [process.env.AINUMBERS_REPO, resolve(ROOT, '..', 'repo')].filter(Boolean);
  for (const site of candidates) {
    try {
      execFileSync('git', ['-C', site, 'rev-parse', '--is-inside-work-tree'], { stdio: 'ignore' });
      execFileSync('git', ['-C', site, 'rev-parse', '--verify', 'origin/main'], { stdio: 'ignore' });
      // GIT_DIR/GIT_INDEX_FILE can be inherited from a hook context and point git -C at the
      // WRONG repo (check-vendor-fresh.mjs:27-30) — strip the git vars for this read.
      const cleanEnv = { ...process.env };
      for (const k of Object.keys(cleanEnv)) if (k.startsWith('GIT_')) delete cleanEnv[k];
      return execFileSync('git', ['-C', site, 'show', 'origin/main:' + SITE_PATH], { maxBuffer: 1e8, env: cleanEnv });
    } catch { /* try next candidate / fall through to raw */ }
  }
  return null;
}

async function siteFromRaw() {
  const res = await fetch(SITE_RAW_URL);
  if (!res.ok) throw new Error('raw fetch ' + SITE_RAW_URL + ' -> HTTP ' + res.status);
  return Buffer.from(await res.arrayBuffer());
}

const vendored = readFileSync(VENDORED);   // a missing twin is a hard RED (generate.mjs owns it)

let source = null;
let via = '';
const local = siteFromLocalRepo();
if (local) { source = local; via = 'local site repo origin/main'; }
else {
  try { source = await siteFromRaw(); via = 'raw.githubusercontent.com main'; }
  catch (e) {
    console.error('❌ REFUSING: no vendored-twin source reachable.');
    console.error('   No local site repo served origin/main:' + SITE_PATH + ' and the raw fetch failed:');
    console.error('     ' + String(e));
    process.exit(1);
  }
}

if (!source.equals(vendored)) {
  console.error('❌ REFUSING: vendored twin is NOT byte-equal to the site file (via ' + via + ').');
  console.error('   vendored: ' + vendored.length + ' bytes | site: ' + source.length + ' bytes');
  console.error('   Fix: re-run `node generate.mjs` (it vendors from the site repo) and commit the refreshed');
  console.error('   twin in the same push as the site-side schema change. Never hand-edit the vendored copy.');
  process.exit(1);
}
console.log('✅ agent-feedback schema twin byte-equal to site ' + via + ' (' + vendored.length + ' bytes).');
