#!/usr/bin/env node
// test-run-chain-batch.mjs — RUN-2-1 gate for run_chain_batch (IMPL-PLAN-P0P1 §4 C2).
//
// Drives the REAL registered tool over an InMemoryTransport (no network, same pattern as
// run-chain-corpus.mjs / test-run-chain-fixtures.mjs) and asserts the row's done-items:
//   1. estimate mode executes NOTHING: per-row "ready" + step counts + static gate previews,
//      with zero execution-hash / decision keys anywhere in the response (COSTPREFLIGHT-1).
//   2. run mode: all-rows results in ONE response; PER-ROW terminal status; one bad row
//      (unknown_chain / input_required) never fails another row.
//   3. Same-engine parity: a batch row's composite_execution_hash is IDENTICAL to a direct
//      run_chain call for the same chain (the batch shares executeChainRun verbatim).
//   4. Whole-batch retry: re-running the same batch reproduces every composite_execution_hash
//      (determinism is what makes whole-batch retry safe).
//   5. Caps: > max rows is refused by the schema; a batch whose total server-kernel steps
//      exceeds the LIVE-MEASURED budget (11) is refused BEFORE any execution.
//   6. Batch rows carry no per-row OTel base64 span document (trimmed; hashed bytes unchanged).
//
// Exit 0 only if every check passes.

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer, widgetGlue, stripCspMeta } from '../worker.mjs';
import { PILOT } from '../pilot.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = resolve(ROOT, 'data');

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

async function withTool(data, toolName, fn) {
  const server = buildServer(data, { onlyTool: toolName });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  await clientT.start();
  const pending = new Map();
  let nextId = 0;
  clientT.onmessage = (msg) => {
    if (msg && msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  };
  const rpc = (method, params) => new Promise((res) => {
    const id = ++nextId;
    pending.set(id, res);
    clientT.send({ jsonrpc: '2.0', id, method, params });
  });
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'run-chain-batch-test', version: '1' } }, );
  await clientT.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  try {
    return await fn(rpc);
  } finally {
    await clientT.close();
    await server.close();
  }
}

const call = (rpc, name, args) => rpc('tools/call', { name, arguments: args });

let failed = 0, passed = 0;
function check(label, ok, detail) {
  if (ok) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.error('  ✗ ' + label + (detail ? ' — ' + detail : '')); }
}

// Key-scan: any execution OUTPUT in the document? (decision/evaluated-gate keys, hash keys)
function hasExecutionKeys(o) {
  if (Array.isArray(o)) return o.some(hasExecutionKeys);
  if (o && typeof o === 'object') {
    return Object.entries(o).some(([k, v]) =>
      k === 'execution_hash' || k === 'composite_execution_hash' ||
      k === 'matched_rule_index' || k === 'observed_value' || k === 'composite_artifact' ||
      hasExecutionKeys(v));
  }
  return false;
}

async function main() {
  const data = loadDataFromDisk();
  const cg = new Map((data.chaingraph.chains ?? []).map((c) => [c.name, c]));
  const fixtures = data.chainFixtures;

  // Deterministic probe chains: fixture-backed, small, and one GATED.
  const CHAIN_1STEP = '2052a-classify-daily';                 // 1 step, fixture-backed
  const CHAIN_GATED = 'adverse-action-notice-compliance';     // 2 steps, gated, fixture-backed
  const CHAIN_4STEP = 'agent-commerce-conformance';           // 4 steps, fixture-backed
  for (const c of [CHAIN_1STEP, CHAIN_GATED, CHAIN_4STEP]) {
    if (!cg.has(c) || !fixtures[c]) { console.error('FATAL: expected fixture-backed chain missing: ' + c); process.exit(1); }
  }

  // ── 1. estimate mode: pure validation, zero execution ────────────────────────
  console.log('▸ estimate mode (COSTPREFLIGHT-1)');
  {
    const resp = await withTool(data, 'run_chain_batch', (rpc) => call(rpc, 'run_chain_batch', {
      mode: 'estimate',
      rows: [{ chain: CHAIN_4STEP }, { chain: CHAIN_GATED }, { chain: 'nope-not-a-chain' }],
    }));
    check('estimate: no rpc error', !resp.error, JSON.stringify(resp.error ?? '').slice(0, 120));
    check('estimate: not isError', !resp.result?.isError, String(resp.result?.content?.[0]?.text).slice(0, 120));
    const sc = resp.result?.structuredContent;
    check('estimate: batch_mode "estimate"', sc?.batch_mode === 'estimate');
    const ready4 = sc?.results?.find((r) => r.chain === CHAIN_4STEP);
    const readyG = sc?.results?.find((r) => r.chain === CHAIN_GATED);
    const unk = sc?.results?.find((r) => r.chain === 'nope-not-a-chain');
    check('estimate: 4-step row ready with step_count 4', ready4?.status === 'ready' && ready4?.step_count === 4);
    check('estimate: gated row ready with a static gate_preview', readyG?.status === 'ready' && !!readyG?.steps?.some((s) => s.gate_preview));
    check('estimate: gate_preview is the static rule shape (op/next/default_next, no evaluation)',
      readyG?.steps?.some((s) => s.gate_preview && 'op' in (s.gate_preview.rules?.[0] ?? {}) && 'default_next' in s.gate_preview && !('matched_rule_index' in s.gate_preview)));
    check('estimate: unknown chain is terminal for ITS row only', unk?.status === 'unknown_chain');
    check('estimate: summary counts ready=2 unknown_chain=1', sc?.summary?.ready === 2 && sc?.summary?.unknown_chain === 1);
    check('estimate: ZERO execution anywhere in the response', !hasExecutionKeys(sc), 'execution/decision keys found');
    check('estimate: echoes the measured step budget', typeof sc?.cap?.max_total_server_kernel_steps === 'number' && typeof sc?.within_step_budget === 'boolean');
  }

  // ── 2+3. run mode: one response, per-row terminal status, same-engine parity ──
  console.log('▸ run mode: per-row terminal status + parity with run_chain');
  let batchHashes;
  {
    const resp = await withTool(data, 'run_chain_batch', (rpc) => call(rpc, 'run_chain_batch', {
      rows: [{ chain: CHAIN_1STEP }, { chain: CHAIN_GATED }, { chain: CHAIN_4STEP }, { chain: 'nope-not-a-chain' }],
    }));
    check('run: no rpc error', !resp.error, JSON.stringify(resp.error ?? '').slice(0, 120));
    const sc = resp.result?.structuredContent;
    check('run: batch_mode "run"', sc?.batch_mode === 'run');
    check('run: ALL rows answered in the ONE response', sc?.results?.length === 4, String(sc?.results?.length));
    const byChain = new Map((sc?.results ?? []).map((r) => [r.chain, r]));
    check('run: good rows terminal_status "completed"',
      byChain.get(CHAIN_1STEP)?.terminal_status === 'completed' &&
      byChain.get(CHAIN_4STEP)?.terminal_status === 'completed');
    check('run: gated row terminal_status "completed" (gate routing is normal completion)',
      byChain.get(CHAIN_GATED)?.terminal_status === 'completed');
    check('run: unknown row terminal_status "unknown_chain" — batch NOT failed', byChain.get('nope-not-a-chain')?.terminal_status === 'unknown_chain');
    check('run: summary tallies 3 completed + 1 unknown_chain', sc?.summary?.completed === 3 && sc?.summary?.unknown_chain === 1);
    check('run: every good row carries a 64-hex composite hash',
      [CHAIN_1STEP, CHAIN_GATED, CHAIN_4STEP].every((c) => /^[0-9a-f]{64}$/.test(byChain.get(c)?.composite_execution_hash ?? '')));
    check('run: batch rows carry NO per-row OTel base64 document (trimmed)',
      [CHAIN_1STEP, CHAIN_GATED, CHAIN_4STEP].every((c) => byChain.get(c)?.result?.otel_span_link === undefined));
    batchHashes = new Map([CHAIN_1STEP, CHAIN_GATED, CHAIN_4STEP].map((c) => [c, byChain.get(c)?.composite_execution_hash]));

    // Same-engine parity: the direct run_chain call must reproduce each row's hash.
    const direct = await withTool(data, 'run_chain', (rpc) => call(rpc, 'run_chain', { chain: CHAIN_4STEP }));
    const dsc = direct.result?.structuredContent;
    check('run: direct run_chain carries its own OTel link (trim is batch-only)', !!dsc?.otel_span_link);
    check('parity: batch row hash === direct run_chain hash (same engine)',
      dsc?.composite_execution_hash === batchHashes.get(CHAIN_4STEP),
      String(dsc?.composite_execution_hash) + ' vs ' + batchHashes.get(CHAIN_4STEP));
  }

  // ── 4. whole-batch retry = determinism ───────────────────────────────────────
  console.log('▸ whole-batch retry determinism');
  {
    const args = { rows: [{ chain: CHAIN_GATED }, { chain: CHAIN_4STEP }] };
    const r1 = await withTool(data, 'run_chain_batch', (rpc) => call(rpc, 'run_chain_batch', args));
    const r2 = await withTool(data, 'run_chain_batch', (rpc) => call(rpc, 'run_chain_batch', args));
    const h1 = new Map((r1.result?.structuredContent?.results ?? []).map((x) => [x.chain, x.composite_execution_hash]));
    const h2 = new Map((r2.result?.structuredContent?.results ?? []).map((x) => [x.chain, x.composite_execution_hash]));
    check('retry: re-running the whole batch reproduces every composite_execution_hash',
      h1.size === h2.size && [...h1].every(([c, h]) => h2.get(c) === h), JSON.stringify([h1, h2]));
  }

  // ── input_required row stays terminal, others complete ───────────────────────
  console.log('▸ per-row input_required isolation');
  {
    // Deterministic pick: first named chain (sorted) with 1-3 server-kernel steps and NO
    // fixture coverage and no caller inputs -> its kernels report input_required.
    const kernelStepCount = (c) => (c.steps ?? []).filter((s) => {
      const n = data.chaingraph.nodes?.find((x) => x.tool_id === s.tool_id);
      return n && n.gpu !== true;
    }).length;
    const candidates = [...cg.values()]
      .filter((c) => !fixtures[c.name] && (c.steps ?? []).length >= 1 && (c.steps ?? []).length <= 3)
      .sort((a, b) => a.name.localeCompare(b.name));
    const victim = candidates.find((c) => kernelStepCount(c) >= 1);
    if (!victim) {
      check('input_required: found a non-fixture 1-3-step chain to probe', false, 'no candidate — inspect data');
    } else {
      const resp = await withTool(data, 'run_chain_batch', (rpc) => call(rpc, 'run_chain_batch', {
        rows: [{ chain: victim.name }, { chain: CHAIN_1STEP }],
      }));
      const sc = resp.result?.structuredContent;
      const row = sc?.results?.find((x) => x.chain === victim.name);
      check('input_required: missing-input row terminal_status "input_required" (never silent)', row?.terminal_status === 'input_required', row?.terminal_status + ' / ' + JSON.stringify(row?.result?.steps ?? row?.result?.error ?? '').slice(0, 160));
      check('input_required: sibling row still completed', sc?.results?.find((x) => x.chain === CHAIN_1STEP)?.terminal_status === 'completed');
    }
  }

  // ── 5. caps ──────────────────────────────────────────────────────────────────
  console.log('▸ caps (schema row cap + live-measured step budget)');
  {
    const nine = Array.from({ length: 9 }, () => ({ chain: CHAIN_1STEP }));
    const resp = await withTool(data, 'run_chain_batch', (rpc) => call(rpc, 'run_chain_batch', { rows: nine }));
    const refused = !!resp.error || !!resp.result?.isError;
    check('run: 9 rows refused by the schema cap (8)', refused, JSON.stringify(resp.error ?? resp.result?.content?.[0]?.text ?? '').slice(0, 140));
  }
  {
    // 11-step chain + 1-step chain = 12 server-kernel steps > measured budget 11.
    const resp = await withTool(data, 'run_chain_batch', (rpc) => call(rpc, 'run_chain_batch', {
      rows: [{ chain: 'government-payment-lifecycle' }, { chain: CHAIN_1STEP }],
    }));
    const sc = resp.result?.structuredContent;
    check('run: over-budget batch refused BEFORE execution', resp.result?.isError === true && sc?.error === 'batch_step_budget_exceeded',
      JSON.stringify(sc ?? resp.result?.content?.[0]?.text ?? '').slice(0, 140));
    check('run: refusal names the measured budget', sc?.max_total_server_kernel_steps === 11 && sc?.total_server_kernel_steps === 12);
  }
  {
    // At-budget batch (11 steps) still executes: the measured cap is green by construction.
    const resp = await withTool(data, 'run_chain_batch', (rpc) => call(rpc, 'run_chain_batch', {
      rows: [{ chain: 'government-payment-lifecycle' }],
    }));
    const sc = resp.result?.structuredContent;
    check('run: 11 server-kernel steps (the measured live ceiling) completes',
      sc?.summary?.completed === 1 && /^[0-9a-f]{64}$/.test(sc?.results?.[0]?.composite_execution_hash ?? ''),
      JSON.stringify(sc?.summary ?? {}).slice(0, 120));
  }

  console.log(`\n${failed ? '✗' : '✅'} test-run-chain-batch: ${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
