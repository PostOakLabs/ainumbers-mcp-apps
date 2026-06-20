#!/usr/bin/env node
// hash-sweep.mjs — POST-DEPLOY hash gate (fixture-free). The automation missing in the hash incident.
// For EVERY live gpu:false node, calls the deployed tool (compute:"server", empty policy_parameters
// unless a fixture exists) and verifies BOTH:
//   (1) the worker's own  hash_valid === true  (its SHA-256 over the canonical {policy_parameters,
//       output_payload}), and
//   (2) an INDEPENDENT local re-derivation via the shared kernels/_hash.mjs reproduces
//       artifact.execution_hash — so the worker isn't merely trusting itself.
// A broken kernel (the Arc class: compute_mode:server but hash_valid:false) fails here, live.
//
// No fixtures required: the live worker call confirmed empty {} inputs run with kernel defaults and
// return hash_valid:true. If a kernels/fixtures/<id>.fixtures.json exists, its inputs are used instead.
//
// Usage (run after deploy, gently — the /mcp WAF rate-limit blocks bursts):
//   MCP_URL=https://mcp.ainumbers.co/mcp THROTTLE_MS=1500 node hash-sweep.mjs
//   STRICT_LOCAL=1 node hash-sweep.mjs   # also FAIL if the local re-derivation disagrees (default: warn)
// Placement: WORKER repo (mcp-apps-poc/) post-deploy job, after smoke-mcp.

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MCP_URL = process.env.MCP_URL || 'https://mcp.ainumbers.co/mcp';
const THROTTLE_MS = Number(process.env.THROTTLE_MS || 1500);
const RETRIES = Number(process.env.MCP_SMOKE_RETRIES || 1);
const PROTO = process.env.MCP_PROTOCOL_VERSION || '2025-06-18';
const STRICT_LOCAL = process.env.STRICT_LOCAL === '1';

const CHAINGRAPH = process.env.CHAINGRAPH || firstExisting([
  join(HERE, '..', 'mcp-apps-poc', 'data', 'chaingraph', 'chaingraph.json'),
  join(HERE, '..', 'repo', 'chaingraph', 'chaingraph.json'),
]);
const KERNELS_DIR = process.env.KERNELS_DIR || firstExisting([
  join(HERE, '..', 'mcp-apps-poc', 'kernels'),
  join(HERE, '..', 'repo', 'chaingraph', 'kernels'),
]);
const FIXTURES_DIR = process.env.FIXTURES_DIR || join(KERNELS_DIR, 'fixtures');
function firstExisting(ps) { return ps.find((p) => existsSync(p)) || ps[0]; }

// the ONE shared canonicalizer (file:// URL required for dynamic import on Windows)
let executionHash;
try {
  ({ executionHash } = await import(pathToFileURL(join(KERNELS_DIR, '_hash.mjs')).href));
} catch (e) {
  console.error(`FATAL: cannot import canonical _hash.mjs from ${KERNELS_DIR} — ${e.message}`);
  process.exit(2);
}

const cg = JSON.parse(readFileSync(CHAINGRAPH, 'utf8'));
const nodes = (cg.nodes || []).filter((n) => n.gpu === false && n.status === 'live' && n.mcp_name);
console.log(`hash-sweep · ${nodes.length} live gpu:false nodes · ${MCP_URL} · throttle ${THROTTLE_MS}ms\n`);

let pass = 0, fail = 0, needInput = 0, localWarn = 0, id = 1;
for (const n of nodes) {
  const pp = loadFixtureArgs(n.tool_id) || {};
  const usingFixture = pp && Object.keys(pp).length > 0;
  const r = await callTool(n.mcp_name, { compute: 'server', policy_parameters: pp });
  if (!r.ok) { console.error(`✗ ${n.tool_id}: MCP transport failed — ${r.error}`); fail++; await sleep(THROTTLE_MS); continue; }

  // A tool-level error. With empty {} inputs, "X is required" / NaN-from-empty are INPUT issues
  // (the kernel + _hash.mjs guard are fine) — only verifiable with a real fixture. Anything else fails.
  if (r.errorText) {
    if (!usingFixture && /required|missing|provide|non-?finite|nan|must |expected|undefined/i.test(r.errorText)) {
      console.warn(`· ${n.tool_id}: needs input — ${r.errorText.replace(/\s+/g, ' ').slice(0, 90)} (empty {} can't exercise it; add kernels/fixtures/${n.tool_id}.fixtures.json)`); needInput++;
    } else { console.error(`✗ ${n.tool_id}: tool error — ${r.errorText.replace(/\s+/g, ' ').slice(0, 110)}`); fail++; }
    await sleep(THROTTLE_MS); continue;
  }

  const p = r.payload, a = p?.artifact;
  if (p?.hash_valid === false) { console.error(`✗ ${n.tool_id}: hash_valid=false (broken kernel — the Arc class)`); fail++; await sleep(THROTTLE_MS); continue; }
  if (!a || !a.execution_hash || a.policy_parameters === undefined || a.output_payload === undefined) {
    console.error(`✗ ${n.tool_id}: response not a v0.4 artifact (no hash_valid / execution_hash)`); fail++; await sleep(THROTTLE_MS); continue;
  }
  // independent re-derivation (two positional args, bare hex)
  let local;
  try { local = await executionHash(a.policy_parameters, a.output_payload); } catch (e) { local = `ERR:${e.message}`; }
  const got = String(a.execution_hash).replace(/^sha256:/, '');
  if (local === got) { console.log(`✓ ${n.tool_id}: hash_valid + local re-derive match`); pass++; }
  else {
    const msg = `${n.tool_id}: worker hash_valid but local re-derive differs\n    worker ${got}\n    local  ${local}`;
    if (STRICT_LOCAL) { console.error(`✗ ${msg}`); fail++; }
    else { console.warn(`⚠ ${msg} (worker hash_valid:true accepted; set STRICT_LOCAL=1 to fail)`); pass++; localWarn++; }
  }
  await sleep(THROTTLE_MS);
}

console.log(`\n${pass} hash-valid, ${fail} failed, ${needInput} need-input (empty {} insufficient)${localWarn ? `, ${localWarn} local warning(s)` : ''}.`);
if (needInput) console.log(`  → the ${needInput} need-input node(s) require a fixture to exercise — NOT a hash failure (the kernel + _hash.mjs guard are working).`);
if (fail) { console.error('hash-sweep FAILED — a deployed node returned hash_valid=false or an unexpected error.'); process.exitCode = 1; }
else process.exitCode = 0;

// ---- helpers ----
function loadFixtureArgs(toolId) {
  const f = join(FIXTURES_DIR, `${toolId}.fixtures.json`);
  if (!existsSync(f)) return null;
  let doc; try { doc = JSON.parse(readFileSync(f, 'utf8')); } catch { return null; }
  const one = Array.isArray(doc) ? doc[0] : doc.cases ? doc.cases[0] : doc;
  return one.policy_parameters?.input_parameters || one.policy_parameters || one.input_parameters || one.arguments || null;
}

async function callTool(name, args, attempt = 0) {
  try {
    const res = await fetch(MCP_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream', // both — JSON-only => HTTP 406
        'mcp-protocol-version': PROTO,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: id++, method: 'tools/call', params: { name, arguments: args } }),
    });
    if (res.status === 503 && attempt < RETRIES) { await sleep(THROTTLE_MS * 2); return callTool(name, args, attempt + 1); }
    const text = await res.text();
    if (!res.ok) return { ok: false, error: `HTTP ${res.status} ${text.slice(0, 120)}` };
    const j = parseMaybeSSE(text, res.headers.get('content-type') || '');
    if (!j) return { ok: false, error: 'unparseable response' };
    if (j.error) return { ok: true, errorText: j.error.message || JSON.stringify(j.error) }; // JSON-RPC error → classify in main
    const result = j.result ?? j;
    const sc = result.structuredContent;
    const textPayload = result.content?.find?.((c) => c.type === 'text')?.text;
    const parsedText = textPayload ? safeParse(textPayload) : null;
    const payload = sc || parsedText || result;
    // a tool error surfaces as isError, or as a plain-text (non-JSON) content payload
    const errorText = result.isError ? (textPayload || 'tool error')
      : (textPayload && parsedText === null ? textPayload : null);
    return { ok: true, payload, errorText };
  } catch (e) {
    if (attempt < RETRIES) { await sleep(THROTTLE_MS * 2); return callTool(name, args, attempt + 1); }
    return { ok: false, error: e.message };
  }
}

function parseMaybeSSE(text, ct) {
  const t = text.trim();
  if (ct.includes('application/json') || t.startsWith('{')) { try { return JSON.parse(t); } catch {} }
  const data = t.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim());
  for (let i = data.length - 1; i >= 0; i--) { try { return JSON.parse(data[i]); } catch {} }
  try { return JSON.parse(t); } catch { return null; }
}
function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }
// function declaration (hoisted) — the top-level await loop calls sleep() before this line,
// so a `const sleep = …` would be in the temporal dead zone (ReferenceError on Windows/Node 24).
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
