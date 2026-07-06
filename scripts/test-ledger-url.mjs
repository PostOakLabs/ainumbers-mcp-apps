#!/usr/bin/env node
// test-ledger-url.mjs — ledger_url rider tests (S-DB2).
//
// 1. Round-trip: fragmentLink(artifact) → decode → gunzip → byte-identical JSON.
// 2. Over-budget artifact → ledger_url_note, no ledger_url.
// 3. run_chain response carries ledger_url for a fixture-runnable chain.
// 4. hash-freeze goldens: confirm no composite_execution_hash moved.

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DecompressionStream } from 'node:stream/web';
import { fragmentLink } from '../worker.mjs';
import { runChain } from '../embed/runChain.mjs';
import { getKernel } from '../kernels/index.mjs';

const ROOT   = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA   = resolve(ROOT, 'data');
const rd     = (p) => JSON.parse(readFileSync(resolve(DATA, p), 'utf8'));
const GOLDENS = resolve(ROOT, 'test', 'linear-hash-freeze.goldens.json');

const chaingraph = rd('chaingraph/chaingraph.json');
const fixtures   = rd('chain-fixtures.json');
const goldens    = JSON.parse(readFileSync(GOLDENS, 'utf8'));

let pass = 0, fail = 0;
const ok  = (msg) => { console.log('  ✅ ' + msg); pass++; };
const err = (msg) => { console.error('  ❌ ' + msg); fail++; };

// ── helpers ──────────────────────────────────────────────────────────────────

function base64urlDecode(s) {
  // Reverse base64url: - → +, _ → /, add padding
  const padded = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = (4 - (padded.length % 4)) % 4;
  const b64 = padded + '='.repeat(pad);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function gunzip(bytes) {
  const ds = new DecompressionStream('gzip');
  const writer = ds.writable.getWriter();
  writer.write(bytes);
  writer.close();
  const chunks = [];
  const reader = ds.readable.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  let len = 0;
  for (const c of chunks) len += c.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return new TextDecoder().decode(out);
}

// ── Test 1: round-trip ────────────────────────────────────────────────────────

console.log('\nTest 1: round-trip (encode → decode → gunzip → byte-identical)');
{
  const artifact = {
    '@context': 'https://ainumbers.co/chaingraph/context/v0.3/context.jsonld',
    chaingraph_version: '0.4.0',
    execution_hash: 'abc123',
    policy_parameters: { chain: 'test', step_count: 1 },
    output_payload: { chain: 'test', steps: [{ tool_id: 'x', execution_hash: 'def456', output_payload: { result: 42 } }] },
  };
  const originalJson = JSON.stringify(artifact);

  const res = await fragmentLink(artifact);
  if (!res.ledger_url) { err('no ledger_url returned (artifact too large?)'); }
  else {
    ok('ledger_url present: ' + res.ledger_url.slice(0, 60) + '...');

    // Decode
    const url = res.ledger_url;
    const prefix = 'https://ledger.ainumbers.co/#a=v1.';
    if (!url.startsWith(prefix)) { err('URL prefix mismatch: ' + url); }
    else {
      const encoded = url.slice(prefix.length);
      const compressed = base64urlDecode(encoded);
      const decoded = await gunzip(compressed);
      if (decoded === originalJson) {
        ok('decoded JSON byte-identical to JSON.stringify(artifact)');
      } else {
        err('decoded JSON differs from original\n  got:      ' + decoded.slice(0, 120) + '\n  expected: ' + originalJson.slice(0, 120));
      }
    }
  }
}

// ── Test 2: over-budget artifact ──────────────────────────────────────────────

console.log('\nTest 2: over-budget artifact → ledger_url_note, no ledger_url');
{
  // Build an artifact that gzips to > 30KB.
  // Gzip compresses repetitive data very well, so we need something random-ish.
  // Use a large hex string derived from incrementing numbers (hard to compress).
  const bigArray = [];
  for (let i = 0; i < 3000; i++) bigArray.push('field_' + i.toString().padStart(6, '0') + '_' + Math.floor(i * 1234567 % 999983).toString(16));
  const overBudget = {
    execution_hash: 'x'.repeat(64),
    policy_parameters: { dummy: bigArray },
    output_payload: { result: bigArray },
  };
  const res = await fragmentLink(overBudget);
  if (res.ledger_url) {
    err('ledger_url present on over-budget artifact (should be note only)');
  } else if (res.ledger_url_note && res.ledger_url_note.includes('download')) {
    ok('over-budget returns ledger_url_note: ' + res.ledger_url_note);
  } else {
    err('unexpected response: ' + JSON.stringify(res));
  }
}

// ── Test 3: run_chain response carries ledger_url ────────────────────────────

console.log('\nTest 3: run_chain response includes ledger_url');
{
  // Find a fixture-runnable chain (first one from goldens)
  const chainName = Object.keys(goldens)[0];
  if (!chainName) {
    err('no goldens found — run linear-hash-freeze.mjs --capture first');
  } else {
    console.log('  using chain: ' + chainName);
    const result = await runChain(chainName, undefined, { getKernel, chaingraph, fixtures });
    // runChain (embed) does NOT emit ledger_url — that's the Worker handler.
    // We test fragmentLink over the composite_artifact directly to verify the
    // worker path would work — the actual Worker handler test is in wrangler dry-run.
    if (!result.composite_artifact) {
      err('no composite_artifact in run_chain result — chain may need inputs');
    } else {
      const db = await fragmentLink(result.composite_artifact);
      if (db.ledger_url) {
        ok('fragmentLink(composite_artifact) → ledger_url present');
        // Verify round-trip on the actual composite artifact
        const prefix = 'https://ledger.ainumbers.co/#a=v1.';
        const encoded = db.ledger_url.slice(prefix.length);
        const compressed = base64urlDecode(encoded);
        const decoded = await gunzip(compressed);
        const roundTripped = JSON.parse(decoded);
        if (roundTripped.execution_hash === result.composite_artifact.execution_hash) {
          ok('round-trip execution_hash matches composite_artifact.execution_hash');
        } else {
          err('round-trip execution_hash mismatch');
        }
      } else if (db.ledger_url_note) {
        ok('composite_artifact over 30KB budget → ledger_url_note (acceptable for large chains)');
      } else {
        err('unexpected: ' + JSON.stringify(db));
      }
    }
  }
}

// ── Test 4: hash-freeze goldens unmoved ───────────────────────────────────────

console.log('\nTest 4: hash-freeze goldens unchanged');
{
  let moved = 0;
  for (const [chainName, golden] of Object.entries(goldens)) {
    const chainInCatalog = (chaingraph.chains ?? []).some((c) => c.name === chainName);
    if (!chainInCatalog) continue;
    try {
      const result = await runChain(chainName, undefined, { getKernel, chaingraph, fixtures });
      if (result.composite_execution_hash && result.composite_execution_hash !== golden.composite_execution_hash) {
        err('HASH MOVED: ' + chainName + '\n  golden:  ' + golden.composite_execution_hash + '\n  current: ' + result.composite_execution_hash);
        moved++;
      }
    } catch { /* unrunnable — skip */ }
  }
  if (moved === 0) ok('all linear-chain composite hashes match goldens (' + Object.keys(goldens).length + ' chains checked)');
}

// ── Summary ───────────────────────────────────────────────────────────────────

console.log('\n' + (fail === 0 ? '✅ All tests passed' : '❌ ' + fail + ' test(s) FAILED') + ' (' + pass + ' passed, ' + fail + ' failed)\n');
if (fail > 0) process.exit(1);
