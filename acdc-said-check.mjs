// acdc-said-check.mjs — VS-2 shared logic for the worker's acdc_said_check MCP tool.
//
// SAID-recompute engine below is VENDORED, byte-identical, from
// tools/553-vlei-acdc-said-structural-checker.html (T553, VS-1) — the BLAKE3-256 pure-JS
// implementation is itself verbatim from tools/525-iscc-content-code-generator.html (T525),
// per VS-1's own row. Reused unmodified per VS-2's row: do NOT vendor a library, do NOT write a
// second implementation. The agent-facing tool here and the browser tool at T553 MUST produce
// byte-identical findings for the same credential JSON.
//
// Structural check only — verifies a credential's internal self-addressing integrity, NOT the
// KERI chain of trust, issuer authority, or revocation state. See T553 for the full scope fence.
//
// No network egress — recompute is pure over the pasted/passed-in credential object.
import { executionHash } from './kernels/_hash.mjs';

/* ══════════════════════════════════════════════════════════════
   BLAKE3-256 (pure JS) — verbatim from tools/553 / T525.
══════════════════════════════════════════════════════════════ */
const BLAKE3 = (function () {
  const IV = new Uint32Array([0x6A09E667, 0xBB67AE85, 0x3C6EF372, 0xA54FF53A, 0x510E527F, 0x9B05688C, 0x1F83D9AB, 0x5BE0CD19]);
  const MSG = [
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    [2, 6, 3, 10, 7, 0, 4, 13, 1, 11, 12, 5, 9, 14, 15, 8],
    [3, 4, 10, 12, 13, 2, 7, 14, 6, 5, 9, 0, 11, 15, 8, 1],
    [10, 7, 12, 9, 14, 3, 13, 15, 4, 0, 11, 2, 5, 8, 1, 6],
    [12, 13, 9, 11, 15, 10, 14, 8, 7, 2, 5, 3, 0, 1, 6, 4],
    [9, 14, 11, 5, 8, 12, 15, 1, 13, 3, 0, 10, 2, 6, 4, 7],
    [11, 15, 5, 0, 1, 9, 8, 6, 14, 10, 2, 12, 3, 4, 7, 13],
  ];
  const CS = 1, CE = 2, PAR = 4, ROOT = 8;
  function rotr(x, n) { return (x >>> n) | (x << (32 - n)); }
  function g(s, a, b, c, d, mx, my) {
    s[a] = (s[a] + s[b] + mx) | 0; s[d] = rotr(s[d] ^ s[a], 16);
    s[c] = (s[c] + s[d]) | 0;      s[b] = rotr(s[b] ^ s[c], 12);
    s[a] = (s[a] + s[b] + my) | 0; s[d] = rotr(s[d] ^ s[a], 8);
    s[c] = (s[c] + s[d]) | 0;      s[b] = rotr(s[b] ^ s[c], 7);
  }
  function compress(cv, block, clo, chi, blen, flags) {
    const s = new Uint32Array(16);
    for (let i = 0; i < 8; i++) s[i] = cv[i];
    s[8] = IV[0]; s[9] = IV[1]; s[10] = IV[2]; s[11] = IV[3];
    s[12] = clo | 0; s[13] = chi | 0; s[14] = blen | 0; s[15] = flags | 0;
    for (let r = 0; r < 7; r++) {
      const m = MSG[r];
      g(s, 0, 4, 8, 12, block[m[0]], block[m[1]]); g(s, 1, 5, 9, 13, block[m[2]], block[m[3]]);
      g(s, 2, 6, 10, 14, block[m[4]], block[m[5]]); g(s, 3, 7, 11, 15, block[m[6]], block[m[7]]);
      g(s, 0, 5, 10, 15, block[m[8]], block[m[9]]); g(s, 1, 6, 11, 12, block[m[10]], block[m[11]]);
      g(s, 2, 7, 8, 13, block[m[12]], block[m[13]]); g(s, 3, 4, 9, 14, block[m[14]], block[m[15]]);
    }
    const out = new Uint32Array(16);
    for (let j = 0; j < 8; j++) { out[j] = s[j] ^ s[j + 8]; out[j + 8] = s[j + 8] ^ cv[j]; }
    return out;
  }
  function wordsFromBlock(bytes, off, len) {
    const w = new Uint32Array(16);
    for (let i = 0; i < len; i++) w[i >> 2] |= bytes[off + i] << ((i & 3) * 8);
    return w;
  }
  const CL = 1024, BL = 64;
  function chunkCV(input, off, len, clo, chi, flagsBase) {
    let cv = IV.slice(0, 8);
    const blocks = Math.ceil(len / BL) || 1;
    let pos = 0;
    for (let b = 0; b < blocks; b++) {
      const blen = Math.min(BL, len - pos);
      let flags = flagsBase;
      if (b === 0) flags |= CS;
      if (b === blocks - 1) flags |= CE;
      const out = compress(cv, wordsFromBlock(input, off + pos, blen), clo, chi, blen, flags);
      cv = out.slice(0, 8); pos += blen;
    }
    return cv;
  }
  function parentCV(left, right, flagsBase) {
    const block = new Uint32Array(16);
    for (let i = 0; i < 8; i++) { block[i] = left[i]; block[i + 8] = right[i]; }
    return compress(IV.slice(0, 8), block, 0, 0, BL, PAR | flagsBase).slice(0, 8);
  }
  function leftLen(n) {
    const fc = Math.floor((n - 1) / CL);
    let p = 1; while (p * 2 <= fc) p *= 2;
    return p * CL;
  }
  function cvForSubtree(input, off, len, chunkStart) {
    if (len <= CL) {
      return chunkCV(input, off, len, chunkStart >>> 0, Math.floor(chunkStart / 4294967296) >>> 0, 0);
    }
    const ll = leftLen(len);
    return parentCV(cvForSubtree(input, off, ll, chunkStart), cvForSubtree(input, off + ll, len - ll, chunkStart + (ll / CL)), 0);
  }
  function wordsToBytes32(words) {
    const out = new Uint8Array(32);
    for (let i = 0; i < 8; i++) {
      out[i * 4] = words[i] & 0xff; out[i * 4 + 1] = (words[i] >>> 8) & 0xff;
      out[i * 4 + 2] = (words[i] >>> 16) & 0xff; out[i * 4 + 3] = (words[i] >>> 24) & 0xff;
    }
    return out;
  }
  function rootBytesFromChunk(input, off, len, clo, chi) {
    let cv = IV.slice(0, 8);
    const blocks = Math.ceil(len / BL) || 1;
    let pos = 0;
    for (let b = 0; b < blocks; b++) {
      const blen = Math.min(BL, len - pos);
      let flags = 0;
      if (b === 0) flags |= CS;
      const isLast = (b === blocks - 1);
      if (isLast) flags |= CE | ROOT;
      const out = compress(cv, wordsFromBlock(input, off + pos, blen), clo, chi, blen, flags);
      if (isLast) return wordsToBytes32(out);
      cv = out.slice(0, 8); pos += blen;
    }
    return wordsToBytes32([0, 0, 0, 0, 0, 0, 0, 0]);
  }
  function digest(input) {
    const n = input.length;
    if (n <= CL) return rootBytesFromChunk(input, 0, n, 0, 0);
    const ll = leftLen(n);
    const left = cvForSubtree(input, 0, ll, 0);
    const right = cvForSubtree(input, ll, n - ll, ll / CL);
    const block = new Uint32Array(16);
    for (let i = 0; i < 8; i++) { block[i] = left[i]; block[i + 8] = right[i]; }
    return wordsToBytes32(compress(IV.slice(0, 8), block, 0, 0, BL, PAR | ROOT));
  }
  return { digest };
})();
function blake3_256(bytes) { return BLAKE3.digest(bytes); }
async function sha256Raw(bytes) {
  return new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
}

/* ══════════════════════════════════════════════════════════════
   KERI / CESR SAID recompute — verbatim from tools/553. NOT the
   RFC8785/JCS canon used for this tool's own receipt (that's
   kernels/_hash.mjs, imported above, used only in Step 4).
══════════════════════════════════════════════════════════════ */
const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
function bytesToB64Url(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i], b1 = bytes[i + 1], b2 = bytes[i + 2];
    const has1 = i + 1 < bytes.length, has2 = i + 2 < bytes.length;
    out += B64URL[b0 >> 2];
    out += B64URL[((b0 & 3) << 4) | (has1 ? b1 >> 4 : 0)];
    if (has1) out += B64URL[((b1 & 15) << 2) | (has2 ? b2 >> 6 : 0)];
    if (has2) out += B64URL[b2 & 63];
  }
  return out;
}
const SUPPORTED_CODES = { E: 'Blake3-256', I: 'SHA2-256' };
async function digestForCode(code, bytes) {
  if (code === 'E') return blake3_256(bytes);
  if (code === 'I') return sha256Raw(bytes);
  return null;
}
function codeDigestToQb64(code, raw32) {
  const padded = new Uint8Array(33);
  padded.set(raw32, 1);
  const b64 = bytesToB64Url(padded);
  return code + b64.slice(1);
}
function keriCompactJson(obj) {
  return JSON.stringify(obj);
}
async function recomputeSaidField(obj, field) {
  const declared = obj[field];
  if (typeof declared !== 'string' || declared.length < 1) {
    return { declared: declared ?? null, computed: null, ok: false, code: null, status: 'missing', detail: `Field "${field}" is missing or not a string.` };
  }
  const code = declared[0];
  if (!SUPPORTED_CODES[code]) {
    return { declared, computed: null, ok: null, code, status: 'unsupported', detail: `Derivation code "${code}" is not supported by this tool (only E = Blake3-256 and I = SHA2-256). Labeled honestly, not scored as pass or fail.` };
  }
  const placeholder = '#'.repeat(declared.length);
  const blanked = { ...obj, [field]: placeholder };
  const ser = new TextEncoder().encode(keriCompactJson(blanked));
  const raw = await digestForCode(code, ser);
  const computed = codeDigestToQb64(code, raw);
  return { declared, computed, ok: computed === declared, code, status: computed === declared ? 'match' : 'mismatch', detail: computed === declared ? `SAID recomputes correctly under ${SUPPORTED_CODES[code]} (code "${code}").` : `Recomputed SAID does not match the declared value under ${SUPPORTED_CODES[code]} (code "${code}") – the credential's "${field}" field or its contents have been altered since the SAID was set.` };
}

/* ══════════════════════════════════════════════════════════════
   Pinned official GLEIF vLEI schema SAID table — verbatim from
   tools/553. Source: github.com/GLEIF-IT/vLEI-schema (main
   branch), fetched 2026-07-18. Static, never fetched at runtime.
══════════════════════════════════════════════════════════════ */
const SCHEMA_TABLE = {
  'EBfdlu8R27Fbx-ehrqwImnK-8Cm79sqbAQ4MmvEAYqao': 'Qualified vLEI Issuer (QVI) Credential',
  'ENPXp1vQzRF6JwIuS-mp2U8Uf1MoADoP_GqQ62VsDZWY': 'Legal Entity (LE) vLEI Credential',
  'EEy9PkikFcANV1l7EHukCeXqrzT1hNZjGlUk7wuMO5jw': 'Legal Entity Engagement Context Role (ECR) Credential',
  'EH6ekLjSr8V32WyFbGe1zXjTzFs9PkTYmupJ9H65O14g': 'ECR Authorization Credential',
  'EBNaNu-M9P5cgrnfl2Fvymy4E_jvxxyjb70PRtiANlJy': 'Legal Entity Official Organizational Role (OOR) Credential',
  'EKA57bKBKxr_kN7iN5i7lMUxpMG-s19dRcmov1iDxz-E': 'OOR Authorization Credential',
};

/* ══════════════════════════════════════════════════════════════
   Check engine — same logic as T553's checkCredential(), headless
   (no DOM). Produces the same findings for the same credential.
══════════════════════════════════════════════════════════════ */
export async function runAcdcSaidCheck({ credential }) {
  if (!credential || typeof credential !== 'object' || Array.isArray(credential)) {
    return { isError: true, error: 'credential must be a JSON object (expected v/d/i/ri/s fields).' };
  }
  const cred = credential;
  const findings = [];

  const topResult = await recomputeSaidField(cred, 'd');
  findings.push({ id: 'top_said', title: 'Credential SAID (d)', result: topResult });

  for (const blockName of ['a', 'e', 'r']) {
    const block = cred[blockName];
    if (block && typeof block === 'object' && !Array.isArray(block) && typeof block.d === 'string') {
      const blockResult = await recomputeSaidField(block, 'd');
      findings.push({ id: `${blockName}_said`, title: `"${blockName}" block SAID (${blockName}.d)`, result: blockResult });
    }
  }

  const schemaSaid = cred.s;
  let schemaFinding;
  if (typeof schemaSaid !== 'string' || !schemaSaid) {
    schemaFinding = { id: 'schema_said', title: 'Schema SAID (s)', result: { status: 'missing', ok: false, detail: 'Field "s" (schema SAID) is missing or not a string.', declared: null, computed: null } };
  } else if (SCHEMA_TABLE[schemaSaid]) {
    schemaFinding = { id: 'schema_said', title: 'Schema SAID (s)', result: { status: 'known', ok: true, detail: `Matches pinned GLEIF schema: ${SCHEMA_TABLE[schemaSaid]}.`, declared: schemaSaid, computed: null } };
  } else {
    schemaFinding = { id: 'schema_said', title: 'Schema SAID (s)', result: { status: 'unknown', ok: null, detail: "Not in this tool's pinned table of 6 GLEIF vLEI schema SAIDs. May be a different schema version or a non-vLEI schema – not scored as a failure.", declared: schemaSaid, computed: null } };
  }
  findings.push(schemaFinding);

  const passCount = findings.filter((f) => f.result.ok === true).length;
  const failCount = findings.filter((f) => f.result.ok === false).length;
  const unsupportedCount = findings.filter((f) => f.result.ok === null).length;
  const overallValid = failCount === 0;

  const generated_at = new Date().toISOString();
  const policy_parameters = {
    tool_id: 'vlei-acdc-said-structural-checker',
    tool_version: '1.0.0',
    checked_said_count: findings.length,
    generated_at,
  };
  const output_payload = {
    overall_valid: overallValid,
    said_matches: passCount,
    said_mismatches: failCount,
    unsupported_or_unknown: unsupportedCount,
    findings: findings.map((f) => ({ id: f.id, title: f.title, status: f.result.status, ok: f.result.ok })),
    scope_note: 'Structural check only – verifies self-addressing integrity, not the KERI chain of trust, issuer authority, or revocation state.',
  };
  const execution_hash = await executionHash(policy_parameters, output_payload);
  const receipt = {
    '@context': 'https://ainumbers.co/chaingraph/context/v0.3/context.jsonld',
    tool_id: 'vlei-acdc-said-structural-checker',
    tool_version: '1.0.0',
    generated_at,
    policy_parameters,
    output_payload,
    execution_hash,
  };

  return {
    overall_valid: overallValid,
    said_matches: passCount,
    said_mismatches: failCount,
    unsupported_or_unknown: unsupportedCount,
    findings: findings.map((f) => ({ id: f.id, title: f.title, ...f.result })),
    edges: (cred.e && typeof cred.e === 'object') ? cred.e : null,
    receipt,
  };
}
