// _scitt.mjs — §P7.a: OCG anchor merkle-inclusion proofs (SPEC.md §20.1) -> COSE Receipt (RFC 9942)
// CBOR encoding profile, plus the SCRAPI /.well-known/scitt-keys discovery shape
// (PC-7-INTEROP-EXPORTS-SPEC.md §P7.a, INTEROP-1-BUILD-SPEC.md §I-4 rider, folded per PC-7A row).
//
// DRAFT-PINNING (re-verified 2026-07-19 at dispatch, per the PC-7A row's MUST):
//   - SCITT architecture:            RFC 9943 (Proposed Standard, Jun 2026) — was draft-ietf-scitt-architecture.
//   - COSE Receipts (Merkle proofs): RFC 9942 (Proposed Standard, Jun 2026) — was draft-ietf-cose-merkle-tree-proofs;
//                                    the -18 draft this row's original scan cited has SINCE been published as
//                                    an RFC, so this module targets RFC 9942 directly, not a draft version string.
//   - SCRAPI (discovery + REST API): draft-ietf-scitt-scrapi-11 (26 Jun 2026 — moved from -10 since the scan;
//                                    IESG-approved, RFC Ed Queue, not yet an RFC as of this build).
// A later RFC number for SCRAPI is a one-constant diff (SCRAPI_DRAFT below).
//
// This is an ENCODING layer, not new proof math: the Merkle inclusion primitives (leafHash/
// rootFromInclusion) and the CBOR codec are REUSED VERBATIM from kernels/_anchor-testutil.mjs — the
// SAME primitives OCG SPEC.md §20.1 names as canonical ("no second Merkle implementation"). The only
// new logic here is the RFC 9942 §5.2.1 COSE_Sign1 receipt SHAPE (protected/unprotected header
// labels) and the RFC 9052 §4.4 Sig_structure signing input — both mandated by the target RFCs.
//
// Signing is OPTIONAL and holder-chosen (same doctrine as kernels/_proof.mjs sign()): this module
// signs with a caller-supplied Ed25519 keypair, never a worker-held secret. OCG runs no persistent
// SCITT Transparency Service identity (SPEC.md §20: "OCG implementations are NOT SCITT Transparency
// Services and SCRAPI is out of scope") — so scittKeySet() with no keys returns a schema-valid,
// honestly EMPTY COSE_KeySet rather than fabricating a signing identity.
//
// No full SCITT/COSE library is imported anywhere in this file — CBOR + Merkle math come from the
// existing anchor lineage; everything else is plain arithmetic over that primitive set.

import {
  cborEncode, cborDecode, CborTag,
  leafHash, rootFromInclusion,
  ed25519Sign, ed25519Verify, rawToPublicKey,
} from './kernels/_anchor-testutil.mjs';

export const SCITT_ARCHITECTURE_RFC = 'RFC 9943';
export const COSE_RECEIPTS_RFC = 'RFC 9942';
export const SCRAPI_DRAFT = 'draft-ietf-scitt-scrapi-11';

const ALG_EDDSA = -8;            // IANA COSE Algorithms registry — EdDSA
const VDS_RFC9162_SHA256 = 1;    // IANA COSE Verifiable Data Structures registry (RFC 9942 §3)
const LABEL_ALG = 1;             // COSE header label "alg" (protected)
const LABEL_VDS = 395;           // "verifiable-data-structure" (protected) — RFC 9942 §2
const LABEL_VDP = 396;           // "verifiable-data-proofs" (unprotected) — RFC 9942 §2
const PROOF_TYPE_INCLUSION = -1; // inclusion-proof entry within verifiable-data-proofs — RFC 9942 §4.1

const stripPrefix = (hex) => String(hex).replace(/^sha256:/, '');
const hexToBuf = (hex) => Buffer.from(stripPrefix(hex), 'hex');

/**
 * merkleInclusionToCoseReceipt(mi, { rootHex, privateKey }) -> Buffer (COSE_Sign1, CBOR tag 18).
 *
 * mi: an OCG SPEC.md §20.1 merkle_inclusion member — { leaf, index, path, tree_size, algorithm:"rfc6962" }.
 * rootHex: the anchor binding's anchored_hash (the Merkle ROOT) — sha256 hex, "sha256:" prefix optional.
 * privateKey: caller-held Ed25519 node:crypto KeyObject. OPTIONAL — omit for an UNSIGNED receipt
 *   (zero-length signature, useful for structural fixtures); a verifier MUST reject a zero-length sig.
 *
 * Returns the RFC 9942 §5.2.1 COSE_Sign1 shape with a DETACHED payload — the signed payload is the
 * Merkle root carried out-of-band (RFC 9942 §4.4), never inlined in the CBOR.
 */
export function merkleInclusionToCoseReceipt(mi, { rootHex, privateKey } = {}) {
  if (!mi || mi.algorithm !== 'rfc6962') throw new Error('merkleInclusionToCoseReceipt requires an rfc6962 merkle_inclusion member');
  if (!Number.isInteger(mi.index) || mi.index < 0) throw new Error('merkle_inclusion.index must be a non-negative integer');
  if (!Number.isInteger(mi.tree_size) || mi.tree_size <= 0) throw new Error('merkle_inclusion.tree_size must be a positive integer');
  if (!Array.isArray(mi.path)) throw new Error('merkle_inclusion.path must be an array');
  if (!rootHex) throw new Error('rootHex (the anchor binding anchored_hash) is required');

  const pathBytes = mi.path.map(hexToBuf);
  const rootBytes = hexToBuf(rootHex);

  const protectedBytes = cborEncode(new Map([[LABEL_ALG, ALG_EDDSA], [LABEL_VDS, VDS_RFC9162_SHA256]]));
  const inclusionProof = cborEncode([mi.tree_size, mi.index, pathBytes]);
  const unprotectedMap = new Map([[LABEL_VDP, new Map([[PROOF_TYPE_INCLUSION, [inclusionProof]]])]]);

  const sigStructure = cborEncode(['Signature1', protectedBytes, Buffer.alloc(0), rootBytes]);
  const signature = privateKey ? ed25519Sign(sigStructure, privateKey) : Buffer.alloc(0);

  return cborEncode(new CborTag(18, [protectedBytes, unprotectedMap, null, signature]));
}

/**
 * coseReceiptToMerkleInclusion(receiptBytes) -> { alg, vds, tree_size, index, path (hex[]), signature, protectedBytes }
 * Structural decode only — the inverse mapping, for round-trip testing and for consuming a
 * third-party RFC 9942 receipt. Throws on any shape mismatch (never silently coerces).
 */
export function coseReceiptToMerkleInclusion(receiptBytes) {
  const tagged = cborDecode(Buffer.isBuffer(receiptBytes) ? receiptBytes : Buffer.from(receiptBytes));
  if (!(tagged instanceof CborTag) || tagged.tag !== 18) throw new Error('not a COSE_Sign1 (CBOR tag 18)');
  const [protectedBytes, unprotectedMap, payload, signature] = tagged.value;
  if (payload !== null) throw new Error('receipt payload must be detached (null) per RFC 9942 §4.4');
  const protectedMap = cborDecode(protectedBytes);
  const alg = protectedMap.get(LABEL_ALG);
  const vds = protectedMap.get(LABEL_VDS);
  if (vds !== VDS_RFC9162_SHA256) throw new Error('unsupported verifiable-data-structure (only RFC9162_SHA256 (1) is implemented)');
  const proofs = unprotectedMap instanceof Map ? unprotectedMap.get(LABEL_VDP) : undefined;
  const inclusionEntries = proofs instanceof Map ? proofs.get(PROOF_TYPE_INCLUSION) : undefined;
  if (!inclusionEntries || !inclusionEntries.length) throw new Error('receipt carries no inclusion proof');
  const [tree_size, index, path] = cborDecode(inclusionEntries[0]);
  return { alg, vds, tree_size, index, path: path.map((b) => b.toString('hex')), signature, protectedBytes };
}

/**
 * verifyCoseReceipt(receiptBytes, { leafHex, rootHex, rawPublicKey }) -> boolean.
 * Recomputes the Merkle root from the receipt's OWN inclusion proof via rootFromInclusion — the SAME
 * primitive SPEC.md §20.1's verifier uses (no second Merkle implementation) — and, when rawPublicKey
 * is supplied, verifies the Ed25519 signature over the RFC 9052 Sig_structure with the detached root
 * as payload. Returns false on any structural/crypto problem rather than throwing (same predicate
 * shape as kernels/_proof.mjs verify()).
 */
export function verifyCoseReceipt(receiptBytes, { leafHex, rootHex, rawPublicKey } = {}) {
  try {
    const { tree_size, index, path, signature, protectedBytes } = coseReceiptToMerkleInclusion(receiptBytes);
    const L = leafHash(hexToBuf(leafHex));
    const root = rootFromInclusion(L, index, tree_size, path.map(hexToBuf));
    if (!root || root.toString('hex') !== stripPrefix(rootHex)) return false;
    if (!rawPublicKey) return true; // structural + Merkle math verified; no key supplied to check the signature
    if (!signature || signature.length === 0) return false;
    const sigStructure = cborEncode(['Signature1', protectedBytes, Buffer.alloc(0), hexToBuf(rootHex)]);
    return ed25519Verify(sigStructure, signature, rawToPublicKey(rawPublicKey));
  } catch { return false; }
}

/**
 * scittKeySet(rawPublicKeys = []) -> Buffer, a CBOR COSE_KeySet (RFC 9052 §7 — array of COSE_Key
 * maps): the /.well-known/scitt-keys discovery response (SCRAPI draft-ietf-scitt-scrapi-11's
 * well-known-configuration family). rawPublicKeys: array of 32-byte raw Ed25519 public keys.
 * Called with [] (the default — OCG holds no persistent SCITT signing identity today) this returns a
 * schema-valid, honestly EMPTY key set rather than fabricating one; a future operator-held key is additive.
 */
export function scittKeySet(rawPublicKeys = []) {
  const coseKeys = rawPublicKeys.map((rawPub) => new Map([
    [1, 1],                    // kty: OKP
    [3, ALG_EDDSA],             // alg: EdDSA
    [-1, 6],                    // crv: Ed25519 (IANA COSE Elliptic Curves registry)
    [-2, Buffer.from(rawPub)],  // x: public key bytes
  ]));
  return cborEncode(coseKeys);
}
