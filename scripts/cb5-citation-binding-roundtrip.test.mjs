// cb5-citation-binding-roundtrip.test.mjs — CB5-EXPORT-RENDER-1 gate.
// Proves exportArtifact()'s citation_binding rendering (§6 CB-5) is post-hash: it reads
// regulatory_citations/regulatory_basis off the artifact and the execution_hash recomputed
// from the SAME policy_parameters/output_payload after export still matches the artifact's
// claimed hash — the rendering never touched the preimage.
import { executionHash } from '../kernels/_hash.mjs';
import { exportArtifact } from '../exporters/index.mjs';

let fail = 0;
const ok = (c, m) => { if (!c) { fail++; console.error('  ✗ ' + m); } else console.log('  ✓ ' + m); };

console.log('CB5-EXPORT-RENDER-1 — citation_binding round-trip\n');

const policy_parameters = { jurisdiction: 'US-FED', threshold: 0.15 };
const output_payload = {
  verdict: 'pass',
  regulatory_basis: 'SR 26-2',
  regulatory_citations: [
    {
      scheme: 'cfr', id: '17 CFR 240.15c3-3', path: '(e)(3)',
      in_force_from: '2026-04-17', jurisdiction: 'US-FED',
      mapped_by: 'test-fixture', mapped_at: '2026-08-05',
    },
    { scheme: 'sr-letter', id: 'SR 26-2', mapped_by: 'test-fixture', mapped_at: '2026-08-05' },
    'MiCA',
  ],
};
const hash = await executionHash(policy_parameters, output_payload);
const artifact = {
  tool_id: 'cb5-fixture', chaingraph_version: 'v0.4', compute_mode: 'server',
  policy_parameters, output_payload, execution_hash: hash,
};

const before = JSON.stringify(artifact);
const res = exportArtifact({ artifact, format: 'csv' });
const after = JSON.stringify(artifact);

ok(res.ok, 'exportArtifact() succeeded');
ok(after === before, 'artifact object byte-identical after export (no mutation)');

const rehash = await executionHash(artifact.policy_parameters, artifact.output_payload);
ok(rehash === hash, `execution_hash round-trips: ${rehash} === ${hash}`);
ok(res.metadata?.execution_hash === hash, 'exported metadata.execution_hash matches artifact.execution_hash');

const cb = res.citation_binding;
ok(cb?.count === 4, `citation_binding.count === 4 (got ${cb?.count})`);
const cfr = cb.citations.find((c) => c.id === '17 CFR 240.15c3-3');
ok(cfr?.pinned === true && cfr?.level === 'L3', `CFR citation pinned L3 (got pinned=${cfr?.pinned} level=${cfr?.level})`);
const srLetter = cb.citations.find((c) => c.id === 'SR 26-2' && c.scheme === 'sr-letter');
ok(srLetter?.pinned === true && srLetter?.level === 'L1', `bare scheme+id SR letter pinned L1 (got ${srLetter?.level})`);
const legacyBasis = cb.citations.find((c) => c.text === 'SR 26-2');
ok(legacyBasis?.pinned === false && legacyBasis?.level === 'L0', 'legacy regulatory_basis string rendered unpinned L0');
const mica = cb.citations.find((c) => c.text === 'MiCA');
ok(mica?.pinned === false && mica?.level === 'L0', 'legacy regulatory_citations string entry rendered unpinned L0');

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
