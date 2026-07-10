// oscal-mapping.test.mjs — EXPORT-1 §E1.a: OCG receipt -> OSCAL assessment-results mapping.
// Structural shape check against the OSCAL 1.1.3 assessment-results model's required members (see
// _oscal.mjs header for the schema-validation FLAG — no live schema fetch in this environment).
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { receiptToOscalAssessmentResults } from '../_oscal.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = JSON.parse(readFileSync(join(HERE, 'fixtures', 'anchor-binding.fixture.json'), 'utf8'));
const artifact = FIX.artifact;

let fail = 0;
const ok = (c, m) => { if (!c) { fail++; console.error('  ✗ ' + m); } else console.log('  ✓ ' + m); };

console.log('§E1.a OSCAL assessment-results mapping\n');

// ── happy path ─────────────────────────────────────────────────────────────────────────────────
{
  const doc = receiptToOscalAssessmentResults(artifact, { uuid: 'test-uuid-0001' });
  const ar = doc['assessment-results'];
  ok(ar.uuid === 'test-uuid-0001', 'root uuid is the caller-supplied value');
  ok(ar.metadata['oscal-version'] === '1.1.3', 'metadata.oscal-version pinned to 1.1.3');
  ok(ar.metadata['last-modified'] === artifact.generated_at, 'last-modified reuses artifact.generated_at verbatim (no Date.now())');
  ok(ar.metadata.props.some((p) => p.name === 'ocg-execution-hash' && p.value === artifact.execution_hash), 'execution_hash carried as a metadata prop');
  ok(Array.isArray(ar.results) && ar.results.length === 1, 'exactly one results[] entry (one receipt = one result)');
  const result = ar.results[0];
  ok(result.start === artifact.generated_at, 'result.start reuses artifact.generated_at');
  ok(Array.isArray(result.observations) && result.observations.length === artifact.output_payload.checks.length,
    'one observation per output_payload.checks[] entry (re-expression, 1:1, no invented findings)');
  ok(result.observations.every((o) => o.collected === artifact.generated_at), 'every observation.collected reuses artifact.generated_at');
  ok(Array.isArray(result.findings) && result.findings.length === artifact.compliance_flags.length,
    'one finding per compliance_flags[] entry (re-expression, 1:1)');
  ok(result.findings.every((f) => artifact.compliance_flags.includes(f.title)), 'every finding.title is a verbatim compliance_flags entry — no fabricated finding');
  ok(result.findings.every((f) => Array.isArray(f['related-observations']) && f['related-observations'].length === result.observations.length),
    'every finding cross-references the observations (traceable back to the receipt)');
  ok(result['reviewed-controls'].remarks.includes('No control-catalog mapping is asserted'), 'reviewed-controls carries the no-control-mapping disclaimer');
}

// ── determinism: same input + same uuid -> byte-identical output ─────────────────────────────────
{
  const a = JSON.stringify(receiptToOscalAssessmentResults(artifact, { uuid: 'fixed-uuid' }));
  const b = JSON.stringify(receiptToOscalAssessmentResults(artifact, { uuid: 'fixed-uuid' }));
  ok(a === b, 'mapping is deterministic — identical input + uuid produce byte-identical output');
}

// ── optional import-ap ─────────────────────────────────────────────────────────────────────────
{
  const doc = receiptToOscalAssessmentResults(artifact, { uuid: 'u2', importApHref: '#ap-1' });
  ok(doc['assessment-results']['import-ap']?.href === '#ap-1', 'import-ap.href passed through when supplied');
  const doc2 = receiptToOscalAssessmentResults(artifact, { uuid: 'u3' });
  ok(!('import-ap' in doc2['assessment-results']), 'import-ap omitted (not emitted as null/undefined) when not supplied');
}

// ── error handling: required inputs ───────────────────────────────────────────────────────────
{
  let threw = false;
  try { receiptToOscalAssessmentResults(artifact, {}); } catch { threw = true; }
  ok(threw, 'throws without a caller-supplied uuid');

  let threw2 = false;
  try { receiptToOscalAssessmentResults({ ...artifact, generated_at: undefined }, { uuid: 'x' }); } catch { threw2 = true; }
  ok(threw2, 'throws without artifact.generated_at (never falls back to a fabricated timestamp)');
}

console.log(fail ? `\n✗ ${fail} FAILED` : '\n✓ all OSCAL mapping assertions passed');
process.exit(fail ? 1 : 0);
