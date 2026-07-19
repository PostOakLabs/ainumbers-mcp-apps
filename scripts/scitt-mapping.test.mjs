// scitt-mapping.test.mjs — §P7.a: OCG §20.1 merkle_inclusion -> RFC 9942 COSE Receipt round-trip
// (PC-7-INTEROP-EXPORTS-SPEC.md §P7.a "vendor scitt-api-emulator test vectors as a §15 round-trip gate").
//
// scitt-api-emulator (scitt-community, Apache-2.0) was checked for recency per the row's own MUST —
// it was archived 2024-11-22, predating RFC 9942/RFC 9943's finalization (Jun 2026) by over a year,
// and its bundled fixtures target the pre-RFC draft wire format. Vendoring stale vectors would assert
// a round-trip against a shape the finalized RFC no longer specifies, so per STANDING ORDERS #14(b)
// ("names a library? -> STOP, grep/verify first") this substitutes a round-trip against RFC 9942 §5.2.1
// itself: the RFC's own EDN example (Figure 6) is illustrative only (hex values elided with "..." in
// the published text — confirmed by direct fetch, no full-byte vector exists to vendor either), so the
// gate is (a) a real Ed25519 sign/verify/tamper round-trip through _scitt.mjs + the shared anchor-lineage
// Merkle math, and (b) a structural check that every emitted CBOR label matches RFC 9942 §5.2.1's
// documented shape (protected {1,395}, unprotected {396:{-1:[...]}}, detached payload, tag 18).
import { generateKeyPairSync } from 'node:crypto';
import { mth, auditPath, leafHash, publicKeyToRaw } from '../kernels/_anchor-testutil.mjs';
import { merkleInclusionToCoseReceipt, coseReceiptToMerkleInclusion, verifyCoseReceipt, scittKeySet, COSE_RECEIPTS_RFC, SCITT_ARCHITECTURE_RFC } from '../_scitt.mjs';

let fail = 0;
const ok = (c, m) => { if (!c) { fail++; console.error('  ✗ ' + m); } else console.log('  ✓ ' + m); };

console.log('§P7.a RFC 9942 COSE Receipt mapping (' + SCITT_ARCHITECTURE_RFC + ' / ' + COSE_RECEIPTS_RFC + ')\n');

// ── fixture: a 6-leaf RFC 6962 tree, leaf index 3 = our artifact's execution_hash ──────────────────
const execHashes = Array.from({ length: 6 }, (_, i) => Buffer.alloc(32, i + 1));
const leafHashes = execHashes.map(leafHash);
const root = mth(leafHashes);
const LEAF_INDEX = 3;
const path = auditPath(LEAF_INDEX, leafHashes);
const mi = {
  leaf: execHashes[LEAF_INDEX].toString('hex'),
  index: LEAF_INDEX,
  path: path.map((h) => h.toString('hex')),
  tree_size: 6,
  algorithm: 'rfc6962',
};
const rootHex = root.toString('hex');

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const rawPublicKey = publicKeyToRaw(publicKey);

// ── happy path: sign, decode, verify ────────────────────────────────────────────────────────────
{
  const receipt = merkleInclusionToCoseReceipt(mi, { rootHex, privateKey });
  ok(Buffer.isBuffer(receipt) && receipt.length > 0, 'emits a non-empty CBOR buffer');
  ok(receipt[0] === 0xd2, 'CBOR tag 18 (COSE_Sign1) header byte present (major 6, tag 18 < 24 -> single byte 0xd2)');

  const decoded = coseReceiptToMerkleInclusion(receipt);
  ok(decoded.alg === -8, 'protected header alg == EdDSA (-8)');
  ok(decoded.vds === 1, 'protected header vds == RFC9162_SHA256 (1)');
  ok(decoded.tree_size === mi.tree_size, 'decoded tree_size round-trips');
  ok(decoded.index === mi.index, 'decoded index round-trips');
  ok(JSON.stringify(decoded.path) === JSON.stringify(mi.path), 'decoded inclusion path round-trips byte-identical');
  ok(decoded.signature.length === 64, 'Ed25519 signature is 64 bytes');

  ok(verifyCoseReceipt(receipt, { leafHex: mi.leaf, rootHex, rawPublicKey }) === true, 'verifies: Merkle root reconstructs + signature checks');
  ok(verifyCoseReceipt(receipt, { leafHex: mi.leaf, rootHex }) === true, 'verifies structurally with no key supplied (Merkle math only)');
}

// ── tamper: wrong leaf -> root does not reconstruct ─────────────────────────────────────────────
{
  const receipt = merkleInclusionToCoseReceipt(mi, { rootHex, privateKey });
  const wrongLeaf = execHashes[LEAF_INDEX + 1].toString('hex');
  ok(verifyCoseReceipt(receipt, { leafHex: wrongLeaf, rootHex, rawPublicKey }) === false, 'wrong leaf -> verification FAILS');
}

// ── tamper: mutated path entry -> root does not reconstruct ────────────────────────────────────
{
  const tamperedMi = { ...mi, path: [Buffer.alloc(32, 0xff).toString('hex'), ...mi.path.slice(1)] };
  const receipt = merkleInclusionToCoseReceipt(tamperedMi, { rootHex, privateKey });
  ok(verifyCoseReceipt(receipt, { leafHex: mi.leaf, rootHex, rawPublicKey }) === false, 'tampered path -> verification FAILS');
}

// ── tamper: signature stripped (unsigned receipt) -> signature check FAILS when a key is supplied ──
{
  const unsigned = merkleInclusionToCoseReceipt(mi, { rootHex });
  ok(verifyCoseReceipt(unsigned, { leafHex: mi.leaf, rootHex }) === true, 'unsigned receipt still verifies structurally with no key supplied');
  ok(verifyCoseReceipt(unsigned, { leafHex: mi.leaf, rootHex, rawPublicKey }) === false, 'unsigned receipt FAILS when a key is supplied to check against');
}

// ── wrong signer -> signature check FAILS even though the Merkle math is untouched ─────────────────
{
  const receipt = merkleInclusionToCoseReceipt(mi, { rootHex, privateKey });
  const other = generateKeyPairSync('ed25519');
  const otherRawPub = publicKeyToRaw(other.publicKey);
  ok(verifyCoseReceipt(receipt, { leafHex: mi.leaf, rootHex, rawPublicKey: otherRawPub }) === false, 'wrong signer public key -> verification FAILS');
}

// ── /.well-known/scitt-keys shape ───────────────────────────────────────────────────────────────
{
  const empty = scittKeySet([]);
  ok(Buffer.isBuffer(empty) && empty[0] === 0x80, 'empty key set encodes as CBOR array(0) — honest, no fabricated identity');

  const withKey = scittKeySet([rawPublicKey]);
  ok(withKey[0] === 0x81, 'one-key set encodes as CBOR array(1)');
  ok(withKey.toString('hex') === '81a40101032720062158' + '20' + rawPublicKey.toString('hex'),
    'one-key COSE_Key byte shape matches the worker.mjs /.well-known/scitt-keys local encoder exactly (drift guard between the two independent encoders)');

  // worker.mjs deliberately reimplements this encoder locally (to avoid pulling node:crypto's
  // Ed25519 sign/verify into the live fetch path — see the route's own comment) — the empty-set
  // byte MUST match exactly since that is what the live route actually serves today.
  ok(empty.toString('hex') === '80', 'empty-set byte matches worker.mjs /.well-known/scitt-keys exactly (0x80)');
}

console.log(fail === 0 ? '\nAll checks passed.' : `\n${fail} check(s) FAILED.`);
process.exit(fail === 0 ? 0 : 1);
