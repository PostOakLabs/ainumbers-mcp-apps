// accept-api-flow.test.mjs — MONDAY-SHIP §AA ACCEPT-API: exercises the composed
// agreement-acceptance receipt flow end-to-end over the two LIVE kernels
// (art-276 assemble_mutual_nda -> art-277 bind_agreement_acceptance). No new
// kernel, no chaingraph.json touch — pure composition/example of shipped primitives.
import { buildArtifact as assembleMnda } from '../kernels/art-276-mutual-nda-composer.kernel.mjs';
import { buildArtifact as bindAcceptance } from '../kernels/art-277-agreement-acceptance-binder.kernel.mjs';

let fail = 0;
const ok = (c, m) => { if (!c) { fail++; console.error('  ✗ ' + m); } else console.log('  ✓ ' + m); };

console.log('ACCEPT-API — assemble_mutual_nda -> bind_agreement_acceptance composed flow\n');

const now = '2026-07-10T12:00:00.000Z';

// Step 1: assemble the MNDA from Cover Page Key Terms (art-276). Zero-PII —
// no party identity is ever passed to this kernel.
const mndaPolicy = {
  purpose: 'Evaluating a potential commercial integration',
  effective_date: '2026-07-10',
  mnda_term_mode: 'expires_after_period',
  mnda_term_years: 2,
  confidentiality_term_mode: 'fixed_period',
  confidentiality_term_years: 5,
  governing_law: 'Delaware',
  jurisdiction: 'Delaware',
};
const mndaArtifact = await assembleMnda(mndaPolicy, { now });

ok(mndaArtifact.output_payload.checks.every((c) => c.pass), 'art-276 all Key Terms checks pass');
ok(!!mndaArtifact.output_payload.assembled_markdown, 'art-276 emits assembled_markdown (Cover Page + vendored Standard Terms body)');
ok(mndaArtifact.output_payload.contract_api.template_id === 'common-paper-mnda-v1.0', 'art-276 contract_api twin carries the template_id');
ok(/^[0-9a-f]{64}$/.test(mndaArtifact.execution_hash), 'art-276 execution_hash is a well-formed hex SHA-256');

// Step 2: party A binds their acceptance to the EXACT assembled artifact, by
// hash reference only — never by re-embedding the agreement text (art-277).
const bindPolicyA = {
  referenced_execution_hash: mndaArtifact.execution_hash,
  template_id: mndaArtifact.output_payload.template_id,
  body_sha256: mndaArtifact.output_payload.body_sha256,
  accepting_party_role: 'party_a',
};
const acceptanceA = await bindAcceptance(bindPolicyA, { now, parent_hashes: [mndaArtifact.execution_hash], parent_tool_ids: [mndaArtifact.tool_id], chain_depth: 1 });

ok(acceptanceA.output_payload.checks.every((c) => c.pass), 'art-277 (party_a) all validation checks pass');
ok(acceptanceA.output_payload.referenced_execution_hash === mndaArtifact.execution_hash, 'party_a acceptance references the art-276 artifact by execution_hash, not by re-embedding text');
ok(acceptanceA.output_payload.previous_proof_hash === null, 'party_a is the first acceptance — no previous_proof_hash yet');
ok(acceptanceA.chain.parent_hashes[0] === mndaArtifact.execution_hash, 'chain envelope hash-links back to the art-276 artifact');

// Step 3: party B binds acceptance, chaining to party A's acceptance via
// previous_proof_hash — the proof-chain hook this kernel exists to support.
const bindPolicyB = {
  referenced_execution_hash: mndaArtifact.execution_hash,
  template_id: mndaArtifact.output_payload.template_id,
  body_sha256: mndaArtifact.output_payload.body_sha256,
  accepting_party_role: 'party_b',
  previous_proof_hash: acceptanceA.execution_hash,
};
const acceptanceB = await bindAcceptance(bindPolicyB, { now, parent_hashes: [mndaArtifact.execution_hash, acceptanceA.execution_hash], parent_tool_ids: [mndaArtifact.tool_id, acceptanceA.tool_id], chain_depth: 2 });

ok(acceptanceB.output_payload.checks.every((c) => c.pass), 'art-277 (party_b) all validation checks pass');
ok(acceptanceB.output_payload.previous_proof_hash === acceptanceA.execution_hash, 'party_b acceptance chains to party_a acceptance via previous_proof_hash (populated)');
ok(Array.isArray(acceptanceB.compliance_flags) && acceptanceB.compliance_flags.includes('PROOF_CHAIN_REFERENCED'), 'party_b artifact carries PROOF_CHAIN_REFERENCED compliance flag');

// Full artifact set is a court-checkable receipt trio: assemble -> accept(A) -> accept(B),
// each hash-referencing the prior, never re-embedding party identity or the agreement text.
ok(mndaArtifact.execution_hash !== acceptanceA.execution_hash && acceptanceA.execution_hash !== acceptanceB.execution_hash, 'all three artifacts have distinct execution_hash values');

console.log(fail ? `\n✗ ${fail} FAILED` : '\n✓ all ACCEPT-API composed-flow assertions passed');
process.exit(fail ? 1 : 0);
