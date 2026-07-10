// _blta.mjs — JAdES/RFC 3161 archive-timestamp RENEWAL: due-check + append/verify mechanics
// (EXPORT-1 §E1.c — the non-OSCAL half of RESEARCH-GAP-ANALYSIS gap (h)).
//
// ~90% of the crypto already shipped: §20 anchor_bindings + JAdES B-T are live per the anchor
// program (anchor.ainumbers.co). This module adds the RENEWAL TIMER (due-check) and the archive-
// timestamp APPEND mechanics — not a new signing primitive. It reuses the SAME verifier the §20
// gate uses (kernels/_rfc3161.mjs verifyRfc3161) so there is no second RFC 3161 implementation.
//
// SCOPE / FLAG (2026-07-10): this worker has (a) no persistent artifact registry — no KV/D1/R2
// binding in wrangler.jsonc, only EVENTS_QUEUE — and (b) no existing TSA-REQUEST integration;
// kernels/_rfc3161.mjs is VERIFY-ONLY. Per §E1.c/riders ("reuse the shipped anchor code path; add
// no new TSA integration unless an existing one is unavailable — then FLAG"): obtaining a FRESH
// timestamp token by contacting a TSA is FLAGGED here, not built — no in-fence code exists to reuse
// and inventing a new TSA client would be a new crypto primitive the spec explicitly guards against.
// What ships in-fence, both pure and offline-testable:
//   1. dueForRenewal()          — is an existing binding's timestamp approaching its safety horizon?
//   2. appendArchiveTimestamp() — structurally append an ALREADY-OBTAINED fresh binding.
//   3. verifyAllBindings()      — re-verify every binding on an artifact independently (proves an
//                                  append never disturbs prior entries).
// worker.mjs queue() wires (1)+(3) to the live GAP-d CloudEvents transport (§E1.c "bind to the
// envelope, not the transport"). The natural owner of the flagged step is anchor-suite (it already
// talks to FreeTSA for Anchorproof/§20) — a future WU, not this one.

import { verifyRfc3161, FREETSA_ROOT_PEM } from './kernels/_rfc3161.mjs';

// genTime is RFC 3161 TSTInfo GeneralizedTime Zulu: YYYYMMDDHHMMSSZ (optionally fractional seconds).
function genTimeToMs(genTime) {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\.\d+)?Z$/.exec(String(genTime));
  if (!m) throw new Error('genTime is not RFC 3161 GeneralizedTime Zulu (YYYYMMDDHHMMSSZ)');
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
}

// Renewal horizon: a documented policy assumption, NOT an ETSI/ISO-mandated number (ETSI EN 319 122
// JAdES leaves renewal cadence to the signing policy). 5 years is conservative relative to the
// pinned FreeTSA root's validity (issued 2016, expires 2041 — see kernels/_rfc3161.mjs
// FREETSA_ROOT_PEM) and its intermediate's observed ~14y window, so a renewal miss never lets a
// token cross a root rollover unrenewed. Callers MAY override via horizonMs.
export const DEFAULT_RENEWAL_HORIZON_MS = 5 * 365.25 * 24 * 60 * 60 * 1000;

/**
 * dueForRenewal(binding, { nowMs, horizonMs }) -> boolean.
 * binding: a §20 rfc3161-tst anchor_binding ({ type, gen_time, ... }).
 * nowMs: caller-supplied wall-clock (worker.mjs supplies controller.scheduledTime) — never sampled
 *        inside this module, so the due-check itself stays a pure function of its inputs.
 */
export function dueForRenewal(binding, { nowMs, horizonMs = DEFAULT_RENEWAL_HORIZON_MS } = {}) {
  if (!binding || binding.type !== 'rfc3161-tst' || typeof binding.gen_time !== 'string') {
    throw new Error('dueForRenewal requires an rfc3161-tst binding with a gen_time member');
  }
  if (typeof nowMs !== 'number' || !Number.isFinite(nowMs)) {
    throw new Error('dueForRenewal requires a caller-supplied nowMs (no Date.now() inside this module)');
  }
  return (nowMs - genTimeToMs(binding.gen_time)) >= horizonMs;
}

/**
 * appendArchiveTimestamp(artifact, freshBinding) -> new artifact with freshBinding appended to
 * anchor_bindings. Purely structural/additive — matches the schema's existing array shape
 * (openchain-graph-v0.4.schema.json §20 anchor_bindings), never mutates prior entries, never
 * touches execution_hash (anchor_bindings stays hash-EXCLUDED per §20, attached AFTER hashing).
 * freshBinding MUST already be a complete, independently-verifiable rfc3161-tst binding — obtaining
 * one is the flagged, out-of-fence step (see module header).
 */
export function appendArchiveTimestamp(artifact, freshBinding) {
  if (!artifact || typeof artifact !== 'object') throw new Error('appendArchiveTimestamp requires an artifact object');
  if (!freshBinding || freshBinding.type !== 'rfc3161-tst') throw new Error('freshBinding must be a §20 rfc3161-tst binding');
  const prior = Array.isArray(artifact.anchor_bindings)
    ? artifact.anchor_bindings
    : (artifact.anchor_bindings ? [artifact.anchor_bindings] : []);
  return { ...artifact, anchor_bindings: [...prior, freshBinding] };
}

/**
 * verifyAllBindings(artifact, { rootPem }) -> Array<{ type, verified: boolean|null, reason? }>.
 * Re-verifies EVERY rfc3161-tst binding independently via the SAME predicate the §20 gate uses.
 * Non-rfc3161-tst binding types are reported verified:null (out of scope for this verifier).
 */
export function verifyAllBindings(artifact, { rootPem = FREETSA_ROOT_PEM } = {}) {
  const bindings = Array.isArray(artifact?.anchor_bindings)
    ? artifact.anchor_bindings
    : (artifact?.anchor_bindings ? [artifact.anchor_bindings] : []);
  return bindings.map((b) => {
    if (b?.type !== 'rfc3161-tst') return { type: b?.type ?? null, verified: null, reason: 'not rfc3161-tst, out of scope for this verifier' };
    try {
      const expectHashHex = String(b.anchored_hash).replace(/^sha256:/, '');
      verifyRfc3161(b, { rootPem, expectHashHex });
      return { type: 'rfc3161-tst', verified: true };
    } catch (e) {
      return { type: 'rfc3161-tst', verified: false, reason: String(e?.message ?? e) };
    }
  });
}
