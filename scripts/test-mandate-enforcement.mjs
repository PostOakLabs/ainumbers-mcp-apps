#!/usr/bin/env node
// test-mandate-enforcement.mjs — SPEC §22.5 runtime binding, the enforcement half.
//
// §22.5 requires run_chain to make THREE checks before any step runs when a `mandate`
// argument is supplied:
//   1. the §16 signature verifies AND it is the principal's  → mandate_unsigned / mandate_bad_signature
//   2. the execution instant is inside output_payload.validity → mandate_not_yet_valid / mandate_expired
//   3. the chain and its step tool_ids are inside output_payload.scope → mandate_out_of_scope
//
// Before MANDATE-RUNTIME-ENFORCE-1 the runtime read a non-SPEC top-level `mandate.validity_window`
// (so a spec-shaped mandate skipped both time checks), never compared the proof's
// verificationMethod with `output_payload.principal.id`, and had no scope check at all — an expired,
// out-of-scope mandate signed by a stranger ran all four steps and folded its mandate_hash into the
// receipt. Each case below fails against that runtime and passes against this one.
//
// The positive case proves enforcement did not become refusal: a valid, in-window, in-scope mandate
// still runs and still binds mandate_hash into composite_policy. The final case is the
// linear-hash-freeze invariant — a run with NO mandate must reproduce the committed golden
// composite_execution_hash byte-for-byte.
//
// Keys are ephemeral did:key pairs generated per run and signed with the vendored _proof.mjs (the
// same module worker.mjs verifies with). No fixture carries a private key.
//
// Run: node scripts/test-mandate-enforcement.mjs

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer, widgetGlue, stripCspMeta } from '../worker.mjs';
import { PILOT } from '../pilot.mjs';
import { sign, rawPubkeyToDidKey } from '../embed/lib/_proof.mjs';
import { executionHash } from '../embed/lib/_hash.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = resolve(ROOT, 'data');

const CHAIN = 'agent-commerce-conformance';
const GOLDENS = JSON.parse(readFileSync(resolve(ROOT, 'test', 'linear-hash-freeze.goldens.json'), 'utf8'));

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
};

// ── data + transport (mirrors test-run-chain-fixtures.mjs / precompute-discovery loadDataFromDisk) ──
function loadDataFromDisk() {
  const get = (p) => readFileSync(resolve(DATA, p), 'utf8');
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

async function callRunChain(data, args) {
  const server = buildServer(data, { onlyTool: 'run_chain' });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  await clientT.start();

  const pending = new Map();
  clientT.onmessage = (msg) => {
    if (msg && msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  };
  const rpc = (method, params, id) => new Promise((res) => {
    pending.set(id, res);
    clientT.send({ jsonrpc: '2.0', id, method, params });
  });

  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'mandate-enforcement-test', version: '1' } }, 0);
  await clientT.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const resp = await rpc('tools/call', { name: 'run_chain', arguments: args }, 1);
  await clientT.close();
  await server.close();

  if (resp.error) throw new Error('RPC error: ' + JSON.stringify(resp.error));
  const text = resp.result?.content?.[0]?.text;
  if (!text) throw new Error('Empty response');
  return { isError: resp.result?.isError === true, body: JSON.parse(text) };
}

// ── ephemeral signer ──────────────────────────────────────────────────────────────────────────
async function newSigner() {
  const kp = await globalThis.crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  return { did: await rawPubkeyToDidKey(kp.publicKey), privateKey: kp.privateKey };
}

// Build a §22.1 work mandate document and sign it with `signer` (which may deliberately differ
// from `principalDid` — that is the principal-mismatch case).
async function makeMandate({ principalDid, signer, validity, scope }) {
  const policy_parameters = { mandate_kind: 'work_mandate', issued_for: 'test-mandate-enforcement' };
  const output_payload = {
    mandate_type: 'work_mandate',
    scope,
    conditions: [],
    escalation_triggers: [],
    validity,
    principal: { id: principalDid },
  };
  const artifact = {
    chaingraph_version: '0.4.0',
    mandate_type: 'work_mandate',
    tool_id: 'test/work-mandate',
    tool_version: '1.0.0',
    policy_parameters,
    output_payload,
    execution_hash: await executionHash(policy_parameters, output_payload),
  };
  return sign(artifact, {
    verificationMethod: signer.did,
    created: '2026-09-26T00:00:00Z',   // caller-supplied, deterministic
    privateKey: signer.privateKey,
  });
}

const iso = (msFromNow) => new Date(Date.now() + msFromNow).toISOString();
const DAY = 86400000;

async function main() {
  console.log('\n▶ SPEC §22.5 runtime mandate enforcement — run_chain("' + CHAIN + '")\n');
  const data = loadDataFromDisk();

  // Step tool_ids come from the baseline run itself rather than a hand-copied list, so the scope
  // allow-lists below can never drift from the chain the runtime actually executes.
  // ── baseline: no mandate at all → must reproduce the committed golden hash ──────────────────
  const plain = await callRunChain(data, { chain: CHAIN });
  const golden = GOLDENS[CHAIN]?.composite_execution_hash ?? null;
  check('no-mandate run still reproduces the committed golden composite_execution_hash (linear-hash-freeze)',
    !plain.isError && plain.body.composite_execution_hash === golden,
    'golden ' + golden + ' / current ' + plain.body.composite_execution_hash);
  const stepToolIds = (plain.body.steps ?? []).map((s) => s.tool_id);
  check('baseline run executed every step', plain.body.steps_ran === plain.body.step_count,
    plain.body.steps_ran + '/' + plain.body.step_count);
  check('no-mandate composite artifact carries NO mandate_hash (conditional presence)',
    !('mandate_hash' in (plain.body.composite_artifact?.policy_parameters ?? {})));

  const principal = await newSigner();
  const stranger = await newSigner();
  const wideValidity = { not_before: iso(-DAY), not_after: iso(DAY) };
  const fullScope = { tool_ids: stepToolIds, chains: [CHAIN] };

  // ── positive control: valid, in-window, in-scope → runs and binds mandate_hash ───────────────
  const good = await makeMandate({ principalDid: principal.did, signer: principal, validity: wideValidity, scope: fullScope });
  const okRun = await callRunChain(data, { chain: CHAIN, mandate: good });
  check('valid in-scope in-window mandate RUNS the chain', !okRun.isError && okRun.body.steps_ran === okRun.body.step_count,
    okRun.isError ? JSON.stringify(okRun.body) : okRun.body.steps_ran + '/' + okRun.body.step_count);
  check('accepted run folds mandate_hash into composite_policy (§22.5 receipt binding)',
    okRun.body.composite_artifact?.policy_parameters?.mandate_hash === good.execution_hash,
    String(okRun.body.composite_artifact?.policy_parameters?.mandate_hash).slice(0, 16) + '…');
  check('mandated run\'s composite hash DIFFERS from the no-mandate run (the mandate is in the preimage)',
    okRun.body.composite_execution_hash !== plain.body.composite_execution_hash);

  // ── case 1: expired (output_payload.validity.not_after in the past) ─────────────────────────
  const expired = await makeMandate({
    principalDid: principal.did, signer: principal,
    validity: { not_before: iso(-2 * DAY), not_after: iso(-DAY) }, scope: fullScope,
  });
  const rExpired = await callRunChain(data, { chain: CHAIN, mandate: expired });
  check('expired mandate → mandate_expired, no steps',
    rExpired.isError && rExpired.body.error === 'mandate_expired' && rExpired.body.steps_ran === undefined,
    rExpired.body.error);

  // ── case 2: not yet valid ────────────────────────────────────────────────────────────────────
  const future = await makeMandate({
    principalDid: principal.did, signer: principal,
    validity: { not_before: iso(DAY), not_after: iso(2 * DAY) }, scope: fullScope,
  });
  const rFuture = await callRunChain(data, { chain: CHAIN, mandate: future });
  check('not-yet-valid mandate → mandate_not_yet_valid, no steps',
    rFuture.isError && rFuture.body.error === 'mandate_not_yet_valid' && rFuture.body.steps_ran === undefined,
    rFuture.body.error);

  // ── case 3a: chain outside scope.chains ─────────────────────────────────────────────────────
  const otherChain = await makeMandate({
    principalDid: principal.did, signer: principal, validity: wideValidity,
    scope: { tool_ids: [], chains: ['some-other-chain'] },
  });
  const rChain = await callRunChain(data, { chain: CHAIN, mandate: otherChain });
  check('chain outside scope.chains → mandate_out_of_scope, no steps',
    rChain.isError && rChain.body.error === 'mandate_out_of_scope' && rChain.body.steps_ran === undefined,
    rChain.body.error);

  // ── case 3b: a step tool_id outside scope.tool_ids ──────────────────────────────────────────
  const partialTools = await makeMandate({
    principalDid: principal.did, signer: principal, validity: wideValidity,
    scope: { tool_ids: stepToolIds.slice(0, -1), chains: [CHAIN] },
  });
  const rTool = await callRunChain(data, { chain: CHAIN, mandate: partialTools });
  check('step tool_id outside scope.tool_ids → mandate_out_of_scope, no steps',
    rTool.isError && rTool.body.error === 'mandate_out_of_scope' && rTool.body.steps_ran === undefined,
    rTool.body.error + ' (' + (rTool.body.unauthorized_tool_ids ?? []).join(',') + ')');

  // ── case 4: principal A, signer B — a cryptographically VALID signature by the wrong DID ─────
  const wrongSigner = await makeMandate({
    principalDid: principal.did, signer: stranger, validity: wideValidity, scope: fullScope,
  });
  const rSigner = await callRunChain(data, { chain: CHAIN, mandate: wrongSigner });
  check('valid signature by a DID other than principal.id → mandate_bad_signature, no steps',
    rSigner.isError && rSigner.body.error === 'mandate_bad_signature' && rSigner.body.steps_ran === undefined,
    rSigner.body.error);

  // ── error-envelope shape: every rejection keeps the existing { error, detail } contract ──────
  const rejections = [rExpired, rFuture, rChain, rTool, rSigner];
  check('every rejection keeps the { error, detail } envelope',
    rejections.every((r) => typeof r.body.error === 'string' && typeof r.body.detail === 'string'));

  // ── the freeze re-checked AFTER the mandated runs (no cross-run state) ───────────────────────
  const plainAgain = await callRunChain(data, { chain: CHAIN });
  check('no-mandate hash is still the golden after mandated runs',
    plainAgain.body.composite_execution_hash === golden, plainAgain.body.composite_execution_hash);

  console.log(failures === 0
    ? '\n✅ §22.5 enforcement: all assertions passed\n'
    : `\n✗ §22.5 enforcement: ${failures} assertion(s) failed\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('✗ ' + (e?.stack ?? e)); process.exit(1); });
