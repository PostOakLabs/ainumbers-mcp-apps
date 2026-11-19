// oscal-mapping.test.mjs — EXPORT-1 §E1.a + GRC-PILOT-OSCAL-EXPORT-1: OCG receipt / AIUC-1
// evidence pack -> OSCAL 1.2.3 assessment-results mapping, schema-VALIDATED against the vendored
// CC0 NIST v1.2.3 schema with ajv (scripts/fixtures/oscal-1.2.3/README.md has provenance).
// This closes the 1.1.3-era "hand-verified against required members only" FLAG.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { receiptToOscalAssessmentResults, aiuc1PackToOscalAssessmentResults, OSCAL_MAPPING_VERSION } from '../_oscal.mjs';
import { compute as computeArt304 } from '../kernels/art-304-aiuc1-evidence-pack-assembler.kernel.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = JSON.parse(readFileSync(join(HERE, 'fixtures', 'anchor-binding.fixture.json'), 'utf8'));
const OSCAL_FIX_DIR = join(HERE, 'fixtures', 'oscal-1.2.3');
const ART304_VECTORS = JSON.parse(readFileSync(join(HERE, '..', 'data', 'chain-fixtures.json'), 'utf8'))['assemble-aiuc1-evidence-pack']['art-304-aiuc1-evidence-pack-assembler'];

// Valid RFC 4122 v4 UUID roots (version nibble 4, variant 8/9/a/b) — the NIST UUIDDatatype
// pattern the schema enforces and the mappers demand as the v5 namespace.
const RECEIPT_ROOT = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const RECEIPT_ROOT_2 = '5d4c3b2a-1f0e-4d3c-9b1a-0f9e8d7c6b5a';
const PACK_ROOT = '2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e';
const FIXED_HASH = 'sha256:' + 'ab'.repeat(32);
const UUID_SHAPE_RE = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[45][0-9A-Fa-f]{3}-[89ABab][0-9A-Fa-f]{3}-[0-9A-Fa-f]{12}$/;

let fail = 0;
const ok = (c, m) => { if (!c) { fail++; console.error('  ✗ ' + m); } else console.log('  ✓ ' + m); };

console.log('§E1.a + GRC-PILOT OSCAL 1.2.3 mapping (schema-validated)\n');

// ── ajv validator setup, proven against the four NIST golden examples ────────────────────────
const ajv = new Ajv({ allErrors: true });
addFormats(ajv);
const validateAr = ajv.compile(JSON.parse(readFileSync(join(OSCAL_FIX_DIR, 'oscal_assessment-results_schema.json'), 'utf8')));
const validateDoc = (doc, m) => {
  const valid = validateAr(doc);
  ok(valid, m + (valid ? '' : ' — ajv: ' + JSON.stringify(validateAr.errors).slice(0, 400)));
  return valid;
};

for (const f of [
  'ifa_assessment-results-min.json',
  'ifa_assessment-results.json',
  'ifa_assessment-results-example-min.json',
  'ifa_assessment-results-example.json',
]) {
  validateDoc(JSON.parse(readFileSync(join(OSCAL_FIX_DIR, f), 'utf8')), `golden NIST example validates against the vendored 1.2.3 schema (${f}) — proves the validator setup`);
}

// ── receipt mapper: happy path ────────────────────────────────────────────────────────────────
const artifact = FIX.artifact;
{
  const doc = receiptToOscalAssessmentResults(artifact, { uuid: RECEIPT_ROOT });
  const ar = doc['assessment-results'];
  ok(ar.uuid === RECEIPT_ROOT, 'root uuid is the caller-supplied value');
  ok(ar.metadata['oscal-version'] === '1.2.3', 'metadata.oscal-version pinned to 1.2.3');
  ok(OSCAL_MAPPING_VERSION === '1.2.3', 'OSCAL_MAPPING_VERSION bumped to 1.2.3');
  ok(ar.metadata['last-modified'] === artifact.generated_at, 'last-modified reuses artifact.generated_at verbatim (no Date.now())');
  ok(ar.metadata.props.some((p) => p.name === 'ocg-execution-hash' && p.value === artifact.execution_hash), 'execution_hash carried as a metadata prop');
  ok(ar['import-ap']?.href === '#ocg-assessment-plan-stub', 'import-ap ALWAYS emitted — documented # stub when the caller supplies no plan');
  ok(Array.isArray(ar.results) && ar.results.length === 1, 'exactly one results[] entry (one receipt = one result)');
  const result = ar.results[0];
  ok(result.start === artifact.generated_at, 'result.start reuses artifact.generated_at');
  ok(Array.isArray(result.observations) && result.observations.length === artifact.output_payload.checks.length,
    'one observation per output_payload.checks[] entry (re-expression, 1:1, no invented findings)');
  ok(result.observations.every((o) => o.collected === artifact.generated_at), 'every observation.collected reuses artifact.generated_at');
  ok(Array.isArray(result.findings) && result.findings.length === artifact.compliance_flags.length,
    'one finding per compliance_flags[] entry (re-expression, 1:1)');
  ok(result.findings.every((f) => artifact.compliance_flags.includes(f.title)), 'every finding.title is a verbatim compliance_flags entry — no fabricated finding');
  ok(result.findings.every((f) => f.target?.type === 'objective-id' && typeof f.target['target-id'] === 'string' && f.target.status?.state === 'satisfied' && typeof f.target.status.remarks === 'string'),
    'every finding carries the schema-required target {type, target-id, status.state} with the re-expression disclaimer in remarks');
  ok(result['reviewed-controls'].remarks.includes('No control-catalog mapping is asserted'), 'reviewed-controls carries the no-control-mapping disclaimer');
}

// ── every uuid in the document is an RFC 4122 v4/v5 UUID, deterministically derived ──────────
{
  const doc = receiptToOscalAssessmentResults(artifact, { uuid: RECEIPT_ROOT });
  const ar = doc['assessment-results'];
  const uuids = [ar.uuid, ...ar.results.map((r) => r.uuid),
    ...ar.results.flatMap((r) => (r.observations ?? []).map((o) => o.uuid)),
    ...ar.results.flatMap((r) => (r.findings ?? []).map((f) => f.uuid)),
    ...ar.results.flatMap((r) => (r.observations ?? []).flatMap((o) => (o.subjects ?? []).map((s) => s['subject-uuid']))),
  ];
  ok(uuids.every((u) => UUID_SHAPE_RE.test(u)), `all ${uuids.length} uuids in the document satisfy the NIST UUIDDatatype pattern (RFC 4122 v4/v5) — no 'observation-<i>' style ids`);

  const again = receiptToOscalAssessmentResults(artifact, { uuid: RECEIPT_ROOT });
  const otherRoot = receiptToOscalAssessmentResults(artifact, { uuid: RECEIPT_ROOT_2 });
  ok(JSON.stringify(doc) === JSON.stringify(again), 'same root uuid -> byte-identical document (UUID v5 derivation is deterministic)');
  ok(doc['assessment-results'].results[0].uuid !== otherRoot['assessment-results'].results[0].uuid,
    'different root uuid -> different derived uuids (no cross-document collisions)');
}

// ── import-ap passthrough + empty-array omission ──────────────────────────────────────────────
{
  const doc = receiptToOscalAssessmentResults(artifact, { uuid: RECEIPT_ROOT, importApHref: '#ap-1' });
  ok(doc['assessment-results']['import-ap']?.href === '#ap-1', 'import-ap.href passes through when the caller supplies a plan');
  const bare = { ...artifact, output_payload: { ...artifact.output_payload, checks: [] }, compliance_flags: [] };
  const doc2 = receiptToOscalAssessmentResults(bare, { uuid: RECEIPT_ROOT });
  const result = doc2['assessment-results'].results[0];
  ok(!('observations' in result) && !('findings' in result),
    'zero checks/flags -> observations/findings arrays OMITTED (schema minItems 1 forbids [])');
  validateDoc(doc2, 'empty-receipt document still schema-validates');
}

// ── error handling: required inputs ──────────────────────────────────────────────────────────
{
  let threw = false;
  try { receiptToOscalAssessmentResults(artifact, {}); } catch { threw = true; }
  ok(threw, 'throws without a caller-supplied uuid');

  let threwNotUuid = false;
  try { receiptToOscalAssessmentResults(artifact, { uuid: 'test-uuid-0001' }); } catch { threwNotUuid = true; }
  ok(threwNotUuid, 'throws on a non-RFC-4122 root uuid (it is the v5 namespace + schema-checked root)');

  let threw2 = false;
  try { receiptToOscalAssessmentResults({ ...artifact, generated_at: undefined }, { uuid: RECEIPT_ROOT }); } catch { threw2 = true; }
  ok(threw2, 'throws without artifact.generated_at (never falls back to a fabricated timestamp)');
}

// ── receipt mapper output schema-validates ────────────────────────────────────────────────────
{
  const doc = receiptToOscalAssessmentResults(artifact, { uuid: RECEIPT_ROOT });
  validateDoc(doc, 'receipt mapper output schema-validates against the vendored 1.2.3 schema');
}

// ── AIUC-1 pack mapper: node art-304 first fixture vector ─────────────────────────────────────
{
  const { output_payload } = computeArt304(ART304_VECTORS);
  ok(output_payload.controls.length === 3, 'art-304 first fixture vector assembles 3 controls through the real kernel compute');
  const doc = aiuc1PackToOscalAssessmentResults(output_payload, { uuid: PACK_ROOT, executionHash: FIXED_HASH });
  const ar = doc['assessment-results'];
  ok(ar.results.length === 1, 'one result per pack');
  const result = ar.results[0];
  ok(result.observations.length === 3 && result.findings.length === 3, 'one evidence observation + one finding per control');
  ok(result.observations.every((o) => o.title.includes('Evidence observation') && o.description.includes('not an assessment verdict')),
    'observations are labelled evidence observations, explicitly not assessment verdicts');
  ok(result.findings.every((f) => f.target['target-id'] === output_payload.controls.find((c) => f.title.endsWith(c.control_id))?.control_id),
    'every finding targets its AIUC-1 control id');
  ok(result.findings.every((f) => f.target.status.state === 'satisfied') && output_payload.controls.every((c) => c.status === 'receipt-backed'),
    'first vector is all receipt-backed -> every finding state is satisfied');
  ok(result.observations.every((o) => o['relevant-evidence']?.every((e) => e.href.startsWith('#sha256:'))),
    'relevant-evidence lists the controls\' artifact digests (fragment hrefs over the real digests)');
  ok(result.props.some((p) => p.name === 'ocg-execution-hash' && p.value === FIXED_HASH), 'execution hash carried as a result prop');
  ok(ar.metadata['last-modified'] === '1970-01-01T00:00:00Z', 'no timestamp in a pack -> documented 1970 sentinel (byte-deterministic, no Date.now())');
  ok(aiuc1PackToOscalAssessmentResults(output_payload, { uuid: PACK_ROOT, executionHash: FIXED_HASH, lastModified: '2026-11-16T00:00:00Z' })['assessment-results'].metadata['last-modified'] === '2026-11-16T00:00:00Z',
    'caller-supplied lastModified is honored when present');
  validateDoc(doc, 'pack mapper output for the art-304 first fixture vector schema-validates');

  const again = aiuc1PackToOscalAssessmentResults(output_payload, { uuid: PACK_ROOT, executionHash: FIXED_HASH });
  ok(JSON.stringify(doc) === JSON.stringify(again), 'pack mapping is deterministic — second run byte-identical');
}

// ── AIUC-1 pack mapper: attestation-only and missing map to not-satisfied ─────────────────────
{
  const attestationVector = { ...ART304_VECTORS, control_mapping: [...ART304_VECTORS.control_mapping] };
  attestationVector.control_mapping[0] = { ...attestationVector.control_mapping[0], artifact_refs: [...attestationVector.control_mapping[0].artifact_refs, 'no-such-artifact'] };
  const { output_payload: att } = computeArt304(attestationVector);
  ok(att.controls[0].status === 'attestation-only', 'variant A: unresolved ref -> kernel says attestation-only');
  const missingVector = { ...ART304_VECTORS, control_mapping: [{ ...ART304_VECTORS.control_mapping[0], artifact_refs: [] }, ART304_VECTORS.control_mapping[1], ART304_VECTORS.control_mapping[2]] };
  const { output_payload: mis } = computeArt304(missingVector);
  ok(mis.controls[0].status === 'missing', 'variant B: empty refs -> kernel says missing');

  for (const [name, payload, expectState] of [['attestation-only', att, 'not-satisfied'], ['missing', mis, 'not-satisfied']]) {
    const doc = aiuc1PackToOscalAssessmentResults(payload, { uuid: PACK_ROOT, executionHash: FIXED_HASH });
    const finding = doc['assessment-results'].results[0].findings.find((f) => f.target['target-id'] === 'AIUC-A-01');
    ok(finding.target.status.state === expectState, `${name} control maps to ${expectState}`);
    ok(typeof finding.target.status.remarks === 'string' && finding.target.status.remarks.length > 0, `${name} reason carried in status remarks`);
    validateDoc(doc, `${name} pack rendering schema-validates`);
  }
}

// ── pack edge cases: version mismatch + required inputs ──────────────────────────────────────
{
  const { output_payload: mismatched } = computeArt304({ ...ART304_VECTORS, aiuc1_version: '1999-Q1' });
  ok(mismatched.controls.length === 0, 'variant C: wrong catalog version -> kernel returns zero controls');
  const doc = aiuc1PackToOscalAssessmentResults(mismatched, { uuid: PACK_ROOT, executionHash: FIXED_HASH });
  const result = doc['assessment-results'].results[0];
  ok(!('observations' in result) && !('findings' in result), 'version-mismatch pack -> observations/findings omitted (minItems 1)');
  validateDoc(doc, 'version-mismatch pack rendering schema-validates');

  let threw = false;
  try { aiuc1PackToOscalAssessmentResults({}, { uuid: PACK_ROOT }); } catch { threw = true; }
  ok(threw, 'throws without an executionHash — the rendering must bind the execution it re-expresses');
  let threwNotUuid = false;
  try { aiuc1PackToOscalAssessmentResults({}, { uuid: 'not-a-uuid', executionHash: FIXED_HASH }); } catch { threwNotUuid = true; }
  ok(threwNotUuid, 'throws on a non-RFC-4122 root uuid');
}

console.log(fail ? `\n✗ ${fail} FAILED` : '\n✓ all OSCAL 1.2.3 mapping assertions passed');
process.exit(fail ? 1 : 0);
