#!/usr/bin/env node
// gate-hash-ijson.mjs — the execution_hash surface must refuse input it cannot canonicalize,
// and must agree byte-for-byte with the SSOT hasher on input it can.
//
// THE DEFECT THIS GATE EXISTS FOR (WORKER-HASH-SSOT-1, 2026-08-29 — live P0 on the public endpoint):
// worker.mjs carried a local `cgCanon`/`cgExecutionHash` copy that dropped the SSOT's assertIJson()
// guard. RFC 7493 (I-JSON) exists because an integer beyond 2^53 does not round-trip through JSON:
// the wire documents
//     {"policy_parameters":{"n":9007199254740992},"output_payload":{}}
//     {"policy_parameters":{"n":9007199254740993},"output_payload":{}}
// are DIFFERENT documents that both parse to the SAME IEEE-754 double, so both received the SAME
// execution_hash. Two distinct artifacts, one receipt, unauthenticated and deterministic, from the
// tool whose entire claim is "a match proves these inputs deterministically produce these outputs".
// A verifier handed the second document and shown the first's receipt cannot tell them apart.
//
// The SSOT (kernels/_hash.mjs) already refuses this: assertIJson() throws rather than emit a digest
// it cannot make stable. This gate proves the worker's tools inherit that refusal.
//
// CASES (each over a real MCP tools/call round-trip — McpServer <-> InMemoryTransport, full
// buildServer, exactly as the live worker registers them):
//   1. COLLISION  — verify_execution_hash on both documents above must NOT return equal hashes.
//                   It must return no hash at all: a structured -32602 with error.data.reason
//                   "ijson_violation". Before the fix this case fails by returning one digest twice.
//   2. STRUCTURED — the refusal is machine-readable: isError, JSON-RPC code -32602, and a stable
//                   `reason` an agent can branch on. A bare thrown string would not pass.
//   3. EMIT       — emit_chaingraph_artifact Mode 1 (pre_computed_artifact) refuses the same input
//                   the same way; the second hashing entry point must not stay open.
//   4. NON-FINITE — NaN / Infinity are refused too (the other half of assertIJson).
//   5. PARITY     — an ordinary in-range artifact still hashes, and its computed_hash equals
//                   executionHash() recomputed HERE from the SSOT module. SO #34: the expected
//                   value is derived from the primary source, never read back from the tool under
//                   test. This is what stops the gate from being satisfied by a worker that simply
//                   refuses everything.
//
// Run: node scripts/gate-hash-ijson.mjs

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer, widgetGlue, stripCspMeta } from '../worker.mjs';
import { PILOT } from '../pilot.mjs';
import { executionHash as ssotExecutionHash } from '../kernels/_hash.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = resolve(ROOT, 'data');
const get = (p) => readFileSync(resolve(DATA, p), 'utf8');

// The two wire documents. Kept as TEXT on purpose: the point is that they differ as documents and
// converge as values, which is precisely what a digest over the parsed value cannot express.
const DOC_A = '{"policy_parameters":{"n":9007199254740992},"output_payload":{"ok":true}}';
const DOC_B = '{"policy_parameters":{"n":9007199254740993},"output_payload":{"ok":true}}';

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

// A refusal is only useful if a program can act on it. Accept nothing less than: tool-level error
// flag + JSON-RPC InvalidParams (-32602) + the stable reason token.
function isStructuredIjsonRefusal(result) {
  if (!result || result.isError !== true) return { ok: false, why: 'not flagged isError' };
  const err = result.structuredContent?.error;
  if (!err) return { ok: false, why: 'no structuredContent.error object (prose-only error)' };
  if (err.code !== -32602) return { ok: false, why: `error.code=${err.code}, expected -32602 (InvalidParams)` };
  if (err.data?.reason !== 'ijson_violation') return { ok: false, why: `error.data.reason=${JSON.stringify(err.data?.reason)}, expected "ijson_violation"` };
  return { ok: true, why: `-32602 ijson_violation — ${String(err.data?.detail ?? '').slice(0, 96)}` };
}

// Any digest reachable from a result, whatever field carries it. Used to assert that a refusal
// leaked NO hash — "structured error AND a hash" would still let a caller quote the hash.
function anyHashIn(result) {
  const sc = result?.structuredContent;
  if (!sc) return null;
  for (const k of ['computed_hash', 'execution_hash', 'hash', 'claimed_hash']) {
    if (typeof sc[k] === 'string' && /^(sha256:)?[0-9a-f]{64}$/.test(sc[k])) return sc[k];
  }
  return null;
}

async function main() {
  const data = loadDataFromDisk();
  const server = buildServer(data);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  await clientT.start();

  const pending = new Map();
  clientT.onmessage = (msg) => {
    if (msg && msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  };
  let nextId = 1;
  const rpc = (method, params) => new Promise((res) => { const id = nextId++; pending.set(id, res); clientT.send({ jsonrpc: '2.0', id, method, params }); });
  const call = (name, args) => rpc('tools/call', { name, arguments: args });

  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'gate-hash-ijson', version: '1' } });
  await clientT.send({ jsonrpc: '2.0', method: 'notifications/initialized' });

  const rows = [];
  let fail = 0;
  const record = (ok, name, note) => { if (!ok) fail++; rows.push({ ok, name, note }); };

  // ── precondition: the two documents really are different documents ──────────────────────────
  record(DOC_A !== DOC_B, 'precondition: the two wire documents differ as text',
    DOC_A !== DOC_B ? 'differ at the last digit of n (…992 vs …993)' : 'IDENTICAL — fixture is broken');

  const a = JSON.parse(DOC_A);
  const b = JSON.parse(DOC_B);

  // ── case 1 + 2: verify_execution_hash must refuse, not collide ──────────────────────────────
  const rA = (await call('verify_execution_hash', { policy_parameters: a.policy_parameters, output_payload: a.output_payload })).result;
  const rB = (await call('verify_execution_hash', { policy_parameters: b.policy_parameters, output_payload: b.output_payload })).result;

  const hA = anyHashIn(rA), hB = anyHashIn(rB);
  if (hA && hB && hA === hB) {
    record(false, 'COLLISION: two distinct documents received one execution_hash',
      `both documents hashed to ${hA} — this is the WORKER-HASH-SSOT-1 defect, live`);
  } else if (hA || hB) {
    record(false, 'a non-I-JSON document received an execution_hash',
      `hash leaked: A=${hA ?? 'none'} B=${hB ?? 'none'} — a value that cannot round-trip must never be hashed`);
  } else {
    record(true, 'no execution_hash emitted for either non-I-JSON document', 'no digest reachable in either result');
  }

  for (const [label, r] of [['doc A (n=…992)', rA], ['doc B (n=…993)', rB]]) {
    const v = isStructuredIjsonRefusal(r);
    record(v.ok, `structured refusal for ${label}`, v.why);
  }

  // ── case 3: the second hashing entry point (emit_chaingraph_artifact Mode 1) ─────────────────
  const emitResp = (await call('emit_chaingraph_artifact', {
    pre_computed_artifact: {
      chaingraph_version: '0.4.0',
      mandate_type: 'compliance_mandate',
      tool_id: 'gate-hash-ijson-fixture',
      tool_version: '1.0.0',
      generated_at: '2026-08-29T00:00:00.000Z',
      execution_hash: '0'.repeat(64),
      chain: { parent_hashes: [], parent_tool_ids: [], chain_depth: 0 },
      policy_parameters: b.policy_parameters,
      output_payload: b.output_payload,
    },
  })).result;
  const emitVerdict = isStructuredIjsonRefusal(emitResp);
  record(emitVerdict.ok, 'emit_chaingraph_artifact Mode 1 refuses the same input', emitVerdict.why);
  record(anyHashIn(emitResp) === null, 'emit_chaingraph_artifact leaks no hash on refusal',
    anyHashIn(emitResp) ? `leaked ${anyHashIn(emitResp)}` : 'no digest in result');

  // ── case 4: the other half of assertIJson — non-finite numbers ───────────────────────────────
  for (const [label, bad] of [['Infinity', Infinity], ['NaN', NaN]]) {
    const r = (await call('verify_execution_hash', { policy_parameters: { n: bad }, output_payload: { ok: true } })).result;
    const v = isStructuredIjsonRefusal(r);
    record(v.ok, `structured refusal for non-finite ${label}`, v.why);
  }

  // ── case 5: PARITY — in-range input still hashes, and matches the SSOT independently ─────────
  // Without this, a worker that refused EVERYTHING would pass every case above.
  const goodPp = { rate: 0.0325, currency: 'USD', tenor_days: 90, counterparty: 'ACME plc' };
  const goodOp = { eligible: true, haircut_pct: 4.5, notes: ['within policy', 'no override'] };
  const goodResp = (await call('verify_execution_hash', { policy_parameters: goodPp, output_payload: goodOp })).result;
  const expected = await ssotExecutionHash(goodPp, goodOp);   // recomputed from the SSOT, not read back
  const got = goodResp?.structuredContent?.computed_hash ?? null;
  record(goodResp?.isError !== true, 'in-range artifact is still accepted', goodResp?.isError ? 'refused — the guard is over-broad' : 'accepted');
  record(got === expected, 'worker hash == SSOT executionHash() recomputed here',
    got === expected ? `both ${String(expected).slice(0, 16)}…` : `worker=${got} ssot=${expected}`);

  await clientT.close();
  await server.close();

  console.log('\n════ gate-hash-ijson results ════');
  for (const r of rows) console.log(`  ${r.ok ? '✓' : '✗'} ${r.name} — ${r.note}`);
  console.log('');

  if (fail) {
    console.error(`✗ gate-hash-ijson: ${fail} failure(s). The execution_hash surface does not enforce I-JSON, so two different artifacts can share one receipt.`);
    process.exit(1);
  }
  console.log(`✅ gate-hash-ijson: ${rows.length} checks green — non-I-JSON input is refused with a structured -32602 and no digest, and in-range input hashes identically to the SSOT.`);
}

main().catch((err) => { console.error('✗ gate-hash-ijson ERROR:', err); process.exit(1); });
