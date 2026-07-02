// OCGR embedded-bundle self-test. Proves, with no network access, that:
//   1. runChain reproduces the CANONICAL composite execution_hash the live Worker emits
//      for every conformance vector (incl. agent-commerce-conformance = e51f3c23…).
//   2. The §16 signer/verifier ACCEPTS a valid signature and REJECTS a tampered artifact.
//   3. The §18 compute-proof verifier ACCEPTS a live receipt and REJECTS a tampered one.
//   4. The bundle contains ZERO network/telemetry calls (source grep).
//
// Run:  node embed/selftest.mjs      (from the mcp-apps-poc/ repo root)
// Exit: 0 = all green; non-zero = a divergence (never papered over — it fails loud).

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runChain } from './runChain.mjs';
import { verifyExecutionHash, verifySignature, verifyComputeProof } from './verify.mjs';
import { sign, rawPubkeyToDidKey } from './lib/_proof.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
let failures = 0;
const ok = (label) => console.log('  ✓ ' + label);
const bad = (label, detail) => { failures++; console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); };

// ---------------------------------------------------------------------------
console.log('\n[1] runChain reproduces the canonical composite execution_hash');
const conf = JSON.parse(readFileSync(here + 'fixtures/conformance.json', 'utf8'));
let lastArtifact = null;
for (const v of conf.vectors) {
  const r = await runChain(v.chain);
  if (r.steps_ran !== v.steps) { bad(v.chain, `ran ${r.steps_ran}/${v.steps} steps`); continue; }
  if (r.composite_execution_hash !== v.expected_composite_execution_hash) {
    bad(v.chain, `hash ${r.composite_execution_hash} != canonical ${v.expected_composite_execution_hash}`);
    continue;
  }
  // §4: the composite artifact must self-verify.
  const vh = await verifyExecutionHash(r.composite_artifact);
  if (!vh.valid) { bad(v.chain, 'composite artifact failed §4 self-verify'); continue; }
  ok(`${v.chain} → ${r.composite_execution_hash.slice(0, 16)}… (${v.steps} steps, §4 ✓)`);
  lastArtifact = r.composite_artifact;
}

// ---------------------------------------------------------------------------
console.log('\n[2] §16 signature: accept valid, reject tampered');
{
  const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const did = await rawPubkeyToDidKey(pair.publicKey);
  const signed = await sign(lastArtifact, { verificationMethod: did, created: '2026-07-01T00:00:00Z', privateKey: pair.privateKey });
  if (await verifySignature(signed)) ok('valid signature accepted (did:key resolved from proof)');
  else bad('valid signature', 'verifySignature returned false');

  const tampered = JSON.parse(JSON.stringify(signed));
  tampered.output_payload.chain = tampered.output_payload.chain + '-tampered';
  if (!(await verifySignature(tampered))) ok('tampered artifact rejected');
  else bad('tampered signature', 'verifySignature accepted a mutated artifact');
}

// ---------------------------------------------------------------------------
console.log('\n[3] §18 compute-proof: accept live receipt, reject tampered');
{
  const cg = JSON.parse(readFileSync(here + '../data/chaingraph/chaingraph.json', 'utf8'));
  const withProof = (cg.nodes ?? []).find((n) => n.compute_proof && n.compute_proof.receiptFormat === 'groth16-bn254');
  if (!withProof) { bad('§18', 'no groth16-bn254 compute_proof found in catalog'); }
  else {
    if (verifyComputeProof(withProof.compute_proof)) ok(`live receipt accepted (${withProof.tool_id}, imageId ${withProof.compute_proof.imageId.slice(0, 20)}…)`);
    else bad('§18 valid receipt', 'verifyComputeProof returned false');

    const tampered = JSON.parse(JSON.stringify(withProof.compute_proof));
    tampered.journal.output = { ...tampered.journal.output, __tamper: true };
    if (!verifyComputeProof(tampered)) ok('tampered receipt rejected');
    else bad('§18 tampered receipt', 'verifyComputeProof accepted a mutated journal');
  }
}

// ---------------------------------------------------------------------------
console.log('\n[4] zero network / zero telemetry (source grep)');
{
  const FORBIDDEN = [/\bfetch\s*\(/, /XMLHttpRequest/, /navigator\.sendBeacon/, /WebSocket/, /import\s*\(\s*['"]https?:/, /require\(\s*['"](node:)?(http|https|net|dgram|dns)['"]/];
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = dir + name;
      if (statSync(p).isDirectory()) { walk(p + '/'); continue; }
      // Scan the shippable bundle only; this self-test file legitimately contains the
      // forbidden-pattern literals it greps for, so exclude it.
      if (/\.mjs$/.test(name) && name !== 'selftest.mjs') files.push(p);
    }
  };
  walk(here);
  let hits = 0;
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    for (const re of FORBIDDEN) {
      if (re.test(src)) { hits++; bad('network call in ' + f.slice(here.length), re.toString()); }
    }
  }
  if (!hits) ok(`no network/telemetry constructs across ${files.length} bundle .mjs files`);
}

// ---------------------------------------------------------------------------
console.log('');
if (failures) { console.error(`SELFTEST FAILED: ${failures} check(s) failed.`); process.exit(1); }
console.log('SELFTEST PASSED: embedded runChain matches the canonical hashes; verifiers accept valid & reject tampered; zero network.');
