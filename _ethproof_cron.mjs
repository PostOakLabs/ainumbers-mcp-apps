// _ethproof_cron.mjs — POSTCAMPAIGN §ETH: eth_getProof custody snapshot cron.
//
// Composes two already-shipped primitives on the live GAP-d weekly cron tick — mints nothing new,
// no new MCP tool, no chaingraph.json touch:
//   1. art-279 kernel (verify_eth_state_proof) — the EIP-1186 Merkle-Patricia state-proof
//      verifier, unmodified. Zero-egress: it never fetches an RPC endpoint, it only verifies a
//      SUPPLIED proof against a SUPPLIED trusted state root (see the kernel's own header).
//   2. kernels/_proof.mjs eddsa-jcs-2022 sign() — the SAME ephemeral-did:key receipt signer
//      §RW's _reserve_watch.mjs / §AC's _aiact_cron.mjs / GAP-a's renewal-watch checkpoint use.
//      This is the §20 anchor-lineage path — NOT a fresh RFC 3161/JAdES timestamp token. Minting
//      a fresh TSA timestamp from this worker is explicitly FLAGGED, same as every other §RW/§AC
//      note: no TSA-request integration exists here (zero-fetch, free-plan, no KV/D1/R2), and
//      inventing one would be a new crypto primitive the "borrow-not-depend / no new primitives"
//      rule guards against. A real RFC 3161 timestamp over this receipt is anchor-suite's job.
//
// §ETH.0 SCOPE (POSTCAMPAIGN-BUILD-SPECS.md §ETH — VERIFY/SNAPSHOT ONLY):
// This module does NOT call any RPC endpoint, paid or free. It never submits a transaction, never
// holds custody of any asset. The "snapshot" it verifies is a PASSED-IN eth_getProof-shaped input
// (account_proof + block_state_root), matching exactly what art-279's kernel already accepts —
// same zero-egress guarantee the kernel itself documents. No live custody-account feed is wired
// (this worker has no persistent artifact registry — no KV/D1/R2 binding — to hold a real
// account/window history), so each weekly tick verifies the SAME demo-fixture proof below, which
// proves the full plumbing (kernel verify -> anchor-lineage receipt -> envelope) fires live ahead
// of a real custodian/PoR-auditor feed integration. Wiring a live eth_getProof ingest source (via
// a free-tier public RPC snapshot the caller supplies, never a paid provider this worker calls
// itself) is a follow-on WU once a PoR audit-firm partner is onboarded — this WU is the receipted
// verify substrate, not the ingest pipeline. Any design requiring a paid RPC provider, an on-chain
// write, or custody of any asset is explicitly OUT of this WU's fence (§ETH.0 FLAG condition).
//
// Demo-fixture note: the proof below is a hand-built single-leaf-node MPT proof (account_proof
// length 1) for a synthetic address/account — nonce 3, balance 1 ETH, EMPTY_TRIE_ROOT storage
// root, EMPTY_CODE_HASH code hash (both well-known Ethereum constants for an EOA/empty-code
// account). It round-trips through art-279's compute() to verdict VERIFIED. It is a plumbing
// fixture, not a real mainnet snapshot — same honesty standard as §RW/§AC's demo-fixture inputs.

import { buildArtifact as buildStateProofArtifact, meta as stateProofMeta }
  from './kernels/art-279-state-proof-verifier.kernel.mjs';
import { sign, rawPubkeyToDidKey } from './kernels/_proof.mjs';

export const SAMPLE_ETH_PROOF = Object.freeze({
  block_state_root: '0x4adfb4a27413efda20613d728c22384bb7e45dab99ed53792496c4adaf95d048',
  address: '0x1111111111111111111111111111111111112222',
  account_proof: [
    '0xf872a1207eba6e0129c3cfd2ea21cf04b3be516515fcce2308e34255596be244e5c26737b84ef84c03880de0b6b3a7640000a056e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421a0c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470',
  ],
});

// Run one receipted eth_getProof custody snapshot check: build the art-279 verify artifact, then
// sign a small anchor-lineage receipt referencing its execution_hash (never re-signs the artifact
// itself — same pattern _reserve_watch.mjs / _aiact_cron.mjs use for their artifact_ref field).
// Deterministic over (proofInput, nowMs) except for the ephemeral signing key.
export async function runEthProofSnapshotCheck(proofInput, nowMs) {
  const now = new Date(nowMs).toISOString();
  const artifact = await buildStateProofArtifact(proofInput, { now });

  const keyPair = await globalThis.crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const verificationMethod = await rawPubkeyToDidKey(keyPair.publicKey);
  const receiptDoc = {
    ethproof_snapshot_receipt: 'v1',
    tool_id: stateProofMeta.tool_id,
    mcp_name: stateProofMeta.mcp_name,
    address: proofInput.address ?? null,
    block_state_root: proofInput.block_state_root ?? null,
    verdict: artifact.output_payload.verdict,
    compliance_flags: artifact.compliance_flags,
    artifact_ref: artifact.execution_hash,
    checked_at: now,
    // Pre-declared before signing — sign()/verify() strip-then-restore this key (see
    // _reserve_watch.mjs / _aiact_cron.mjs / renewal-watch-logic.mjs buildSignedCheckpoint for
    // the identical requirement).
    audit_signature: {},
  };
  const signed = await sign(receiptDoc, { verificationMethod, created: now, privateKey: keyPair.privateKey });

  return { artifact, receipt: signed, verificationMethod };
}
