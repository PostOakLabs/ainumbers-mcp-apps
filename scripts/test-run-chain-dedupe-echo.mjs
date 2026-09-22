#!/usr/bin/env node
// test-run-chain-dedupe-echo.mjs — RUN-1-1 (IDEMPOTENCY-ECHO-1) stability selftest.
//
// run_chain's response carries a stable `dedupe` echo — { input_hash, composite_execution_hash } —
// so a client can recognize an exact re-run and skip it (idempotentHint; docs/IDEMPOTENCY.md).
// The ADVERTISED contract this selftest pins:
//   1. the echo is present on every server-mode run, and dedupe.composite_execution_hash IS
//      out.composite_execution_hash (one field, no drift);
//   2. identical effective inputs repeat BOTH members byte-for-byte across calls — wall-clock
//      fields (generated_at, opened_at) differ, the hashes do not (retry determinism);
//   3. key ORDER in the inputs never moves input_hash (same JCS canonicalizer as the execution
//      hash — kernels/_hash.mjs, the cacheHint.cacheKey:'input_hash' contract);
//   4. "omitted" and "explicitly fixture-equal" hash identically (the echo resolves each step's
//      policy_parameters with the same caller -> fixture -> {} `??` chain the kernel dispatch uses);
//   5. a genuinely changed input moves input_hash (the echo is a real key, not a constant);
//   6. a run where NO step ran (composite_execution_hash null) still echoes a valid input_hash —
//      an input echo exists even when there is no output to anchor;
//   7. escalation_transport is NOT in the preimage: the same run answered through the default
//      resolve-handle transport and the opt-in input_required transport echoes identical hashes
//      (transport changes the envelope, never the artifacts);
//   8. the echo is response-only: no `dedupe` / `input_hash` member appears inside the hashed
//      composite_artifact (policy_parameters / output_payload), so no preimage byte moved;
//   9. compute:"browser" is a zero-egress delegation — nothing ran server-side, so no dedupe
//      echo is offered (and the doc says so).
//
// Run: node scripts/test-run-chain-dedupe-echo.mjs   (exit 0 = green)
// Wired into scripts/preflight.mjs (RUN-1-1): green here is enforced on every push.

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

async function runChain(data, args) {
  const server = buildServer(data, { onlyTool: 'run_chain' });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  await clientT.start();
  const pending = new Map();
  clientT.onmessage = (msg) => { if (msg && msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); } };
  const rpc = (method, params, id) => new Promise((res) => { pending.set(id, res); clientT.send({ jsonrpc: '2.0', id, method, params }); });
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } }, 0);
  await clientT.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const resp = await rpc('tools/call', { name: 'run_chain', arguments: args }, 1);
  await clientT.close(); await server.close();
  if (resp.error) throw new Error('RPC error: ' + JSON.stringify(resp.error));
  return JSON.parse(resp.result.content[0].text);
}

const HEX64 = /^[0-9a-f]{64}$/;
const base = loadDataFromDisk();
const baseChain = base.chaingraph.chains.find((c) => c.name === 'agent-commerce-conformance');
const T = baseChain.steps.map((s) => s.tool_id);
const FX = base.chainFixtures['agent-commerce-conformance'];

// Synthetic chains — real kernel-backed nodes, injected like gate-parity.test.mjs (scope-fenced
// to this test, never written to chaingraph.json):
//   dedupe-echo-null      — one kernel-backed step, NO fixtures -> input_required, zero steps ran.
//   dedupe-echo-escalate  — one kernel-backed step whose gate routes straight to "escalate"
//                           (OCG §22.8.1 isEscalationTarget), so escalation_transport is on the path.
function inject(extra) {
  const cg = JSON.parse(JSON.stringify(base.chaingraph));
  cg.chains.push({ name: 'dedupe-echo-null', title: 'dedupe echo: zero-ran run', steps: [{ tool_id: T[0] }] });
  cg.chains.push({
    name: 'dedupe-echo-escalate', title: 'dedupe echo: escalating run',
    steps: [{ tool_id: T[0], id: 's0', gate: { input: '', rules: [{ op: 'present', next: 'escalate' }], default: 'end' } }],
  });
  const fixtures = JSON.parse(JSON.stringify(base.chainFixtures));
  fixtures['dedupe-echo-escalate'] = { [T[0]]: FX[T[0]] };
  return { ...base, chaingraph: cg, chainFixtures: fixtures, ...(extra ?? {}) };
}
const data = inject();

let fails = 0;
const ok = (label) => console.log('  ✓ ' + label);
const bad = (label, detail) => { fails++; console.error('  ✗ ' + label + (detail ? ' — ' + detail : '')); };

// 1 + 2 — presence, sync with composite, byte-stability across repeat calls.
const runA = await runChain(data, { chain: 'agent-commerce-conformance' });
if (!runA.dedupe || !HEX64.test(runA.dedupe.input_hash ?? '')) bad('echo present + 64-hex input_hash', JSON.stringify(runA.dedupe));
else if (runA.dedupe.composite_execution_hash !== runA.composite_execution_hash) bad('dedupe.composite_execution_hash === out.composite_execution_hash');
else ok('server-mode run echoes { input_hash, composite_execution_hash }, composite member in sync');

const runB = await runChain(data, { chain: 'agent-commerce-conformance' });
if (runB.dedupe.input_hash !== runA.dedupe.input_hash || runB.composite_execution_hash !== runA.composite_execution_hash) {
  bad('identical retry -> identical echo', `${runA.dedupe.input_hash.slice(0, 12)}… vs ${runB.dedupe.input_hash.slice(0, 12)}…`);
} else ok('identical retry repeats both echo members byte-for-byte (generated_at differs, hashes do not)');

// 3 — key order never moves the hash (JCS canonicalization, same SSOT as the execution hash).
const fx0 = FX[T[0]];
const reordered = Object.fromEntries(Object.entries(fx0).reverse());
const shuffled = await runChain(data, { chain: 'agent-commerce-conformance', inputs: { [T[0]]: reordered } });
if (shuffled.dedupe.input_hash !== runA.dedupe.input_hash) bad('key order moved input_hash');
else if (shuffled.composite_execution_hash !== runA.composite_execution_hash) bad('key order moved composite hash');
else ok('key order in inputs is hash-irrelevant (input_hash and composite both unchanged)');

// 4 — omitted vs explicitly fixture-equal: same effective inputs, same echo.
const fullFixtureInputs = Object.fromEntries(baseChain.steps.map((s) => [s.tool_id, FX[s.tool_id]]));
const explicit = await runChain(data, { chain: 'agent-commerce-conformance', inputs: fullFixtureInputs });
if (explicit.dedupe.input_hash !== runA.dedupe.input_hash || explicit.composite_execution_hash !== runA.composite_execution_hash) {
  bad('omitted vs fixture-equal explicit inputs diverge', 'the echo must resolve pp with the caller -> fixture -> {} chain');
} else ok('omitted inputs and explicit fixture-equal inputs echo identical hashes');

// 5 — a genuinely different input moves the echo.
const mutated = JSON.parse(JSON.stringify(fx0));
const mKey = Object.keys(mutated).find((k) => typeof mutated[k] === 'string');
if (mKey === undefined) { console.log('  ⏭ changed-input case skipped (no string field in fixture pp)'); }
else {
  mutated[mKey] = mutated[mKey] + ' ';
  const changed = await runChain(data, { chain: 'agent-commerce-conformance', inputs: { [T[0]]: mutated } });
  if (changed.dedupe.input_hash === runA.dedupe.input_hash) bad('changed input did NOT move input_hash');
  else if (changed.composite_execution_hash === runA.composite_execution_hash) bad('changed input moved input_hash but NOT the composite (preimage mismatch)');
  else ok('changed input moves both echo members (a real key, not a constant)');
}

// 6 — zero-ran run: composite null, input_hash still valid.
const zeroRan = await runChain(data, { chain: 'dedupe-echo-null' });
const allRequired = zeroRan.steps.every((s) => s.status === 'input_required');
if (!allRequired || zeroRan.steps_ran !== 0) bad('dedupe-echo-null did not end zero-ran', JSON.stringify(zeroRan.steps.map((s) => s.status)));
else if (zeroRan.composite_execution_hash !== null) bad('zero-ran composite should be null');
else if (!HEX64.test(zeroRan.dedupe?.input_hash ?? '')) bad('zero-ran run still echoes a valid input_hash', JSON.stringify(zeroRan.dedupe));
else if (zeroRan.dedupe.composite_execution_hash !== null) bad('zero-ran dedupe.composite_execution_hash should be null');
else ok('zero-ran run (all steps input_required): composite null, input_hash still echoed');

// 7 — escalation_transport is transport, not compute: excluded from the preimage.
const escDefault = await runChain(data, { chain: 'dedupe-echo-escalate' });
const escHandle = await runChain(data, { chain: 'dedupe-echo-escalate', escalation_transport: 'resolve_handle' });
const escInline = await runChain(data, { chain: 'dedupe-echo-escalate', escalation_transport: 'input_required' });
if (escDefault.status !== 'escalated' || !escDefault.escalation_record) bad('dedupe-echo-escalate did not escalate', escDefault.status);
else if (new Set([escDefault.dedupe.input_hash, escHandle.dedupe.input_hash, escInline.dedupe.input_hash]).size !== 1
  || new Set([escDefault.composite_execution_hash, escHandle.composite_execution_hash, escInline.composite_execution_hash]).size !== 1) {
  bad('escalation_transport moved the echo', 'transport must be preimage-excluded (docs/IDEMPOTENCY.md)');
} else ok('escalation_transport variants echo identical hashes (transport excluded from the preimage)');

// 8 — the echo is response-only: no echo member inside the hashed artifact.
const art = runA.composite_artifact;
const artStr = JSON.stringify(art);
if (art.policy_parameters.dedupe !== undefined || art.output_payload.dedupe !== undefined || /"input_hash"/.test(artStr) || /"dedupe"/.test(artStr)) {
  bad('echo leaked into the hashed artifact', 'dedupe/input_hash must stay on the response object only');
} else ok('echo is response-only: no dedupe/input_hash member inside composite_artifact');

// 9 — browser delegation runs nothing server-side: no echo offered.
const browser = await runChain(data, { chain: 'agent-commerce-conformance', compute: 'browser' });
if (browser.mode !== 'browser_delegation') bad('browser mode returned ' + browser.mode);
else if (browser.dedupe !== undefined) bad('browser delegation must not offer a server dedupe echo');
else ok('compute:"browser" offers no dedupe echo (nothing ran server-side to dedupe)');

if (fails) { console.error(`\n✗ test-run-chain-dedupe-echo FAILED (${fails})`); process.exit(1); }
console.log('✅ run_chain dedupe echo is stable, preimage-excluded, and transport-independent (docs/IDEMPOTENCY.md)');
