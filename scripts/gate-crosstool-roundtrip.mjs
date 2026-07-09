#!/usr/bin/env node
// gate-crosstool-roundtrip.mjs — audit AUD-C1: cross-tool artifact round-trip.
//
// Claim: an artifact emitted by ONE MCP tool (emit_chaingraph_artifact, Mode 4 server
// compute) independently verifies through a DIFFERENT MCP tool (verify_execution_hash) —
// the loop actually closes across tool boundaries, not just within one tool's own
// self-check. Both calls go through the real MCP transport (InMemoryTransport, same
// mechanism run-chain-corpus.mjs / test-escalate-emit.mjs use — no network, no live
// worker, but the REAL buildServer()/registerTool() wiring, not a reimplementation).
//
// For a representative corpus of gpu:false nodes (every tool_id with a registered kernel
// AND a vendored fixture in data/chain-fixtures.json — the same fixture set
// run-chain-corpus.mjs draws its per-step inputs from, flattened and de-duplicated by
// tool_id):
//   1. Call emit_chaingraph_artifact({ tool_id, policy_parameters: <fixture>, compute:
//      "server" }) -> a full v0.4 artifact with execution_hash + output_payload.
//   2. Call verify_execution_hash({ artifact }) AS A SEPARATE TOOL CALL on a fresh
//      connection -> MUST return valid:true.
//   3. Mutate ONE byte of the artifact's output_payload (flip a boolean, or append one
//      character to the first string leaf found) and call verify_execution_hash again on
//      the mutated artifact -> MUST return valid:false (this is the failing-on-defect
//      half — proves the verifier is not a rubber stamp).
//
// Usage: node scripts/gate-crosstool-roundtrip.mjs [tool_id]
// Exit code: 1 if any node in the corpus fails either half; 0 otherwise.

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer, widgetGlue, stripCspMeta } from '../worker.mjs';
import { PILOT } from '../pilot.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = resolve(ROOT, 'data');
const get = (p) => readFileSync(resolve(DATA, p), 'utf8');

function loadDataFromDisk() {
  const glue = widgetGlue(get('ext-apps-inline.js'));
  const manifests = {}, widgets = {};
  for (const slug of PILOT) {
    manifests[slug] = JSON.parse(get('manifests/' + slug + '.manifest.json'));
    widgets[slug] = stripCspMeta(get('tools/' + slug + '.html')) + glue;
  }
  return {
    manifests, widgets,
    catalog: JSON.parse(get('mcp/catalog.json')),
    chaingraph: JSON.parse(get('chaingraph/chaingraph.json')),
    searchIndex: JSON.parse(get('search-index.json')),
    chainFixtures: JSON.parse(get('chain-fixtures.json')),
  };
}

// One fresh MCP connection per call, exactly like run-chain-corpus.mjs / test-escalate-emit.mjs —
// this is what makes the two tool calls genuinely cross-boundary (separate registerTool wiring,
// separate JSON-RPC round trip) rather than two JS functions called back-to-back in one scope.
async function callTool(data, toolName, args) {
  const server = buildServer(data, { onlyTool: toolName });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  await clientT.start();
  const pending = new Map();
  clientT.onmessage = (msg) => { if (msg && msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); } };
  const rpc = (method, params, id) => new Promise((res) => { pending.set(id, res); clientT.send({ jsonrpc: '2.0', id, method, params }); });
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'gate-crosstool-roundtrip', version: '1' } }, 0);
  await clientT.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const resp = await rpc('tools/call', { name: toolName, arguments: args }, 1);
  await clientT.close(); await server.close();
  if (resp.error) throw new Error(`RPC error calling ${toolName}: ` + JSON.stringify(resp.error));
  if (resp.result?.isError) throw new Error(`Tool error calling ${toolName}: ` + resp.result?.content?.[0]?.text);
  const text = resp.result?.content?.[0]?.text;
  if (!text) throw new Error(`Empty response from ${toolName}`);
  return JSON.parse(text);
}

// Flip one byte's worth of signal in output_payload: prefer a boolean leaf (cleanest flip),
// else append a character to the first string leaf, else nudge the first finite number leaf.
function mutateOneByte(payload) {
  const clone = structuredClone(payload);
  function walk(node) {
    if (node === null || typeof node !== 'object') return null;
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (typeof v === 'boolean') { node[k] = !v; return true; }
    }
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (typeof v === 'string' && v.length) { node[k] = v + 'X'; return true; }
    }
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (typeof v === 'number' && Number.isFinite(v)) { node[k] = v + 1; return true; }
    }
    for (const k of Object.keys(node)) {
      if (node[k] && typeof node[k] === 'object') { if (walk(node[k])) return true; }
    }
    return false;
  }
  if (!walk(clone)) throw new Error('mutateOneByte: no mutable leaf found in output_payload');
  return clone;
}

async function main() {
  const data = loadDataFromDisk();
  const nodeById = {};
  for (const n of (data.chaingraph.nodes || [])) nodeById[n.tool_id] = n;

  // Flatten chain-fixtures.json (chain -> {tool_id: policy_parameters}) into a de-duplicated
  // per-tool_id fixture map — the SAME fixture corpus run-chain-corpus.mjs draws step inputs
  // from. Only gpu:false nodes are eligible for Mode 4 server compute.
  const fixtureByToolId = {};
  for (const stepMap of Object.values(data.chainFixtures || {})) {
    for (const [tid, pp] of Object.entries(stepMap)) {
      if (fixtureByToolId[tid] === undefined) fixtureByToolId[tid] = pp;
    }
  }
  const argFilter = process.argv[2] || null;
  const corpus = Object.keys(fixtureByToolId)
    .filter((tid) => nodeById[tid] && nodeById[tid].gpu === false)
    .filter((tid) => !argFilter || tid === argFilter)
    .sort();

  if (!corpus.length) { console.error('✗ no eligible gpu:false, fixture-backed nodes found.'); process.exit(1); }
  console.log(`\n▶ gate-crosstool-roundtrip: ${corpus.length} gpu:false fixture-backed node(s)\n`);

  const results = [];
  for (const tid of corpus) {
    const pp = fixtureByToolId[tid];
    const entry = { tool_id: tid, ok: true, reasons: [] };
    try {
      // --- Tool A: emit_chaingraph_artifact (Mode 4 server compute) ---
      const emitOut = await callTool(data, 'emit_chaingraph_artifact', { tool_id: tid, policy_parameters: pp, compute: 'server' });
      if (emitOut.mode !== 'server_compute' || !emitOut.artifact) {
        entry.ok = false; entry.reasons.push(`emit_chaingraph_artifact did not server-compute (mode=${emitOut.mode})`);
        results.push(entry); continue;
      }
      const artifact = emitOut.artifact;

      // --- Tool B: verify_execution_hash, on a SEPARATE connection, over the clean artifact ---
      const cleanVerify = await callTool(data, 'verify_execution_hash', { artifact });
      if (cleanVerify.valid !== true) {
        entry.ok = false; entry.reasons.push(`clean artifact: verify_execution_hash returned valid=${cleanVerify.valid} (expected true) — cross-tool round-trip DID NOT close`);
      }

      // --- Tool B again, over a one-byte-mutated artifact — MUST invalidate ---
      const mutatedPayload = mutateOneByte(artifact.output_payload);
      const mutatedArtifact = { ...artifact, output_payload: mutatedPayload };
      const mutatedVerify = await callTool(data, 'verify_execution_hash', { artifact: mutatedArtifact });
      if (mutatedVerify.valid !== false) {
        entry.ok = false; entry.reasons.push(`mutated artifact: verify_execution_hash returned valid=${mutatedVerify.valid} (expected false) — verifier did not catch the tamper`);
      }

      if (entry.ok) {
        entry.detail = `clean valid=${cleanVerify.valid} (hash ${cleanVerify.computed_hash?.slice(0, 12)}…), mutated valid=${mutatedVerify.valid}`;
      }
    } catch (err) {
      entry.ok = false; entry.reasons.push(`threw: ${err.message}`);
    }
    results.push(entry);
    console.log(`  ${entry.ok ? '✓' : '✗'} ${tid}${entry.detail ? '  — ' + entry.detail : ''}`);
    if (!entry.ok) for (const r of entry.reasons) console.log(`       - ${r}`);
  }

  const passed = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);
  console.log('\n════ gate-crosstool-roundtrip summary ════');
  console.log(`  nodes attempted : ${results.length}`);
  console.log(`  passed          : ${passed.length}`);
  console.log(`  failed          : ${failed.length}`);
  console.log('');
  if (failed.length) { console.error(`✗ gate-crosstool-roundtrip: ${failed.length} failure(s).`); process.exit(1); }
  console.log(`✅ gate-crosstool-roundtrip: all ${passed.length} nodes round-tripped clean=valid, mutated=invalid across the emit_chaingraph_artifact -> verify_execution_hash tool boundary.`);
}

main().catch((err) => { console.error('✗ gate-crosstool-roundtrip ERROR:', err); process.exit(1); });
