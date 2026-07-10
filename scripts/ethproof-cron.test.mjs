// ethproof-cron.test.mjs — POSTCAMPAIGN §ETH ETHPROOF-CRON: exercises the composed eth_getProof
// custody snapshot verify end-to-end (art-279 EIP-1186 state-proof verify -> anchor-lineage
// receipt). No new kernel, no chaingraph.json touch, zero-egress — pure composition of a shipped
// primitive on the live GAP-d cron substrate.
import { runEthProofSnapshotCheck, SAMPLE_ETH_PROOF } from '../_ethproof_cron.mjs';
import { verify as verifyReceipt, didKeyToPublicKey } from '../kernels/_proof.mjs';

let fail = 0;
const ok = (c, m) => { if (!c) { fail++; console.error('  ✗ ' + m); } else console.log('  ✓ ' + m); };

console.log('ETHPROOF-CRON — art-279 EIP-1186 verify -> anchor-lineage receipt\n');

const nowMs = Date.parse('2026-07-14T06:00:00.000Z');
const result = await runEthProofSnapshotCheck(SAMPLE_ETH_PROOF, nowMs);

// art-279 artifact
ok(/^[0-9a-f]{64}$/.test(result.artifact.execution_hash), 'art-279 execution_hash is a well-formed hex SHA-256');
ok(result.artifact.output_payload.verdict === 'VERIFIED', 'art-279 verdict VERIFIED for the demo-fixture single-leaf proof');
ok(result.artifact.output_payload.account_exists === true, 'art-279 account_exists true');
ok(result.artifact.compliance_flags.includes('STATE_PROOF_VERIFIED'), 'art-279 compliance_flags carries STATE_PROOF_VERIFIED');
ok(result.artifact.policy_parameters.account_proof.length === 1, 'demo fixture is a single-leaf-node proof (plumbing fixture, not a real mainnet snapshot)');

// Anchor-lineage receipt (kernels/_proof.mjs eddsa-jcs-2022, ephemeral did:key — same signer §RW/§AC use)
ok(result.receipt.ethproof_snapshot_receipt === 'v1', 'receipt carries the ethproof_snapshot_receipt version tag');
ok(result.receipt.artifact_ref === result.artifact.execution_hash, 'receipt artifact_ref points at the art-279 execution_hash, not a re-signed copy');
ok(result.receipt.verdict === 'VERIFIED', 'receipt carries the verdict re-expressed from the artifact (no new claim)');
ok(Array.isArray(result.receipt.audit_signature?.proof) ? result.receipt.audit_signature.proof.length > 0 : !!result.receipt.audit_signature?.proof,
  'receipt carries a non-empty audit_signature.proof');

const pubKey = await didKeyToPublicKey(result.verificationMethod);
const verified = await verifyReceipt(result.receipt, pubKey);
ok(verified === true, 'receipt signature verifies against its own did:key verificationMethod');

console.log(fail ? `\n${fail} FAILED` : '\nAll checks passed.');
process.exit(fail ? 1 : 0);
