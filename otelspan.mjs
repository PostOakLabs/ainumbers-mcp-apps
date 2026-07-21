// otelspan.mjs — OTELSPAN-1 OS-3 shared logic for the worker's OTLP GenAI span
// tools (otlp_validate, otlp_span_receipt) and the OTel<->OCG chain bridge.
//
// Lint engine below is byte-identical to tools/556-otlp-genai-span-composer-linter.html
// (same OP_REQUIREMENTS / SEMCONV_SNAPSHOT_ID / HEX32/HEX16/NANOSTR regexes / attrMap /
// attrValueType / lintOtlpTrace), and the receipt engine is byte-identical to
// tools/566-otel-span-receipt-verifier.html (same span_digest/parent_receipt_digest/
// eddsa-jcs-2022 signing over a root-level `proof` field, same RFC 6962 Merkle trace
// receipt) -- so a human's browser-generated bundle and an agent's worker-generated
// bundle interoperate on the exact same wire shape and either side's verifier accepts
// the other's output. This is why signDoc/verifyDoc here sign at doc.proof, NOT
// artifact.audit_signature.proof (the §16 SSOT home for OCG's OWN artifacts) -- the
// OTel span-receipt shape is a distinct, tool-556/566-defined wire format, not an OCG
// execution artifact, and must stay pinned to what the site tool already ships.
//
// cgCanon/executionHash ARE reused from the shared kernel (one canonicalizer, never a
// second hand-rolled one); rawPubkeyToDidKey/didKeyToPublicKey are reused from _proof.mjs
// for the same reason (one did:key <-> Ed25519 raw-key mapping).
import { cgCanon, executionHash } from './kernels/_hash.mjs';
import { rawPubkeyToDidKey, didKeyToPublicKey } from './kernels/_proof.mjs';

/* ══════════════════════════════════════════════════════════════
   Pinned gen_ai semantic-convention attribute snapshot -- same
   dated pin as tools/556 and tools/566. The upstream gen_ai
   namespace (open-telemetry/semantic-conventions-genai) has ZERO
   tagged releases, so this is OUR pin, stamped into every artifact.
══════════════════════════════════════════════════════════════ */
export const SEMCONV_SNAPSHOT_ID = 'genai-semconv-snapshot-2026-07-18';
const CHAINGRAPH_VERSION = '0.4.0';
const TOOL_ID = 'otlp_span_receipt';

const OP_REQUIREMENTS = {
  invoke_agent: { required: ['gen_ai.operation.name', 'gen_ai.system', 'gen_ai.agent.name'], intAttrs: [] },
  create_agent: { required: ['gen_ai.operation.name', 'gen_ai.system', 'gen_ai.agent.name'], intAttrs: [] },
  chat: { required: ['gen_ai.operation.name', 'gen_ai.system', 'gen_ai.request.model', 'gen_ai.usage.input_tokens', 'gen_ai.usage.output_tokens'], intAttrs: ['gen_ai.usage.input_tokens', 'gen_ai.usage.output_tokens'] },
  text_completion: { required: ['gen_ai.operation.name', 'gen_ai.system', 'gen_ai.request.model', 'gen_ai.usage.input_tokens', 'gen_ai.usage.output_tokens'], intAttrs: ['gen_ai.usage.input_tokens', 'gen_ai.usage.output_tokens'] },
  execute_tool: { required: ['gen_ai.operation.name', 'gen_ai.system', 'gen_ai.tool.name'], intAttrs: [] },
  embeddings: { required: ['gen_ai.operation.name', 'gen_ai.system', 'gen_ai.request.model'], intAttrs: [] },
};

const HEX32 = /^[0-9a-f]{32}$/;
const HEX16 = /^[0-9a-f]{16}$/;
const NANOSTR = /^\d+$/;

function attrMap(attributes) {
  const m = {};
  if (Array.isArray(attributes)) for (const a of attributes) { if (a && typeof a.key === 'string') m[a.key] = a.value; }
  return m;
}
function attrValueType(v) {
  if (!v || typeof v !== 'object') return null;
  if ('stringValue' in v) return 'stringValue';
  if ('intValue' in v) return 'intValue';
  if ('boolValue' in v) return 'boolValue';
  if ('doubleValue' in v) return 'doubleValue';
  return null;
}

/**
 * lintOtlpTrace(doc) -> { findings, allSpans } -- structural validation + gen_ai attribute
 * conformance, identical logic/wording to tools/556's lint engine.
 */
export function lintOtlpTrace(doc) {
  const findings = [];
  const allSpanIds = new Set();
  const allSpans = [];

  if (!doc || typeof doc !== 'object') {
    findings.push({ id: 'root', title: 'Document shape', status: 'bad', ok: false, detail: 'Top-level value is not a JSON object.' });
    return { findings, allSpans: [] };
  }
  if (!Array.isArray(doc.resourceSpans) || doc.resourceSpans.length === 0) {
    findings.push({ id: 'resourceSpans', title: 'resourceSpans array', status: 'bad', ok: false, detail: 'Missing or empty "resourceSpans" array at the document root.' });
    return { findings, allSpans: [] };
  }
  findings.push({ id: 'resourceSpans', title: 'resourceSpans array', status: 'ok', ok: true, detail: `${doc.resourceSpans.length} resourceSpans entr${doc.resourceSpans.length === 1 ? 'y' : 'ies'} present.` });

  doc.resourceSpans.forEach((rs, ri) => {
    if (!Array.isArray(rs.scopeSpans) || rs.scopeSpans.length === 0) {
      findings.push({ id: `rs${ri}_scopeSpans`, title: `resourceSpans[${ri}].scopeSpans`, status: 'bad', ok: false, detail: 'Missing or empty "scopeSpans" array.' });
      return;
    }
    rs.scopeSpans.forEach((ss, si) => {
      if (!Array.isArray(ss.spans)) {
        findings.push({ id: `rs${ri}_ss${si}_spans`, title: `resourceSpans[${ri}].scopeSpans[${si}].spans`, status: 'bad', ok: false, detail: 'Missing "spans" array.' });
        return;
      }
      ss.spans.forEach((sp) => { if (sp && typeof sp.spanId === 'string') allSpanIds.add(sp.spanId); allSpans.push(sp); });
    });
  });

  if (allSpans.length === 0) {
    findings.push({ id: 'spans', title: 'Span count', status: 'bad', ok: false, detail: 'No spans found anywhere in the trace.' });
    return { findings, allSpans };
  }
  findings.push({ id: 'spans', title: 'Span count', status: 'ok', ok: true, detail: `${allSpans.length} span${allSpans.length === 1 ? '' : 's'} found across the trace.` });

  allSpans.forEach((sp, idx) => {
    const label = sp.name ? `"${sp.name}"` : `span[${idx}]`;

    if (typeof sp.traceId === 'string' && HEX32.test(sp.traceId)) {
      findings.push({ id: `sp${idx}_traceId`, title: `${label}: traceId`, status: 'ok', ok: true, detail: '32-char lowercase hex, correct.' });
    } else {
      findings.push({ id: `sp${idx}_traceId`, title: `${label}: traceId`, status: 'bad', ok: false, detail: `Not a valid traceId. Expected 32 lowercase hex characters, got "${sp.traceId}".` });
    }

    if (typeof sp.spanId === 'string' && HEX16.test(sp.spanId)) {
      findings.push({ id: `sp${idx}_spanId`, title: `${label}: spanId`, status: 'ok', ok: true, detail: '16-char lowercase hex, correct.' });
    } else {
      findings.push({ id: `sp${idx}_spanId`, title: `${label}: spanId`, status: 'bad', ok: false, detail: `Not a valid spanId. Expected 16 lowercase hex characters, got "${sp.spanId}".` });
    }

    if (sp.parentSpanId) {
      if (allSpanIds.has(sp.parentSpanId)) {
        findings.push({ id: `sp${idx}_parent`, title: `${label}: parentSpanId`, status: 'ok', ok: true, detail: 'References a spanId present in this trace.' });
      } else {
        findings.push({ id: `sp${idx}_parent`, title: `${label}: parentSpanId`, status: 'bad', ok: false, detail: `parentSpanId "${sp.parentSpanId}" does not match any spanId in this trace (dangling parent reference).` });
      }
    }

    const startOk = typeof sp.startTimeUnixNano === 'string' && NANOSTR.test(sp.startTimeUnixNano);
    const endOk = typeof sp.endTimeUnixNano === 'string' && NANOSTR.test(sp.endTimeUnixNano);
    if (startOk) {
      findings.push({ id: `sp${idx}_start`, title: `${label}: startTimeUnixNano`, status: 'ok', ok: true, detail: 'Quoted decimal nanosecond string, correct.' });
    } else {
      findings.push({ id: `sp${idx}_start`, title: `${label}: startTimeUnixNano`, status: 'bad', ok: false, detail: `Not a quoted decimal nanosecond string. Got "${sp.startTimeUnixNano}".` });
    }
    if (endOk) {
      findings.push({ id: `sp${idx}_end`, title: `${label}: endTimeUnixNano`, status: 'ok', ok: true, detail: 'Quoted decimal nanosecond string, correct.' });
    } else {
      findings.push({ id: `sp${idx}_end`, title: `${label}: endTimeUnixNano`, status: 'bad', ok: false, detail: `Not a quoted decimal nanosecond string. Got "${sp.endTimeUnixNano}".` });
    }
    if (startOk && endOk) {
      const s = BigInt(sp.startTimeUnixNano), e = BigInt(sp.endTimeUnixNano);
      if (e < s) {
        findings.push({ id: `sp${idx}_order`, title: `${label}: time ordering`, status: 'bad', ok: false, detail: 'endTimeUnixNano is earlier than startTimeUnixNano.' });
      } else {
        findings.push({ id: `sp${idx}_order`, title: `${label}: time ordering`, status: 'ok', ok: true, detail: 'endTimeUnixNano is not before startTimeUnixNano.' });
      }
    }

    const attrs = attrMap(sp.attributes);
    const opAttr = attrs['gen_ai.operation.name'];
    const op = opAttr && opAttr.stringValue;
    if (!op) {
      findings.push({ id: `sp${idx}_gen_ai`, title: `${label}: gen_ai coverage`, status: 'info', ok: null, detail: 'Not a gen_ai span (no gen_ai.operation.name attribute) – skipped by the conformance check.' });
      return;
    }
    const req = OP_REQUIREMENTS[op];
    if (!req) {
      findings.push({ id: `sp${idx}_gen_ai_op`, title: `${label}: gen_ai.operation.name`, status: 'warn', ok: null, detail: `Operation "${op}" is not in this tool's pinned snapshot (${SEMCONV_SNAPSHOT_ID}) – not scored as a failure, just unrecognized.` });
      return;
    }
    for (const key of req.required) {
      if (key in attrs) {
        if (req.intAttrs.includes(key)) {
          const t = attrValueType(attrs[key]);
          if (t === 'intValue') {
            findings.push({ id: `sp${idx}_${key}`, title: `${label}: ${key}`, status: 'ok', ok: true, detail: 'Present with intValue, correct type per snapshot.' });
          } else {
            findings.push({ id: `sp${idx}_${key}`, title: `${label}: ${key}`, status: 'bad', ok: false, detail: `Present but encoded as "${t}" instead of "intValue" – ${SEMCONV_SNAPSHOT_ID} requires this attribute to be a numeric (intValue) AnyValue.` });
          }
        } else {
          findings.push({ id: `sp${idx}_${key}`, title: `${label}: ${key}`, status: 'ok', ok: true, detail: `Present, required by snapshot for operation "${op}".` });
        }
      } else {
        findings.push({ id: `sp${idx}_${key}`, title: `${label}: ${key}`, status: 'bad', ok: false, detail: `Missing – ${SEMCONV_SNAPSHOT_ID} requires "${key}" on a "${op}" span.` });
      }
    }
  });

  return { findings, allSpans };
}

/**
 * validateOtlpTrace(doc) -> summarized report for the otlp_validate tool.
 */
export function validateOtlpTrace(doc) {
  const { findings, allSpans } = lintOtlpTrace(doc);
  const pass_count = findings.filter((f) => f.ok === true).length;
  const fail_count = findings.filter((f) => f.ok === false).length;
  const info_count = findings.filter((f) => f.ok === null).length;
  return { semconv_snapshot: SEMCONV_SNAPSHOT_ID, span_count: allSpans.length, pass_count, fail_count, info_count, valid: fail_count === 0, findings };
}

/* ══════════════════════════════════════════════════════════════
   Receipt engine -- byte-identical to tools/566: span digest,
   parent-receipt digest chain, eddsa-jcs-2022 signature over a
   root-level `proof` field, RFC 6962 Merkle-rooted trace receipt.
══════════════════════════════════════════════════════════════ */
async function sha256(bytes) {
  const d = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return new Uint8Array(d);
}
function jcsBytes(obj) { return new TextEncoder().encode(JSON.stringify(cgCanon(obj))); }
async function sha256HexOfCanon(v) {
  const b = await sha256(jcsBytes(v));
  return Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('');
}
function hexToBytes(hex) {
  const b = new Uint8Array(hex.length / 2);
  for (let i = 0; i < b.length; i++) b[i] = parseInt(hex.substr(i * 2, 2), 16);
  return b;
}
function concatBytes(a, b) { const out = new Uint8Array(a.length + b.length); out.set(a, 0); out.set(b, a.length); return out; }
async function leafHash(data) { return sha256(concatBytes(new Uint8Array([0x00]), data)); }
async function nodeHash(l, r) { return sha256(concatBytes(new Uint8Array([0x01]), concatBytes(l, r))); }
function bytesToHex(b) { return Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join(''); }
async function mth(leafHashes) {
  const n = leafHashes.length;
  if (n === 1) return leafHashes[0];
  let k = 1; while (k * 2 < n) k *= 2;
  return nodeHash(await mth(leafHashes.slice(0, k)), await mth(leafHashes.slice(k)));
}

function proofOptions(o) {
  return { type: 'DataIntegrityProof', cryptosuite: 'eddsa-jcs-2022', verificationMethod: o.verificationMethod, proofPurpose: 'assertionMethod', created: o.created };
}
async function hashData(doc, opts) {
  const optHash = await sha256(jcsBytes(opts));
  const docHash = await sha256(jcsBytes(doc));
  return concatBytes(optHash, docHash);
}
// Root-level `proof` field (NOT audit_signature.proof) -- matches tools/566 exactly, the
// OTel span-receipt wire shape this bridges to, not an OCG execution artifact.
async function signDoc(doc, proofField, o) {
  if (!o.verificationMethod || !o.created || !o.privateKey) throw new Error('signDoc requires verificationMethod, created, privateKey');
  const opts = proofOptions(o);
  const secured = { ...doc }; delete secured[proofField];
  const sigBytes = new Uint8Array(await globalThis.crypto.subtle.sign('Ed25519', o.privateKey, await hashData(secured, opts)));
  const proof = { ...opts, proofValue: 'z' + b58encode(sigBytes) };
  return { ...doc, [proofField]: proof };
}
export async function verifyDoc(doc, proofField, publicKey) {
  const proof = doc[proofField];
  if (!proof || proof.type !== 'DataIntegrityProof' || proof.cryptosuite !== 'eddsa-jcs-2022') return false;
  if (proof.proofPurpose !== 'assertionMethod' || typeof proof.proofValue !== 'string' || proof.proofValue[0] !== 'z') return false;
  const opts = proofOptions({ verificationMethod: proof.verificationMethod, created: proof.created });
  try {
    const sig = b58decode(proof.proofValue.slice(1));
    const secured = { ...doc }; delete secured[proofField];
    return await globalThis.crypto.subtle.verify('Ed25519', publicKey, sig, await hashData(secured, opts));
  } catch { return false; }
}

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58encode(bytes) {
  let zeros = 0; while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const digits = [0];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j++) { carry += digits[j] << 8; digits[j] = carry % 58; carry = (carry / 58) | 0; }
    while (carry) { digits.push(carry % 58); carry = (carry / 58) | 0; }
  }
  let out = ''; for (let k = 0; k < zeros; k++) out += '1';
  for (let q = digits.length - 1; q >= 0; q--) out += B58[digits[q]];
  return out;
}
function b58decode(str) {
  let zeros = 0; while (zeros < str.length && str[zeros] === '1') zeros++;
  const bytes = [0];
  for (let i = zeros; i < str.length; i++) {
    let carry = B58.indexOf(str[i]); if (carry < 0) throw new Error('bad base58 char');
    for (let j = 0; j < bytes.length; j++) { carry += bytes[j] * 58; bytes[j] = carry & 0xff; carry >>= 8; }
    while (carry) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  const out = new Uint8Array(zeros + bytes.length);
  for (let k = 0; k < bytes.length; k++) out[zeros + bytes.length - 1 - k] = bytes[k];
  return out;
}

function flattenSpans(trace) {
  const out = [];
  (trace.resourceSpans || []).forEach((rs) => {
    (rs.scopeSpans || []).forEach((ss) => { (ss.spans || []).forEach((sp) => out.push(sp)); });
  });
  return out;
}

/**
 * generateSpanReceiptBundle(trace, generatedAt) -> { trace, span_receipts, trace_receipt, issuer_did }
 * One ephemeral Ed25519 keypair per call (not persisted), same session-key model as
 * tools/566 and intoto.mjs. generatedAt is caller-supplied for determinism (tests); defaults
 * to the call time.
 */
export async function generateSpanReceiptBundle(trace, generatedAt) {
  const spans = flattenSpans(trace);
  if (spans.length === 0) throw new Error('No spans found under resourceSpans[].scopeSpans[].spans[].');
  const traceId = spans[0].traceId;

  const kp = await globalThis.crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const issuerDid = await rawPubkeyToDidKey(kp.publicKey);
  const ts = generatedAt || new Date().toISOString();

  const receiptsBySpanId = {};
  const spanReceipts = [];
  for (const sp of spans) {
    const spanDigest = await sha256HexOfCanon(sp);
    let parentReceiptDigest = null;
    if (sp.parentSpanId && receiptsBySpanId[sp.parentSpanId]) {
      parentReceiptDigest = await sha256HexOfCanon(receiptsBySpanId[sp.parentSpanId]);
    }
    const draft = {
      chaingraph_version: CHAINGRAPH_VERSION, tool_id: TOOL_ID, generated_at: ts,
      trace_id: traceId, span_id: sp.spanId, parent_span_id: sp.parentSpanId || null,
      span_digest: spanDigest, parent_receipt_digest: parentReceiptDigest,
      semconv_snapshot: SEMCONV_SNAPSHOT_ID,
    };
    const signed = await signDoc(draft, 'proof', { verificationMethod: issuerDid, created: ts, privateKey: kp.privateKey });
    receiptsBySpanId[sp.spanId] = signed;
    spanReceipts.push(signed);
  }

  const leafHashes = [];
  for (const r of spanReceipts) leafHashes.push(await leafHash(hexToBytes(await sha256HexOfCanon(r))));
  const rootHex = bytesToHex(await mth(leafHashes));

  const policy_parameters = { activity: 'otel_trace_receipt', trace_id: traceId, span_count: spanReceipts.length };
  const output_payload = { merkle_root: rootHex, semconv_snapshot: SEMCONV_SNAPSHOT_ID, algorithm: 'rfc6962' };
  const execHash = await executionHash(policy_parameters, output_payload);

  const traceDraft = {
    chaingraph_version: CHAINGRAPH_VERSION, tool_id: TOOL_ID, generated_at: ts,
    trace_id: traceId, algorithm: 'rfc6962', tree_size: spanReceipts.length,
    leaves: spanReceipts.map((r) => r.span_id), merkle_root: rootHex,
    semconv_snapshot: SEMCONV_SNAPSHOT_ID,
    policy_parameters, output_payload, execution_hash: execHash,
  };
  const traceReceipt = await signDoc(traceDraft, 'proof', { verificationMethod: issuerDid, created: ts, privateKey: kp.privateKey });

  return { trace, span_receipts: spanReceipts, trace_receipt: traceReceipt, issuer_did: issuerDid };
}

/**
 * verifySpanReceiptBundle(bundle) -> verification report: recomputes every span digest,
 * the parent-receipt chain, the eddsa-jcs-2022 signatures, and the Merkle root, and reports
 * which spans are attested / unattested / tampered. Identical logic to tools/566's verifier.
 */
export async function verifySpanReceiptBundle(bundle) {
  if (!bundle || !bundle.trace || !Array.isArray(bundle.span_receipts) || !bundle.trace_receipt) {
    throw new Error('Bundle must have {trace, span_receipts[], trace_receipt}.');
  }
  const spans = flattenSpans(bundle.trace);
  const spanById = {}; spans.forEach((s) => { spanById[s.spanId] = s; });
  const receiptsBySpanId = {}; bundle.span_receipts.forEach((r) => { receiptsBySpanId[r.span_id] = r; });

  const issuerDid = bundle.issuer_did || (bundle.span_receipts[0] && bundle.span_receipts[0].proof && bundle.span_receipts[0].proof.verificationMethod);
  let publicKey = null, keyErr = null;
  try { publicKey = issuerDid ? await didKeyToPublicKey(issuerDid) : null; } catch (e) { keyErr = e.message; }

  const findings = []; const counts = { attested: 0, unattested: 0, tampered: 0 };

  for (const r of bundle.span_receipts) {
    const sp = spanById[r.span_id];
    if (!sp) {
      findings.push({ id: r.span_id, title: `span_id ${r.span_id}`, status: 'bad', label: 'TAMPERED', detail: 'Receipt references a span_id not present in the trace at all.' });
      counts.tampered++; continue;
    }
    const recomputedDigest = await sha256HexOfCanon(sp);
    const digestOk = recomputedDigest === r.span_digest;

    let sigOk = false;
    if (publicKey) { try { sigOk = await verifyDoc(r, 'proof', publicKey); } catch { sigOk = false; } }

    let chainOk = true, chainDetail = '';
    if (r.parent_span_id) {
      const parentReceipt = receiptsBySpanId[r.parent_span_id];
      if (!parentReceipt) { chainOk = false; chainDetail = `Parent receipt for ${r.parent_span_id} is missing from the bundle.`; }
      else {
        const recomputedParentDigest = await sha256HexOfCanon(parentReceipt);
        chainOk = recomputedParentDigest === r.parent_receipt_digest;
        if (!chainOk) chainDetail = 'parent_receipt_digest does not match the recomputed digest of the bundled parent receipt.';
      }
    }

    if (digestOk && sigOk && chainOk) {
      findings.push({ id: r.span_id, title: `span_id ${r.span_id}`, status: 'ok', label: 'ATTESTED', detail: 'span_digest, eddsa-jcs-2022 signature, and parent-receipt chain all verify.' });
      counts.attested++;
    } else {
      const detail = [];
      if (!digestOk) detail.push('span_digest mismatch (trace content changed after signing)');
      if (!sigOk) detail.push(publicKey ? 'eddsa-jcs-2022 signature does not verify' : `no issuer public key to verify against (${keyErr || 'missing issuer_did'})`);
      if (!chainOk) detail.push(chainDetail);
      findings.push({ id: r.span_id, title: `span_id ${r.span_id}`, status: 'bad', label: 'TAMPERED', detail: detail.join(' · ') });
      counts.tampered++;
    }
  }

  spans.forEach((sp) => {
    if (!receiptsBySpanId[sp.spanId]) {
      findings.push({ id: sp.spanId, title: `span_id ${sp.spanId}`, status: 'warn', label: 'UNATTESTED', detail: 'Present in the trace but has no receipt in this bundle – never signed, or its receipt was dropped.' });
      counts.unattested++;
    }
  });

  const leafHashes = [];
  for (const r of bundle.span_receipts) leafHashes.push(await leafHash(hexToBytes(await sha256HexOfCanon(r))));
  let rootOk = false, recomputedRoot = '';
  if (leafHashes.length > 0) {
    recomputedRoot = bytesToHex(await mth(leafHashes));
    rootOk = recomputedRoot === bundle.trace_receipt.merkle_root;
  }
  let traceSigOk = false;
  if (publicKey) { try { traceSigOk = await verifyDoc(bundle.trace_receipt, 'proof', publicKey); } catch { traceSigOk = false; } }
  let traceExecOk = false;
  if (bundle.trace_receipt.policy_parameters && bundle.trace_receipt.output_payload) {
    const recheckHash = await executionHash(bundle.trace_receipt.policy_parameters, bundle.trace_receipt.output_payload);
    traceExecOk = recheckHash === bundle.trace_receipt.execution_hash;
  }

  return {
    findings, counts,
    merkle: { ok: rootOk, recomputed_root: recomputedRoot, stated_root: bundle.trace_receipt.merkle_root },
    trace_receipt_signature_ok: traceSigOk, trace_receipt_exec_hash_ok: traceExecOk,
    issuer_did: issuerDid, span_count_in_trace: spans.length, receipt_count_in_bundle: bundle.span_receipts.length,
    overall_valid: rootOk && traceSigOk && traceExecOk && counts.tampered === 0,
  };
}

/* ══════════════════════════════════════════════════════════════
   OTel <-> OCG bridge (the PC-7.c mapping made live): wraps a
   run_chain result (server/auto compute mode) as an OTLP/JSON
   trace, one execute_tool span per successfully-executed step,
   each carrying its own execution_hash as a span attribute --
   so a chain's ChainGraph proof and its OTel trace share the
   same execution_hash values and can be cross-checked.
══════════════════════════════════════════════════════════════ */
function randHex(nBytes) {
  const b = new Uint8Array(nBytes); globalThis.crypto.getRandomValues(b);
  return Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('');
}
function nanoNow(offsetMs) { return (BigInt(Date.now() + (offsetMs || 0)) * 1000000n).toString(); }
function sv(s) { return { stringValue: String(s) }; }
function attr(key, value) { return { key, value }; }

/**
 * chainRunToOtlpTrace(runChainResult, { service }) -> OTLP/JSON trace doc.
 * runChainResult: the structuredContent returned by run_chain (must have chain + steps[]).
 * Only steps with status "ok" become spans (same discipline as intoto.mjs's recordChainRunAsLinks).
 */
export function chainRunToOtlpTrace(runChainResult, opts = {}) {
  if (!runChainResult || typeof runChainResult !== 'object') throw new Error('runChainResult must be the object returned by run_chain');
  const chainName = runChainResult.chain;
  if (!chainName) throw new Error('runChainResult.chain is required');
  const allSteps = Array.isArray(runChainResult.steps) ? runChainResult.steps : [];
  const ranSteps = allSteps.filter((s) => s.status === 'ok');
  const skipped = allSteps.filter((s) => s.status !== 'ok').map((s) => ({ tool_id: s.tool_id, status: s.status }));
  if (ranSteps.length === 0) throw new Error('No successfully-executed steps to trace (see skipped[] for why).');

  const traceId = randHex(16);
  const rootSpanId = randHex(8);
  const t0 = nanoNow(0);
  const service = opts.service || 'ainumbers-chaingraph-worker';

  const spans = [{
    traceId, spanId: rootSpanId, name: `invoke_agent ${chainName}`, kind: 'SPAN_KIND_INTERNAL',
    startTimeUnixNano: t0, endTimeUnixNano: nanoNow(10 * (ranSteps.length + 1)),
    attributes: [
      attr('gen_ai.operation.name', sv('invoke_agent')),
      attr('gen_ai.system', sv('ainumbers-chaingraph')),
      attr('gen_ai.agent.name', sv(chainName)),
    ],
    status: { code: 'STATUS_CODE_OK' },
  }];

  ranSteps.forEach((step, i) => {
    spans.push({
      traceId, spanId: randHex(8), parentSpanId: rootSpanId, name: `execute_tool ${step.tool_id}`, kind: 'SPAN_KIND_INTERNAL',
      startTimeUnixNano: nanoNow(10 * (i + 1)), endTimeUnixNano: nanoNow(10 * (i + 2)),
      attributes: [
        attr('gen_ai.operation.name', sv('execute_tool')),
        attr('gen_ai.system', sv('ainumbers-chaingraph')),
        attr('gen_ai.tool.name', sv(step.tool_id)),
        attr('ocg.execution_hash', sv(step.execution_hash)),
      ],
      status: { code: 'STATUS_CODE_OK' },
    });
  });

  return {
    trace: {
      resourceSpans: [{
        resource: { attributes: [attr('service.name', sv(service)), attr('telemetry.sdk.name', sv('ainumbers-otelspan-worker'))] },
        scopeSpans: [{ scope: { name: 'ainumbers.otelspan-worker', version: '1.0.0' }, spans }],
      }],
    },
    chain: chainName,
    step_count: ranSteps.length,
    skipped,
  };
}
