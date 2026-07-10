// _reserve_watch.mjs — MONDAY-SHIP §RW: GENIUS Continuous Reserve Watch.
//
// Composes three already-shipped primitives on the live GAP-d weekly cron tick — mints nothing new:
//   1. art-275 kernel (check_genius_reserve_disclosure) — the linter, unmodified.
//   2. kernels/_proof.mjs eddsa-jcs-2022 sign() — the SAME ephemeral-did:key receipt signer GAP-a's
//      renewal-watch checkpoint uses (workflows/renewal-watch-logic.mjs buildSignedCheckpoint). This
//      is the "§20 anchor lineage" path the spec calls for — it is NOT a fresh RFC 3161/JAdES
//      timestamp token. Minting a fresh TSA timestamp from this worker is explicitly FLAGGED, same
//      as _blta.mjs's renewal path: no TSA-request integration exists here (zero-fetch, free-plan,
//      no KV/D1/R2 — see worker.mjs queue() comment), and inventing one would be a new crypto
//      primitive this band's "borrow-not-depend / no new primitives" rule guards against. A real
//      RFC 3161 timestamp over this receipt is anchor-suite's job (anchor.ainumbers.co), same as
//      every other §20 binding.
//   3. GAP-d's scheduled() weekly tick + EVENTS_QUEUE CloudEvents envelope — unmodified transport.
//
// Ingestion note (honest, matches the EXPLAIN-4 standard of not overclaiming): no live issuer
// reserve-report feed is wired — Circle/Tether/PayPal publish monthly disclosures as PDF/HTML, not
// a structured API, and this worker has no persistent artifact registry to hold a real feed's
// history (no KV/D1/R2 binding). Each weekly tick runs the SAME demo-fixture report below, which
// proves the full plumbing (kernel -> receipt -> anchor-lineage -> envelope) fires live ahead of a
// real issuer feed integration. Wiring an actual monthly-disclosure ingest source is a follow-on
// WU once an issuer/exchange partner is onboarded — this WU is the receipted monitoring substrate,
// not the ingest pipeline.

import { buildArtifact as buildReserveArtifact, meta as reserveMeta }
  from './kernels/art-275-genius-reserve-disclosure-checker.kernel.mjs';
import { sign, rawPubkeyToDidKey } from './kernels/_proof.mjs';

// Demo-fixture monthly reserve report — a clean PASS-shaped report (100%+ coverage, only permitted
// assets, certification + examiner present, custody disclosed). Exercises the full compute path;
// swap for a real extracted-field ingest once a feed exists (see header note).
export const SAMPLE_RESERVE_REPORT = Object.freeze({
  report_month: '2026-06',
  outstanding_tokens_reported: 1_000_000,
  token_price: 1.00,
  issuer_type: 'nonbank_federal',
  assets: [
    { type: 'us_coins_currency', usd: 50_000, custodian: 'Reserve Custodian Bank NA' },
    { type: 'demand_deposit', usd: 250_000, custodian: 'Reserve Custodian Bank NA' },
    { type: 'tbill', usd: 700_000, maturity: 45, custodian: 'Reserve Custodian Bank NA' },
  ],
  ceo_cfo_certification_present: true,
  registered_examiner_named: true,
  examiner_name: 'Sample Registered Public Accounting Firm LLP',
  onchain_supply_check: 1_000_000,
});

// Run one receipted reserve-watch check: build the art-275 artifact, then sign a small receipt
// document referencing its execution_hash (never re-signs the artifact itself — same pattern
// buildSignedCheckpoint uses for the artifact-ref field). Deterministic over (reportInput, nowMs)
// except for the ephemeral signing key, matching the checkpoint pattern's own non-determinism.
export async function runReserveWatchCheck(reportInput, nowMs) {
  const now = new Date(nowMs).toISOString();
  const artifact = await buildReserveArtifact(reportInput, { now });

  const keyPair = await globalThis.crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const verificationMethod = await rawPubkeyToDidKey(keyPair.publicKey);
  const receiptDoc = {
    reserve_watch_receipt: 'v1',
    tool_id: reserveMeta.tool_id,
    mcp_name: reserveMeta.mcp_name,
    report_month: reportInput.report_month ?? null,
    determination: artifact.output_payload.monthly_disclosure_determination,
    compliance_flags: artifact.compliance_flags,
    artifact_ref: artifact.execution_hash,
    checked_at: now,
    // Pre-declared before signing — sign()/verify() strip-then-restore this key (see
    // renewal-watch-logic.mjs buildSignedCheckpoint for the identical requirement).
    audit_signature: {},
  };
  const signed = await sign(receiptDoc, { verificationMethod, created: now, privateKey: keyPair.privateKey });

  return { artifact, receipt: signed, verificationMethod };
}
