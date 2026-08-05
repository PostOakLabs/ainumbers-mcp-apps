// exporters/_meta.mjs — shared helpers for every chaingraph_export profile.
// Metadata-block extraction, filename derivation, and Workers-safe STANDARD
// base64 (NOT url-safe — url-safe base64 triggers known MCP-client decode bugs
// on larger binaries; OCG Standard §13.4).

const VERIFY_BASE = 'https://ainumbers.co/chaingraph/verify';

// CONTRACT.md Amendment A9 (CB10-RELIANCE-POSTURE-1) — reliance hedge that travels with every
// §13 export rather than living only on a page. Static text, identical on every export.
export const RELIANCE_NOTICE =
  'Not legal, investment, tax, or compliance advice. A computed view of the cited authority as of ' +
  'generated_at, not a substitute for review by a qualified advisor against the current official source text.';

/** The metadata block every export embeds (OCG §13.2 rule 2). */
export function metaBlock(artifact = {}) {
  const keyid = artifact?.audit_signature?.signatures?.[0]?.keyid ?? null;
  const hash = artifact?.execution_hash ?? null;
  return {
    tool_id: artifact?.tool_id ?? null,
    execution_hash: hash,
    chaingraph_version: artifact?.chaingraph_version ?? null,
    compute_mode: artifact?.compute_mode ?? null,
    mandate_type: artifact?.mandate_type ?? null,
    keyid,
    verify_url: hash ? `${VERIFY_BASE}?hash=${String(hash).replace(/^sha256:/, '')}` : null,
    reliance_notice: RELIANCE_NOTICE,
  };
}

// §6 CB-5 — pinning level per CLAUSE-BINDING-BUILD-SPEC.md §1.3. A bare string (legacy §1.1
// form) is always L0/unpinned; the §1.2 object needs scheme+id to count at all, +path for L2,
// +in_force_from on top of path for L3. A year alone is never a date (spec §1.3 warning).
function pinLevel(c) {
  if (!c || typeof c !== 'object') return 'L0';
  if (!c.scheme || !c.id) return 'L0';
  if (!c.path) return 'L1';
  return c.in_force_from ? 'L3' : 'L2';
}

function pullCitations(container) {
  const out = [];
  const rc = container?.regulatory_citations;
  if (Array.isArray(rc)) out.push(...rc);
  const rb = container?.regulatory_basis;
  if (typeof rb === 'string' && rb) out.push(rb);
  else if (Array.isArray(rb)) out.push(...rb.filter((x) => typeof x === 'string' && x));
  return out;
}

/**
 * §6 CB-5 (CLAUSE-BINDING-BUILD-SPEC.md) — terse, structured rendering of the §1.2 citation
 * binding, agent-facing. POST-HASH ONLY: reads `regulatory_citations`/`regulatory_basis` already
 * inside `output_payload`/`policy_parameters` (§1.4 preimage) as shipped on the signed artifact —
 * never re-derives execution_hash, never mutates the artifact. A view, not a fact (OCG §13).
 */
export function citationBinding(artifact = {}) {
  const raw = [...pullCitations(artifact?.output_payload), ...pullCitations(artifact?.policy_parameters)];
  const citations = raw.map((c) =>
    typeof c === 'string'
      ? { pinned: false, level: 'L0', text: c }
      : {
          pinned: true,
          level: pinLevel(c),
          scheme: c?.scheme ?? null,
          id: c?.id ?? null,
          path: c?.path ?? null,
          in_force_from: c?.in_force_from ?? null,
          jurisdiction: c?.jurisdiction ?? null,
          superseded_by: c?.superseded_by ?? null,
        }
  );
  return {
    count: citations.length,
    citations,
    note: citations.length
      ? 'Read from the signed artifact preimage (CLAUSE-BINDING-BUILD-SPEC.md §1.4) — not independently signed on its own; verify the artifact JSON at metadata.verify_url.'
      : 'No regulatory_citations/regulatory_basis present on this artifact.',
  };
}

/** <tool_id>-<short_hash>.<ext> — short_hash = first 8 hex chars of execution_hash. */
export function exportFilename(artifact = {}, ext) {
  const tid = (artifact?.tool_id ?? 'artifact').toString().replace(/[^a-z0-9._-]/gi, '_');
  const h = String(artifact?.execution_hash ?? '').replace(/^sha256:/, '').slice(0, 8) || 'nohash';
  return `${tid}-${h}.${ext}`;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
/** Standard base64 over raw bytes — runtime-independent (no btoa/Buffer dependency). */
export function bytesToBase64(bytes) {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64[(n >>> 18) & 63] + B64[(n >>> 12) & 63] + B64[(n >>> 6) & 63] + B64[n & 63];
  }
  const rem = bytes.length - i;
  if (rem === 1) {
    const n = bytes[i] << 16;
    out += B64[(n >>> 18) & 63] + B64[(n >>> 12) & 63] + '==';
  } else if (rem === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += B64[(n >>> 18) & 63] + B64[(n >>> 12) & 63] + B64[(n >>> 6) & 63] + '=';
  }
  return out;
}

/** XML-escape a cell/text value. */
export function xmlEscape(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/** CSV-escape a field (RFC 4180). */
export function csvField(v) {
  const s = v == null ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Flatten an output_payload into named tables for tabular exports.
 * Returns { scalars: [[k,v]...], tables: [{ name, columns, rows }] }.
 * - array of objects  -> a table (columns = union of keys)
 * - array of scalars  -> a one-column table
 * - nested object     -> recursed with dotted key prefix into scalars
 * - scalar            -> a scalars row
 */
export function flattenPayload(payload = {}, prefix = '') {
  const scalars = [];
  const tables = [];
  for (const [k, v] of Object.entries(payload)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (Array.isArray(v)) {
      if (v.length && typeof v[0] === 'object' && v[0] !== null && !Array.isArray(v[0])) {
        const cols = [...new Set(v.flatMap((r) => Object.keys(r)))];
        tables.push({ name: key, columns: cols, rows: v.map((r) => cols.map((c) => r[c])) });
      } else {
        tables.push({ name: key, columns: [key], rows: v.map((x) => [x]) });
      }
    } else if (v && typeof v === 'object') {
      const inner = flattenPayload(v, key);
      scalars.push(...inner.scalars);
      tables.push(...inner.tables);
    } else {
      scalars.push([key, v]);
    }
  }
  return { scalars, tables };
}
