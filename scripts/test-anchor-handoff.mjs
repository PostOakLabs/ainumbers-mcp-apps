// test-anchor-handoff.mjs — ANCHOR-WAVE-B-HANDOFF-1 contract test, mocked bindings.
//
// Every successful server-compute result now carries an `anchor` hand-off
// ({ endpoint, tool: 'anchor_hash', hash }) telling the caller's OWN agent how to timestamp the
// execution_hash it just received. This test proves the invariants the row demands, on BOTH
// server-compute surfaces (the per-node tool and emit_chaingraph_artifact Mode 4):
//   * PREIMAGE SAFETY: the field sits at the RESULT-envelope level, never inside the artifact —
//     the execution_hash recomputes byte-identically from {policy_parameters, output_payload}
//     alone (SSOT hasher, kernels/_hash.mjs), and the vendored compute_proof journal still
//     JCS-matches the produced output_payload (compute_proof_ready 'ready') — i.e. the output is
//     byte-identical to the site-pinned golden WITH the field present;
//   * DETERMINISM: two identical computes return byte-identical artifacts and identical hashes;
//   * ERROR RESULTS ARE CLEAN: no anchor on unknown-tool errors, on browser delegation (explicit
//     compute:"browser", missing policy_parameters), or on a hash-mismatching pre_computed
//     verification;
//   * NO HASHED PAYLOAD CONTAINS IT: a deep scan of the artifact finds no 'anchor' member at any
//     nesting;
//   * the pointer names the anchor server's CURRENT tool list (anchor_hash at
//     https://anchor.ainumbers.co/mcp) — the worker never calls that endpoint on the caller's
//     behalf (privacy promise): the field is a pointer only.
//
// Harness: buildServer + InMemoryTransport (the check-tool-schema-params.mjs idiom) — a tools/call
// through worker.fetch OFFLINE never reaches a tool (the SDK's Node transport shim answers an
// empty HTTP 400; see test-call-tool-dispatch.mjs's measured-limit note), so the in-memory
// transport is the way a tool handler actually executes offline.
//
// Run: node scripts/test-anchor-handoff.mjs   (AFTER `node generate.mjs` — fixtures and the
// vendored chaingraph are read from data/.)

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const DATA_DIR = join(ROOT, 'data');

const mod = await import('../worker.mjs');
const { anchorHandoff, buildServer, loadData } = mod;
const { executionHash: ssotExecutionHash } = await import('../kernels/_hash.mjs');

let failed = 0;
const check = (label, cond, detail = '') => {
  if (cond) console.log('test-anchor-handoff: ' + label + '... ok');
  else { failed++; console.error('test-anchor-handoff: ' + label + '... FAIL' + (detail ? ' — ' + detail : '')); }
};

// Same offline ASSETS stub as check-tool-schema-params.mjs.
const env = { ASSETS: { fetch: async (url) => {
  const u = new URL(typeof url === 'string' ? url : url.url);
  const fp = join(DATA_DIR, decodeURIComponent(u.pathname).replace(/^\/+/, ''));
  return existsSync(fp) ? new Response(readFileSync(fp), { status: 200 }) : new Response('Not Found', { status: 404 });
} } };

const data = await loadData(env);
await data.loadSearchIndex(); // search-index.json is lazy; a full build needs it, as in the /mcp handler

// Drive one callTool against a fresh single-tool (or full) build — the handler executes for real.
async function callTool(args, only) {
  const server = buildServer(data, { ...(only ? { onlyTool: only } : {}), mrtr: { env, args, requestState: null, inputResponses: null, clientCaps: null, principal: 'anchor-handoff-gate' } });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'anchor-handoff-gate', version: '1.0.0' });
  await Promise.all([client.connect(ct), server.connect(st)]);
  try {
    return await client.callTool({ name: only ?? 'zzz_no_such_tool_anchor_test', arguments: args });
  } finally { await client.close(); }
}

// ── helpers ──────────────────────────────────────────────────────────────────────────────────────
// Deep scan: does `key` appear as an object member anywhere inside `obj`?
function hasKeyDeep(obj, key) {
  if (!obj || typeof obj !== 'object') return false;
  if (Array.isArray(obj)) return obj.some((v) => hasKeyDeep(v, key));
  for (const [k, v] of Object.entries(obj)) {
    if (k === key) return true;
    if (hasKeyDeep(v, key)) return true;
  }
  return false;
}

// ── 0. the exported pointer helper ───────────────────────────────────────────────────────────────
check('anchorHandoff shape is exactly {endpoint, tool, hash}',
  JSON.stringify(Object.keys(anchorHandoff('sha256:ab'))) === JSON.stringify(['endpoint', 'tool', 'hash']),
  JSON.stringify(anchorHandoff('x')));
check('anchorHandoff names the anchor server /mcp endpoint + CURRENT anchor_hash tool',
  anchorHandoff('h').endpoint === 'https://anchor.ainumbers.co/mcp' && anchorHandoff('h').tool === 'anchor_hash');
check('anchorHandoff carries the caller-supplied hash verbatim', anchorHandoff('sha256:cd').hash === 'sha256:cd');

// ── fixture inputs: the chain fixture is the same SSOT gen-chain-fixtures writes ─────────────────
const fixtures = JSON.parse(readFileSync(join(DATA_DIR, 'chain-fixtures.json'), 'utf8'));
const NODE_TOOL = 'compute_fr2052a_inflow_outflow_classification';
const NODE_ID = 'art-437-fr2052a-inflow-outflow-classifier';
let pp = null;
for (const steps of Object.values(fixtures)) {
  if (steps[NODE_ID]) { pp = steps[NODE_ID]; break; }
}
if (!pp) {
  check('chain fixture carries inputs for ' + NODE_ID, false, 'no fixture found — run node generate.mjs');
  console.log(`\ntest-anchor-handoff: ${failed} failure(s)`);
  process.exit(1);
}

// ── 1. per-node tool: successful server-compute carries the hand-off, preimage untouched ─────────
const r1 = await callTool({ policy_parameters: pp }, NODE_TOOL);
const sc1 = r1?.structuredContent;
check(NODE_TOOL + ' computes server-side', sc1?.compute_mode === 'server' && !!sc1?.artifact?.execution_hash,
  JSON.stringify(r1 ?? {}).slice(0, 200));
check('server-compute result carries the anchor hand-off', !!sc1?.anchor, JSON.stringify(sc1 && Object.keys(sc1)));
check('hand-off shape is exactly {endpoint, tool, hash}',
  !!sc1?.anchor && JSON.stringify(Object.keys(sc1.anchor)) === JSON.stringify(['endpoint', 'tool', 'hash']),
  JSON.stringify(sc1?.anchor));
check('hand-off names anchor.ainumbers.co/mcp anchor_hash',
  sc1?.anchor?.endpoint === 'https://anchor.ainumbers.co/mcp' && sc1?.anchor?.tool === 'anchor_hash',
  JSON.stringify(sc1?.anchor));
check('hand-off hash IS the artifact execution_hash (verbatim)',
  sc1?.anchor?.hash === sc1?.artifact?.execution_hash,
  'anchor=' + JSON.stringify(sc1?.anchor?.hash) + ' artifact=' + JSON.stringify(sc1?.artifact?.execution_hash));
// PREIMAGE SAFETY, strongest available form: the hash recomputes from {pp, op} alone, and the
// vendored compute_proof journal (site-pinned golden output) still JCS-matches the produced
// output_payload — the worker only stamps compute_proof_ready 'ready' on that exact JCS equality.
const re1 = await ssotExecutionHash(sc1.artifact.policy_parameters, sc1.artifact.output_payload);
check('execution_hash recomputes byte-identically from the {policy_parameters, output_payload} preimage alone',
  re1 === sc1.artifact.execution_hash, re1 + ' vs ' + sc1.artifact.execution_hash);
check('compute_proof_ready is ready (output JCS-identical to the site-pinned journal golden)',
  sc1.artifact.compute_proof_ready === 'ready', JSON.stringify(sc1.artifact.compute_proof_ready));
// NO HASHED PAYLOAD CONTAINS IT: no 'anchor' member anywhere inside the artifact, at any nesting.
check("no 'anchor' member anywhere inside the artifact (deep scan)", !hasKeyDeep(sc1.artifact, 'anchor'));

// ── 2. determinism: two identical computes, byte-identical artifacts with the field present ──────
const r2 = await callTool({ policy_parameters: pp }, NODE_TOOL);
const sc2 = r2?.structuredContent;
check('second identical compute succeeds with the hand-off present', !!sc2?.artifact?.execution_hash && !!sc2?.anchor);
check('preimage members byte-identical across calls (field present both times; generated_at is wall-clock and hash-excluded)',
  JSON.stringify(sc1.artifact.policy_parameters) === JSON.stringify(sc2.artifact.policy_parameters)
  && JSON.stringify(sc1.artifact.output_payload) === JSON.stringify(sc2.artifact.output_payload));
check('execution_hash identical across calls', sc1.artifact.execution_hash === sc2.artifact.execution_hash);
check('hand-off identical across calls', JSON.stringify(sc1.anchor) === JSON.stringify(sc2.anchor));

// ── 3. emit_chaingraph_artifact Mode 4: the same invariants on the second compute surface ────────
const r3 = await callTool({ tool_id: NODE_ID, policy_parameters: pp }, 'emit_chaingraph_artifact');
const sc3 = r3?.structuredContent;
check('emit_chaingraph_artifact Mode 4 computes server-side', sc3?.mode === 'server_compute' && !!sc3?.artifact?.execution_hash,
  JSON.stringify(r3 ?? {}).slice(0, 200));
check('Mode 4 result carries the anchor hand-off', !!sc3?.anchor, JSON.stringify(sc3 && Object.keys(sc3)));
check('Mode 4 hand-off shape + endpoint + tool correct',
  !!sc3?.anchor && JSON.stringify(Object.keys(sc3.anchor)) === JSON.stringify(['endpoint', 'tool', 'hash'])
  && sc3.anchor.endpoint === 'https://anchor.ainumbers.co/mcp' && sc3.anchor.tool === 'anchor_hash',
  JSON.stringify(sc3?.anchor));
check('Mode 4 hand-off hash IS the artifact execution_hash', sc3?.anchor?.hash === sc3?.artifact?.execution_hash);
const re3 = await ssotExecutionHash(sc3.artifact.policy_parameters, sc3.artifact.output_payload);
check('Mode 4 execution_hash recomputes byte-identically from the preimage alone',
  re3 === sc3.artifact.execution_hash, re3 + ' vs ' + sc3.artifact.execution_hash);
check("Mode 4: no 'anchor' member anywhere inside the artifact (deep scan)", !hasKeyDeep(sc3.artifact, 'anchor'));
check('Mode 4 and per-node computes agree on the execution_hash',
  sc1.artifact.execution_hash === sc3.artifact.execution_hash,
  sc1.artifact.execution_hash + ' vs ' + sc3.artifact.execution_hash);

// ── 4. ERROR / NON-COMPUTE RESULTS ARE CLEAN ─────────────────────────────────────────────────────
const rUnknown = await callTool({}, null);
check('unknown-tool error carries NO anchor',
  rUnknown?.isError === true && !hasKeyDeep(rUnknown?.structuredContent ?? {}, 'anchor'),
  JSON.stringify(rUnknown ?? {}).slice(0, 160));

const rBrowser = await callTool({ policy_parameters: pp, compute: 'browser' }, NODE_TOOL);
const scB = rBrowser?.structuredContent;
check('explicit compute:"browser" delegates to the browser (no server compute)',
  scB?.delegation_reason === 'browser_requested', JSON.stringify(scB && scB.delegation_reason));
check('browser-delegation result carries NO anchor', !hasKeyDeep(scB ?? {}, 'anchor'), JSON.stringify(scB && Object.keys(scB)));

const rNoPP = await callTool({}, NODE_TOOL);
const scN = rNoPP?.structuredContent;
check('missing policy_parameters delegates (no server compute)',
  scN?.delegation_reason === 'missing_policy_parameters', JSON.stringify(scN && scN.delegation_reason));
check('missing-policy_parameters result carries NO anchor', !hasKeyDeep(scN ?? {}, 'anchor'));

// pre_computed with a MISMATCHING hash: a failed verification is not a successful compute.
const rMismatch = await callTool({
  pre_computed_artifact: {
    chaingraph_version: '0.4.0', mandate_type: 'classification', tool_id: NODE_ID, tool_version: '1.0.0',
    generated_at: '2026-01-01T00:00:00.000Z', execution_hash: 'sha256:' + '0'.repeat(64), chain: { parent_hashes: [], parent_tool_ids: [] },
    policy_parameters: { probe: 1 }, output_payload: { probe: true },
  },
}, 'emit_chaingraph_artifact');
const scM = rMismatch?.structuredContent;
check('pre_computed verification flags the mismatch (hash_valid false)',
  scM?.mode === 'pre_computed' && scM?.hash_valid === false, JSON.stringify({ mode: scM?.mode, hash_valid: scM?.hash_valid }));
check('hash-mismatch verification result carries NO anchor', !hasKeyDeep(scM ?? {}, 'anchor'));

console.log(`\ntest-anchor-handoff: ${failed} failure(s)`);
process.exit(failed ? 1 : 0);
