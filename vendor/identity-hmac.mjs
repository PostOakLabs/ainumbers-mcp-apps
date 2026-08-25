// freeze-class: exempt(Tim directive 2026-08-25 — wave 0-2 guardrail build); ships DEFAULT-OFF
//
// identity-hmac.mjs — SPEC-DR-06 §2.1–2.3 signed cross-repo identity headers.
// Zero-dependency beyond runtime WebCrypto (globalThis.crypto) — no imports at all.
//
// Header set (§2.1):
//   X-AIN-Origin-Repo     repo label ('mcp-apps-poc' | 'anchor-suite' | 'helm' | 'ainumbers-site')
//   X-AIN-Client-IP-Hash  sha256(clientIp + '|' + dailySalt), first 16 bytes, hex (32 chars)
//   X-AIN-Timestamp       unix seconds at signing
//   X-AIN-Signature       hex HMAC-SHA256 over `repo|ipHash|timestamp`, keyed by the shared secret
//
// Receiver order (§2.2): verify-then-key — signature checked BEFORE anything else;
// timestamp skew window 60s; fully-absent headers take the identity:none degradation path;
// partially-present headers are refused fail-closed (v1 decision, stricter than spec minimum).
//
// Dual-key acceptance: callers pass secrets NEWEST-FIRST; every candidate is compared
// constant-time and all candidates are iterated before a reject is decided (rotation window).
//
// Salt-absent sender behavior (08-24 amendment): refuse to sign unsigned, log the refusal
// locally (module-level refusals ring buffer), surface code SALT-ABSENT to the calling lane.

const enc = new TextEncoder();

function hex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Constant-time equality for equal-length hex strings; unequal lengths compare in
// string-length time only (length is not secret) and still return false.
export function constantTimeHexEqual(a, b) {
  const ta = typeof a === 'string' ? a : '';
  const tb = typeof b === 'string' ? b : '';
  if (ta.length !== tb.length) return false;
  let diff = 0;
  for (let i = 0; i < ta.length; i++) diff |= ta.charCodeAt(i) ^ tb.charCodeAt(i);
  return diff === 0;
}

async function hmacHex(keyStr, msgStr) {
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(keyStr), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(msgStr));
  return hex(sig);
}

// SHA-256(truncate(clientIp + '|' + salt)) → first 16 bytes as hex (32 chars).
export async function computeIpHash(clientIp, salt) {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(`${clientIp}|${salt}`));
  return hex(digest.slice(0, 16));
}

// Local refusal ring (last 64) — test/inspection surface for the fail-closed signer.
export const refusals = [];

const HEADER_ORDER = ['X-AIN-Origin-Repo', 'X-AIN-Client-IP-Hash', 'X-AIN-Timestamp', 'X-AIN-Signature'];

/**
 * Sender side. Returns { ok:true, headers… } on success or { ok:false, code:'SALT-ABSENT',
 * loggedAt } when the daily-salt lookup came back empty — never an unsigned fallback.
 */
export async function signIdentity({ repo, clientIp, timestampSec, secret }) {
  const ts = Math.floor(Number(timestampSec));
  if (!repo || !clientIp || !Number.isFinite(ts)) {
    throw new Error('signIdentity: repo, clientIp and integer timestampSec are required');
  }
  if (!secret || typeof secret !== 'string') {
    // Salt-absent / secret-absent: FAIL CLOSED per DR-06 §2.1 amendment (2026-08-24).
    // Never fall back to header-less transmission from the sender side.
    const entry = { loggedAt: Date.now(), ts, repo, code: 'SALT-ABSENT' };
    refusals.push(entry);
    while (refusals.length > 64) refusals.shift();
    console.error(JSON.stringify({ lvl: 'warn', evt: 'identity-sign-refused', ...entry }));
    return { ok: false, code: 'SALT-ABSENT', loggedAt: entry.loggedAt };
  }
  const ipHash = await computeIpHash(clientIp, secret);
  const signature = await hmacHex(secret, `${repo}|${ipHash}|${ts}`);
  return {
    ok: true,
    repo,
    ipHash,
    timestamp: ts,
    signature,
    headers: {
      'X-AIN-Origin-Repo': repo,
      'X-AIN-Client-IP-Hash': ipHash,
      'X-AIN-Timestamp': String(ts),
      'X-AIN-Signature': signature,
    },
  };
}

/**
 * Receiver side (§2.2). `secrets` is newest-first: [{ value, label }]. Every candidate is
 * HMAC-compared constant-time and ALL candidates are iterated before rejection is decided.
 * Fully-absent headers ⇒ { ok:true, identity:'none' } (un-migrated caller degradation);
 * partially-present headers ⇒ 400 BAD-IDENTITY-HEADERS (fail-closed v1 choice).
 */
export async function verifyIdentity(headers, { secrets, nowSec, maxSkewSec = 60 } = {}) {
  const h = headers || {};
  const present = HEADER_ORDER.map((k) => [k, h[k]]);
  const anyPresent = present.some(([, v]) => v !== undefined && v !== null && v !== '');
  if (!anyPresent) return { ok: true, identity: 'none' };

  const missing = present.filter(([, v]) => v === undefined || v === null || v === '').map(([k]) => k);
  if (missing.length > 0) {
    return { ok: false, status: 400, code: 'BAD-IDENTITY-HEADERS', missing, identity: 'refused' };
  }

  const repo = String(h['X-AIN-Origin-Repo']);
  const ipHash = String(h['X-AIN-Client-IP-Hash']);
  const tsStr = String(h['X-AIN-Timestamp']);
  const sig = String(h['X-AIN-Signature']);

  // §2.2 step 1 — verify-then-key: signature before anything else.
  let matchedKeyLabel = null;
  const candidateList = Array.isArray(secrets) ? secrets : [];
  for (const cand of candidateList) {
    const expected = await hmacHex(cand.value, `${repo}|${ipHash}|${tsStr}`);
    if (constantTimeHexEqual(sig, expected)) { matchedKeyLabel = cand.label || 'unlabeled'; }
    // NOTE: no early break — every candidate is exercised before deciding rejection.
  }
  if (!matchedKeyLabel) {
    return { ok: false, status: 401, code: 'BAD-SIGNATURE', identity: 'refused' };
  }

  // §2.2 step 2 — clock skew window (specific code so diagnosis is fast).
  const ts = Number(tsStr);
  const now = Number.isFinite(nowSec) ? nowSec : Math.floor(Date.now() / 1000);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > maxSkewSec) {
    return { ok: false, status: 401, code: 'CLOCK-SKEW', identity: 'refused', ageSec: now - ts };
  }

  return { ok: true, identity: 'verified', matchedKeyLabel, repo, ipHash, timestamp: ts };
}
