// _mmr.mjs — MMR (Merkle Mountain Range) peaks-bag commitment for session receipts.
// DAG-INTEGRITY-BUILD-SPEC.md §3: additive sibling to buildSessionReceiptCore's existing
// binary-tree session_receipt_root (worker.mjs, hashPair) — that computation is UNTOUCHED.
// This module gives the SAME leaf set an append-only MMR commitment, so a later receipt's
// MMR can carry a consistency proof that it provably APPENDS to an earlier one
// (CT-style RFC 6962/9162 append-only guarantee, no log operator required — the "log" is
// just the caller's own ordered receipt history).
//
// Runs unchanged in Workers/Node/browser — globalThis.crypto.subtle only (see kernels/_hash.mjs).

const normalize = (h) => String(h).replace(/^sha256:/, '').toLowerCase();

const sha256Hex = async (str) => {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, '0')).join('');
};

// RFC 6962-style domain separation: leaves and internal nodes hash to disjoint spaces
// (0x00 / 0x01 prefix) so a leaf value can never be replayed as a forged internal node.
export const leafHash = async (h) => 'sha256:' + (await sha256Hex('00' + normalize(h)));
export const nodeHash = async (l, r) => 'sha256:' + (await sha256Hex('01' + normalize(l) + normalize(r)));

// Standard append-only MMR: maintain a stack of (peak, height); each new leaf may
// trigger a cascade of merges whenever the top two peaks share a height.
export async function buildMmr(execution_hashes) {
  const peaks = []; // [{ hash, height }], left-to-right, ascending height
  for (const raw of execution_hashes) {
    let peak = { hash: await leafHash(raw), height: 0 };
    while (peaks.length > 0 && peaks[peaks.length - 1].height === peak.height) {
      const left = peaks.pop();
      peak = { hash: await nodeHash(left.hash, peak.hash), height: left.height + 1 };
    }
    peaks.push(peak);
  }
  return { peaks: peaks.map((p) => p.hash), size: execution_hashes.length };
}

// Bag the peaks into one value — right-to-left fold (Grin/Neptune convention).
export async function bagPeaks(peaks) {
  if (peaks.length === 0) return null;
  let acc = peaks[peaks.length - 1];
  for (let i = peaks.length - 2; i >= 0; i--) acc = await nodeHash(peaks[i], acc);
  return acc;
}

// Bind mmr_size into the final root so two different sizes can never collide on the
// same bagged-peaks value (e.g. a single-leaf MMR vs. a larger one whose peaks happen
// to bag to the same hash by construction coincidence).
export async function mmrBaggedRoot(peaks, size) {
  const bagged = await bagPeaks(peaks);
  if (bagged === null) return null;
  return 'sha256:' + (await sha256Hex(size.toString(16) + normalize(bagged)));
}

export async function buildMmrCommitment(execution_hashes) {
  const { peaks, size } = await buildMmr(execution_hashes);
  const mmr_bagged_root = await mmrBaggedRoot(peaks, size);
  return { mmr_peaks: peaks, mmr_size: size, mmr_bagged_root };
}

// Consistency proof: recompute the MMR over the FIRST prior_mmr_size leaves of the new
// (longer) leaf set and check it reproduces the prior receipt's peaks/bagged root
// byte-for-byte. If it does, the new session's leaf history provably appends to the
// old one (same leaves, same order, up to prior_mmr_size) — the CT append-only guarantee.
export async function verifyConsistency({ prior_mmr_peaks, prior_mmr_size, prior_mmr_bagged_root, new_execution_hashes }) {
  if (!Array.isArray(prior_mmr_peaks) || !Number.isInteger(prior_mmr_size) || prior_mmr_size < 1) {
    return { verified: false, reason: 'prior_receipt must supply mmr_peaks (array) and mmr_size (positive integer).' };
  }
  if (!Array.isArray(new_execution_hashes) || new_execution_hashes.length < prior_mmr_size) {
    return { verified: false, reason: 'new leaf set is shorter than prior_mmr_size — cannot be an append of the prior receipt.' };
  }
  const prefix = new_execution_hashes.slice(0, prior_mmr_size);
  const recomputed = await buildMmrCommitment(prefix);
  const peaksMatch = JSON.stringify(recomputed.mmr_peaks) === JSON.stringify(prior_mmr_peaks);
  const rootMatch = prior_mmr_bagged_root == null || recomputed.mmr_bagged_root === prior_mmr_bagged_root;
  const verified = peaksMatch && rootMatch;
  return {
    verified,
    reason: verified ? null : (!peaksMatch ? 'recomputed prior peaks do not match — the prior leaf set was altered.' : 'recomputed bagged root does not match prior_mmr_bagged_root.'),
    recomputed_prior_peaks: recomputed.mmr_peaks,
    recomputed_prior_bagged_root: recomputed.mmr_bagged_root,
  };
}
