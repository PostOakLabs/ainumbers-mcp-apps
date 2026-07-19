// lei-kyb.mjs — LK-2 shared logic for the worker's lei_kyb_check MCP tool.
//
// Grading engine below is VENDORED, byte-identical (same six dimensions, same thresholds,
// same wording), from tools/551-lei-data-quality-grading-worksheet.html on the site repo —
// ported here (not imported: the site tool is an inlined, zero-dependency browser surface by
// design) so the SAME record graded here or pasted into T551 produces identical grades — the
// parity that LK-2's done-criteria require. Reuse check (per LEIKYB-1-BUILD-SPEC.md §LK-2):
// tools/317 (lei-lifecycle-gleif-validator) verifies LEI structure/check-digit; tools/363
// (lei-bic-iban-decoder) decodes LEI/BIC/IBAN fields. Neither GRADES data quality or produces a
// KYB worksheet receipt — this module does not duplicate either. The ISO 17442 structural
// pre-check below is the SAME small deterministic algorithm as tools/317 (ported, not a new
// competing validator) — used only to reject a malformed LEI before spending a GLEIF API call.
//
// EGRESS: this is the worker's first outbound network call (RULINGS-2026-07-19-EGRESS-APEX.md
// R1 — named allowlist). The ONLY host reached is api.gleif.org. No fallback, mirror, or second
// host — adding one is out of this row's authorization.
//
// Reuses the vendored kernels/_hash.mjs canonicalizer — no second canonicalization path, same
// discipline as worker.mjs's own cgCanon/cgExecutionHash, checkrun.mjs, and redline.mjs.
import { executionHash } from './kernels/_hash.mjs';

const GLEIF_HOST = 'api.gleif.org';
const GLEIF_RECORD_URL = (lei) => `https://${GLEIF_HOST}/api/v1/lei-records/${encodeURIComponent(lei)}`;

async function sha256Hex(str) {
  const bytes = new TextEncoder().encode(str);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ── ISO 17442 / ISO 7064 MOD 97-10 structural pre-check — ported verbatim from tools/317. ──
function leiToNumeric(lei) {
  return lei.split('').map((c) => (/[0-9]/.test(c) ? c : (c.charCodeAt(0) - 55).toString())).join('');
}
function mod97(n) {
  let r = 0;
  for (let i = 0; i < n.length; i += 7) r = parseInt(r.toString() + n.slice(i, i + 7), 10) % 97;
  return r;
}
function validateCheckDigits(lei) {
  const body = lei.slice(0, 18) + '00';
  const rem = mod97(leiToNumeric(body));
  const expected = (98 - rem).toString().padStart(2, '0');
  return { valid: lei.slice(18) === expected, expected, actual: lei.slice(18) };
}
export function structuralValidateLei(lei) {
  if (!lei || lei.length !== 20) return { ok: false, error: 'LENGTH', message: `Must be 20 chars. Got ${lei?.length || 0}.` };
  if (!/^[A-Z0-9]{20}$/.test(lei)) return { ok: false, error: 'CHARSET', message: 'Only uppercase A-Z and digits 0-9 permitted.' };
  const cd = validateCheckDigits(lei);
  return { ok: cd.valid, error: cd.valid ? null : 'CHECK_DIGIT', message: cd.valid ? 'Check digit valid' : `Expected ${cd.expected}, got ${cd.actual}.` };
}

// ── Grading engine — vendored verbatim from tools/551. Deterministic, six dimensions, over a
// GLEIF JSON:API lei-records record. No network calls of its own — pure function of `rec`. ──
const GRADE_POINTS = { A: 4, B: 3, C: 2, D: 1, F: 0 };
function pointsToGrade(p) {
  if (p >= 3.5) return 'A'; if (p >= 2.5) return 'B'; if (p >= 1.5) return 'C'; if (p >= 0.5) return 'D'; return 'F';
}
function exceptionReasonGrade(reason) {
  const benign = new Set(['NATURAL_PERSONS', 'NO_LEI', 'NON_CONSOLIDATING', 'DISCLOSURE_NOT_REQUIRED']);
  const guarded = new Set(['NON_PUBLIC', 'LEGAL_OBSTACLES', 'LOU_ASSESSMENT']);
  if (benign.has(reason)) return { grade: 'B', note: `Documented exception "${reason}" – a recognised GLEIF Level 2 exemption category.` };
  if (guarded.has(reason)) return { grade: 'C', note: `Documented exception "${reason}" – recognised category, but one that limits third-party corroboration of the parent relationship.` };
  return { grade: 'C', note: `Reporting exception present with an unrecognised reason code "${reason || '(none)'}" – treat as unverified.` };
}
export function gradeRecordObject(rec) {
  const attrs = rec?.data?.attributes || {};
  const rel = rec?.data?.relationships || {};
  const included = Array.isArray(rec?.included) ? rec.included : [];
  const lei = attrs.lei || rec?.data?.id || '(unknown)';
  const regStatus = attrs.registration?.status || null;
  const findings = [];

  let f1;
  if (regStatus === 'ISSUED') f1 = { id: 'registration_status', dimension: 'Registration Status', grade: 'A', detail: 'Status is ISSUED – current and valid per GLEIF lifecycle.', citation: 'GLEIF LEI-CDF registration.status' };
  else if (regStatus === 'LAPSED') f1 = { id: 'registration_status', dimension: 'Registration Status', grade: 'D', detail: 'Status is LAPSED – renewal overdue. Structurally present but not current.', citation: 'GLEIF LEI-CDF registration.status' };
  else if (regStatus === 'RETIRED') f1 = { id: 'registration_status', dimension: 'Registration Status', grade: 'F', detail: 'Status is RETIRED – entity record closed or merged. Not a live, usable identifier.', citation: 'GLEIF LEI-CDF registration.status' };
  else if (regStatus) f1 = { id: 'registration_status', dimension: 'Registration Status', grade: 'C', detail: `Status is ${regStatus} – a transitional or non-standard lifecycle state. Verify before reliance.`, citation: 'GLEIF LEI-CDF registration.status' };
  else f1 = { id: 'registration_status', dimension: 'Registration Status', grade: 'F', detail: 'registration.status is missing from the pasted record.', citation: 'GLEIF LEI-CDF registration.status' };
  findings.push(f1);

  let f2;
  const nextRenewal = attrs.registration?.nextRenewalDate;
  if (!nextRenewal) f2 = { id: 'renewal_timeliness', dimension: 'Renewal Timeliness', grade: 'F', detail: 'registration.nextRenewalDate is missing – renewal timeliness cannot be assessed.', citation: 'GLEIF Data Quality Report – timeliness dimension' };
  else {
    const days = (new Date(nextRenewal).getTime() - Date.now()) / 86400000;
    if (regStatus === 'ISSUED' && days < 0) f2 = { id: 'renewal_timeliness', dimension: 'Renewal Timeliness', grade: 'D', detail: `nextRenewalDate (${nextRenewal.slice(0, 10)}) is in the past while status still reads ISSUED – a status/date inconsistency worth flagging.`, citation: 'GLEIF Data Quality Report – timeliness dimension' };
    else if (regStatus === 'ISSUED' && days <= 90) f2 = { id: 'renewal_timeliness', dimension: 'Renewal Timeliness', grade: 'B', detail: `Renewal due in ${Math.round(days)} days (${nextRenewal.slice(0, 10)}) – approaching, not yet overdue.`, citation: 'GLEIF Data Quality Report – timeliness dimension' };
    else if (regStatus === 'ISSUED') f2 = { id: 'renewal_timeliness', dimension: 'Renewal Timeliness', grade: 'A', detail: `Renewal due ${nextRenewal.slice(0, 10)}, ${Math.round(days)} days out – comfortably current.`, citation: 'GLEIF Data Quality Report – timeliness dimension' };
    else f2 = { id: 'renewal_timeliness', dimension: 'Renewal Timeliness', grade: 'C', detail: `Record is not ISSUED (${regStatus || 'unknown'}); nextRenewalDate ${nextRenewal.slice(0, 10)} is informational only.`, citation: 'GLEIF Data Quality Report – timeliness dimension' };
  }
  findings.push(f2);

  const corrob = attrs.registration?.corroborationLevel;
  let f3;
  if (corrob === 'FULLY_CORROBORATED') f3 = { id: 'corroboration_level', dimension: 'Corroboration Level', grade: 'A', detail: 'Record data is FULLY_CORROBORATED by the managing LOU against a third-party source.', citation: 'GLEIF LEI-CDF registration.corroborationLevel' };
  else if (corrob === 'PARTIALLY_CORROBORATED') f3 = { id: 'corroboration_level', dimension: 'Corroboration Level', grade: 'C', detail: 'Record data is only PARTIALLY_CORROBORATED – some fields unverified against a third-party source.', citation: 'GLEIF LEI-CDF registration.corroborationLevel' };
  else if (corrob === 'ENTITY_SUPPLIED_ONLY') f3 = { id: 'corroboration_level', dimension: 'Corroboration Level', grade: 'D', detail: 'Record data is ENTITY_SUPPLIED_ONLY – self-reported, not independently corroborated.', citation: 'GLEIF LEI-CDF registration.corroborationLevel' };
  else f3 = { id: 'corroboration_level', dimension: 'Corroboration Level', grade: 'F', detail: `corroborationLevel is missing or unrecognised (${corrob || 'none'}).`, citation: 'GLEIF LEI-CDF registration.corroborationLevel' };
  findings.push(f3);

  const entStatus = attrs.entity?.status;
  let f4;
  if (entStatus === 'ACTIVE') f4 = { id: 'entity_status', dimension: 'Entity Status', grade: 'A', detail: 'entity.status is ACTIVE.', citation: 'GLEIF LEI-CDF entity.status' };
  else if (entStatus === 'INACTIVE') f4 = { id: 'entity_status', dimension: 'Entity Status', grade: 'F', detail: 'entity.status is INACTIVE – the underlying legal entity is no longer active.', citation: 'GLEIF LEI-CDF entity.status' };
  else f4 = { id: 'entity_status', dimension: 'Entity Status', grade: 'D', detail: `entity.status is missing or unrecognised (${entStatus || 'none'}).`, citation: 'GLEIF LEI-CDF entity.status' };
  findings.push(f4);

  const dp = rel['direct-parent'];
  const up = rel['ultimate-parent'];
  let f5;
  const dpHasData = !!dp?.data;
  const upHasData = !!up?.data;
  if (dpHasData || upHasData) {
    f5 = { id: 'parent_disclosure', dimension: 'Level-2 Parent Disclosure', grade: 'A', detail: 'A direct and/or ultimate parent relationship is disclosed with an LEI.', citation: 'GLEIF Level 2 relationship data (RR)' };
  } else {
    const exc = included.find((i) => i.type === 'reporting-exceptions');
    if (exc) {
      const g = exceptionReasonGrade(exc.attributes?.reason);
      f5 = { id: 'parent_disclosure', dimension: 'Level-2 Parent Disclosure', grade: g.grade, detail: `No parent LEI disclosed; a typed reporting exception is present. ${g.note}`, citation: 'GLEIF Level 2 reporting-exception taxonomy' };
    } else if (dp?.links?.['reporting-exception'] || up?.links?.['reporting-exception']) {
      f5 = { id: 'parent_disclosure', dimension: 'Level-2 Parent Disclosure', grade: 'C', detail: 'No parent LEI disclosed; a reporting-exception link is present but its typed reason was not included in the pasted record.', citation: 'GLEIF Level 2 reporting-exception taxonomy' };
    } else {
      f5 = { id: 'parent_disclosure', dimension: 'Level-2 Parent Disclosure', grade: 'F', detail: 'No parent LEI disclosed and no reporting exception of any kind found – an undocumented Level 2 gap.', citation: 'GLEIF Level 2 relationship data (RR)' };
    }
  }
  findings.push(f5);

  const addr = attrs.entity?.legalAddress || {};
  const req = ['addressLines', 'city', 'country', 'postalCode'];
  const missing = req.filter((k) => {
    const v = addr[k];
    return k === 'addressLines' ? !(Array.isArray(v) && v.length && v[0]) : !v;
  });
  let f6;
  if (missing.length === 0) f6 = { id: 'address_completeness', dimension: 'Address Completeness', grade: 'A', detail: 'legalAddress carries address lines, city, country, and postal code.', citation: 'GLEIF Data Quality Report – completeness dimension' };
  else if (missing.length === 1) f6 = { id: 'address_completeness', dimension: 'Address Completeness', grade: 'C', detail: `legalAddress is missing: ${missing.join(', ')}.`, citation: 'GLEIF Data Quality Report – completeness dimension' };
  else f6 = { id: 'address_completeness', dimension: 'Address Completeness', grade: 'F', detail: `legalAddress is missing multiple required fields: ${missing.join(', ')}.`, citation: 'GLEIF Data Quality Report – completeness dimension' };
  findings.push(f6);

  const avg = findings.reduce((s, f) => s + GRADE_POINTS[f.grade], 0) / findings.length;
  const composite = pointsToGrade(avg);
  return { lei, findings, composite, compositePoints: avg };
}

// ── GLEIF fetch — the worker's ONLY egress target for this row (api.gleif.org, named
// allowlist). GLEIF is public/no-auth/60 req-min. Cloudflare edge cache (`cf.cacheTtl`)
// respects/extends the response's own Cache-Control so repeat lookups of the same LEI inside
// the TTL never re-hit the rate limit. One retry on 429, honoring Retry-After (bounded, never
// a hot loop) — anything else propagates as a typed error the tool surfaces to the caller. ──
export class GleifFetchError extends Error {
  constructor(message, { status, notFound } = {}) {
    super(message);
    this.name = 'GleifFetchError';
    this.status = status ?? null;
    this.notFound = !!notFound;
  }
}

export async function fetchGleifRecord(lei, { fetchImpl = fetch, retried = false } = {}) {
  const url = GLEIF_RECORD_URL(lei);
  const res = await fetchImpl(url, {
    headers: { Accept: 'application/vnd.api+json' },
    cf: { cacheTtl: 300, cacheEverything: true },
  });

  if (res.status === 429 && !retried) {
    const retryAfterSec = Number(res.headers.get('retry-after')) || 2;
    await new Promise((r) => setTimeout(r, Math.min(retryAfterSec, 10) * 1000));
    return fetchGleifRecord(lei, { fetchImpl, retried: true });
  }
  if (res.status === 404) {
    throw new GleifFetchError(`No GLEIF record found for LEI ${lei}.`, { status: 404, notFound: true });
  }
  if (!res.ok) {
    throw new GleifFetchError(`GLEIF lookup failed: HTTP ${res.status} ${res.statusText}.`, { status: res.status });
  }

  const bodyText = await res.text();
  const responseDigest = await sha256Hex(bodyText);
  let record;
  try { record = JSON.parse(bodyText); }
  catch (e) { throw new GleifFetchError(`GLEIF response was not valid JSON: ${e.message}.`, { status: res.status }); }

  return { record, url, responseDigest, retrievedAt: new Date().toISOString() };
}

// ── Receipt — HONEST about determinism. A live external fetch is NOT bit-exact-replayable
// from the LEI alone: the same LEI can return different bytes on a later call if GLEIF or the
// managing LOU updates the record between calls. This receipt is an ASSERTED FETCH (worker
// claims it retrieved this exact response at this URL/time), NOT a zkTLS/TLSNotary-class proof
// of origin — no such proof is attached or claimed. `source.response_digest` lets any caller
// who separately captures the same GLEIF response verify the grading ran over byte-identical
// input; it does NOT prove the fetch itself. grader_version pins the grading algorithm so a
// later change to thresholds/wording is visible in the receipt, not silent.
export async function runLeiKybCheck({ lei, fetchImpl } = {}) {
  if (typeof lei !== 'string') {
    return { isError: true, error: 'lei must be a string.' };
  }
  const leiUpper = lei.trim().toUpperCase();
  const structural = structuralValidateLei(leiUpper);
  if (!structural.ok) {
    return { isError: true, error: `Malformed LEI (${structural.error}): ${structural.message}` };
  }

  let fetched;
  try {
    fetched = await fetchGleifRecord(leiUpper, { fetchImpl });
  } catch (e) {
    if (e instanceof GleifFetchError) return { isError: true, error: e.message, notFound: e.notFound };
    throw e;
  }

  const graded = gradeRecordObject(fetched.record);
  const generated_at = fetched.retrievedAt;

  const policy_parameters = {
    lei: leiUpper,
    grader_version: '1.0.0',
    composite_grade: graded.composite,
    source: { url: fetched.url, retrieved_at: fetched.retrievedAt, response_digest: fetched.responseDigest },
    generated_at,
  };
  const output_payload = {
    grades: Object.fromEntries(graded.findings.map((f) => [f.id, f.grade])),
    findings: graded.findings,
  };
  const execution_hash = await executionHash(policy_parameters, output_payload);

  const receipt = {
    tool_id: 'lei-kyb-check-receipt',
    tool_version: '1.0.0',
    generated_at,
    determinism_note: 'ASSERTED FETCH, not bit-exact-replayable: the same LEI may return a different response if GLEIF updates the record between calls. No zkTLS/TLSNotary-class proof of the fetch origin is attached or claimed — source.response_digest lets a caller who independently captures the same GLEIF response confirm the grading ran over byte-identical input, nothing more.',
    scope_note: 'Grades data quality of the LEI record only – not creditworthiness, sanctions status, or entity legitimacy.',
    policy_parameters,
    output_payload,
    execution_hash,
  };

  return { lei: leiUpper, composite_grade: graded.composite, grades: output_payload.grades, findings: graded.findings, source: policy_parameters.source, receipt };
}
