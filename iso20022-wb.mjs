// iso20022-wb.mjs — IW-4 shared logic for the worker's ISO 20022 workbench MCP tools.
// Same field tables / facet checks / cross-checks as tools/555-iso20022-schema-subset-validator.html
// (IW-1) and the same statement-parse + match-engine as tools/565-camt053-reconciliation-workbench.html
// (IW-3) — ported here (not imported: those are inlined, zero-dependency browser surfaces by design,
// same discipline as redline.mjs/checkrun.mjs). Byte-identical results to the browser tools for the
// same inputs is the "parity browser/worker on fixtures" done-criterion in ISO20022-WB-1-BUILD-SPEC.md §IW-4.
//
// Cloudflare Workers has no DOMParser, so XML is parsed with a small hand-rolled recursive-descent
// parser (parseXmlDocument below) rather than pulling in a dependency — sufficient for the well-formed
// pain.001/camt.053 documents these tools validate (no CDATA, no processing instructions besides the
// leading <?xml ... ?> declaration). Reuses the vendored workbook/workbook.mjs CSV parser (WB-1, verbatim)
// for the expectations CSV, same reuse discipline as tools/565 pairing with WORKBOOK-1.
//
// Reuses the vendored kernels/_hash.mjs canonicalizer — no second canonicalization path.
//
// ⚠⚠ HARD FENCE — SPEC §8: these tools do NOT generate or transmit LIVE ISO 20022 messages.
// prepare + validate + hash + receipt only.
//
// Doctrine fence: pure functions over caller-supplied text. No server state, no storage.
import { executionHash } from './kernels/_hash.mjs';
import { parseCSV } from './workbook/workbook.mjs';

// ─────────────────────────────────────────────────────────────────────────
// Minimal XML parser — element tree with .tagName, .attrs, .children, .text
// (direct text only; textContent() below concatenates descendants like DOM).
// ─────────────────────────────────────────────────────────────────────────
function decodeEntities(s) {
  return s.replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

export class XmlParseError extends Error {}

export function parseXmlDocument(xmlText) {
  if (typeof xmlText !== 'string' || !xmlText.trim()) throw new XmlParseError('XML input must be a non-empty string');
  let s = xmlText.replace(/<\?xml[^?]*\?>/, '');
  let i = 0;
  const n = s.length;
  const isWs = (c) => c === ' ' || c === '\t' || c === '\r' || c === '\n';
  function skipWs() { while (i < n && isWs(s[i])) i++; }
  function parseNode() {
    skipWs();
    if (i >= n || s[i] !== '<') throw new XmlParseError(`expected '<' at position ${i}`);
    if (s.slice(i, i + 4) === '<!--') { const end = s.indexOf('-->', i); if (end === -1) throw new XmlParseError('unterminated comment'); i = end + 3; return null; }
    if (s.slice(i, i + 9) === '<![CDATA[') { const end = s.indexOf(']]>', i); if (end === -1) throw new XmlParseError('unterminated CDATA'); const cdata = s.slice(i + 9, end); i = end + 3; return { text: cdata }; }
    i++; // consume '<'
    const nameStart = i;
    while (i < n && !isWs(s[i]) && s[i] !== '/' && s[i] !== '>') i++;
    if (i === nameStart) throw new XmlParseError(`malformed tag at position ${i}`);
    const tagName = s.slice(nameStart, i);
    const attrs = {};
    while (true) {
      skipWs();
      if (i >= n) throw new XmlParseError('unterminated tag');
      if (s[i] === '/' || s[i] === '>') break;
      const attrNameStart = i;
      while (i < n && s[i] !== '=' && !isWs(s[i]) && s[i] !== '/' && s[i] !== '>') i++;
      const attrName = s.slice(attrNameStart, i);
      skipWs();
      if (s[i] === '=') {
        i++; skipWs();
        const quote = s[i];
        if (quote !== '"' && quote !== "'") throw new XmlParseError(`expected quoted attribute value at position ${i}`);
        i++;
        const valStart = i;
        while (i < n && s[i] !== quote) i++;
        if (i >= n) throw new XmlParseError('unterminated attribute value');
        attrs[attrName] = decodeEntities(s.slice(valStart, i));
        i++;
      } else if (attrName) {
        attrs[attrName] = '';
      } else {
        break;
      }
    }
    if (s[i] === '/') {
      i++;
      if (s[i] !== '>') throw new XmlParseError(`expected '>' after '/' at position ${i}`);
      i++;
      return { tagName, attrs, children: [], text: '' };
    }
    i++; // consume '>'
    const children = [];
    let text = '';
    while (true) {
      if (i >= n) throw new XmlParseError(`unterminated element <${tagName}>`);
      if (s.slice(i, i + 2) === '</') {
        i += 2;
        const closeStart = i;
        while (i < n && s[i] !== '>') i++;
        const closeName = s.slice(closeStart, i);
        if (closeName !== tagName) throw new XmlParseError(`mismatched closing tag </${closeName}> for <${tagName}>`);
        i++;
        break;
      }
      if (s[i] === '<') {
        const node = parseNode();
        if (node === null) continue; // comment
        if ('text' in node && !('tagName' in node)) { text += node.text; continue; } // CDATA
        children.push(node);
      } else {
        const textStart = i;
        while (i < n && s[i] !== '<') i++;
        text += decodeEntities(s.slice(textStart, i));
      }
    }
    return { tagName, attrs, children, text: text.trim() };
  }
  const root = parseNode();
  skipWs();
  if (i < n) throw new XmlParseError(`unexpected trailing content at position ${i}`);
  return root;
}

function localName(el) { return el.tagName.includes(':') ? el.tagName.split(':').pop() : el.tagName; }
function textContent(el) {
  let out = el.text || '';
  for (const c of el.children) out += textContent(c);
  return out;
}
function getAttribute(el, name) { return Object.prototype.hasOwnProperty.call(el.attrs, name) ? el.attrs[name] : null; }

// Same traversal semantics as the browser tools' queryPath: strict one-level-per-segment
// descent by local name, with an optional trailing '@AttrName' for an attribute lookup.
function queryPath(root, pathStr) {
  const segs = pathStr.split('/').slice();
  let attrName = null;
  const last = segs[segs.length - 1];
  if (last.indexOf('@') !== -1) {
    const parts = last.split('@');
    segs[segs.length - 1] = parts[0];
    attrName = parts[1];
  }
  let nodes = [root];
  for (const seg of segs) {
    if (!seg) continue;
    const next = [];
    for (const node of nodes) {
      for (const c of node.children) {
        if (localName(c) === seg) next.push(c);
      }
    }
    nodes = next;
  }
  if (attrName) return nodes.map((n) => getAttribute(n, attrName)).filter((v) => v !== null);
  return nodes.map((n) => textContent(n).trim());
}

// ─────────────────────────────────────────────────────────────────────────
// Schema-subset field tables + facet checks — verbatim from IW-1 (tools/555).
// ─────────────────────────────────────────────────────────────────────────
const IBAN_RE = /^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$/;
const BIC_RE = /^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/;
const DECIMAL_RE = /^\d+(\.\d{1,5})?$/;
const CODE_RE = /^[A-Z0-9]{2,4}$/;

const ISO4217_SUBSET = ['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'CNY', 'INR', 'SGD', 'HKD', 'SEK', 'NOK', 'DKK', 'NZD', 'MXN', 'BRL', 'ZAR', 'AED', 'SAR'];
const ISO3166_SUBSET = ['US', 'GB', 'DE', 'FR', 'JP', 'CN', 'CA', 'AU', 'IN', 'SG', 'HK', 'CH', 'NL', 'ES', 'IT', 'BR', 'MX', 'ZA', 'AE', 'SE'];

const PAIN001_FIELDS = [
  { path: 'GrpHdr/MsgId', type: 'Max35Text', maxLength: 35, mandatory: true },
  { path: 'GrpHdr/CreDtTm', type: 'ISODateTime', pattern: DATETIME_RE, mandatory: true },
  { path: 'GrpHdr/NbOfTxs', type: 'Max15NumericText', pattern: /^[0-9]{1,15}$/, mandatory: true },
  { path: 'GrpHdr/CtrlSum', type: 'DecimalNumber', pattern: DECIMAL_RE, mandatory: false },
  { path: 'GrpHdr/InitgPty/Nm', type: 'Max140Text', maxLength: 140, mandatory: false },
  { path: 'PmtInf/PmtInfId', type: 'Max35Text', maxLength: 35, mandatory: true },
  { path: 'PmtInf/PmtMtd', type: 'PaymentMethod3Code', pattern: /^(TRF|CHK|TRA)$/, mandatory: true },
  { path: 'PmtInf/ReqdExctnDt/Dt', type: 'ISODate', pattern: DATE_RE, mandatory: true },
  { path: 'PmtInf/Dbtr/Nm', type: 'Max140Text', maxLength: 140, mandatory: true },
  { path: 'PmtInf/DbtrAcct/Id/IBAN', type: 'IBAN2007Identifier', pattern: IBAN_RE, facet: 'iban', mandatory: true },
  { path: 'PmtInf/DbtrAgt/FinInstnId/BICFI', type: 'BICFIDec2014Identifier', pattern: BIC_RE, mandatory: true },
  { path: 'PmtInf/CdtTrfTxInf/PmtId/EndToEndId', type: 'Max35Text', maxLength: 35, mandatory: true },
  { path: 'PmtInf/CdtTrfTxInf/Amt/InstdAmt', type: 'ActiveCurrencyAndAmount', pattern: DECIMAL_RE, facet: 'amount', mandatory: true },
  { path: 'PmtInf/CdtTrfTxInf/Amt/InstdAmt@Ccy', type: 'ActiveCurrencyCode', facet: 'ccy', mandatory: true },
  { path: 'PmtInf/CdtTrfTxInf/CdtrAgt/FinInstnId/BICFI', type: 'BICFIDec2014Identifier', pattern: BIC_RE, mandatory: false },
  { path: 'PmtInf/CdtTrfTxInf/Cdtr/Nm', type: 'Max140Text', maxLength: 140, mandatory: true },
  { path: 'PmtInf/CdtTrfTxInf/Cdtr/PstlAdr/Ctry', type: 'CountryCode', facet: 'ctry', mandatory: false },
  { path: 'PmtInf/CdtTrfTxInf/CdtrAcct/Id/IBAN', type: 'IBAN2007Identifier', pattern: IBAN_RE, facet: 'iban', mandatory: true },
  { path: 'PmtInf/CdtTrfTxInf/RmtInf/Ustrd', type: 'Max140Text', maxLength: 140, mandatory: false },
  { path: 'PmtInf/CdtTrfTxInf/Purp/Cd', type: 'ExternalPurpose1Code', pattern: CODE_RE, mandatory: false },
];

const CAMT053_FIELDS = [
  { path: 'GrpHdr/MsgId', type: 'Max35Text', maxLength: 35, mandatory: true },
  { path: 'GrpHdr/CreDtTm', type: 'ISODateTime', pattern: DATETIME_RE, mandatory: true },
  { path: 'Stmt/Id', type: 'Max35Text', maxLength: 35, mandatory: true },
  { path: 'Stmt/ElctrncSeqNb', type: 'Number', pattern: /^[0-9]+$/, mandatory: false },
  { path: 'Stmt/CreDtTm', type: 'ISODateTime', pattern: DATETIME_RE, mandatory: false },
  { path: 'Stmt/Acct/Id/IBAN', type: 'IBAN2007Identifier', pattern: IBAN_RE, facet: 'iban', mandatory: true },
  { path: 'Stmt/Acct/Ccy', type: 'ActiveCurrencyCode', facet: 'ccy', mandatory: true },
  { path: 'Stmt/Bal/Tp/CdOrPrtry/Cd', type: 'BalanceType12Code', pattern: /^(OPBD|CLBD|ITBD|CLAV|OPAV|FWAV|PRCD|INFO)$/, mandatory: true },
  { path: 'Stmt/Bal/Amt', type: 'ActiveOrHistoricCurrencyAndAmount', pattern: DECIMAL_RE, facet: 'amount', mandatory: true },
  { path: 'Stmt/Bal/Amt@Ccy', type: 'ActiveOrHistoricCurrencyCode', facet: 'ccy', mandatory: true },
  { path: 'Stmt/Bal/CdtDbtInd', type: 'CreditDebitCode', pattern: /^(CRDT|DBIT)$/, mandatory: true },
  { path: 'Stmt/Bal/Dt/Dt', type: 'ISODate', pattern: DATE_RE, mandatory: true },
  { path: 'Stmt/Ntry/Amt', type: 'ActiveOrHistoricCurrencyAndAmount', pattern: DECIMAL_RE, facet: 'amount', mandatory: true },
  { path: 'Stmt/Ntry/CdtDbtInd', type: 'CreditDebitCode', pattern: /^(CRDT|DBIT)$/, mandatory: true },
  { path: 'Stmt/Ntry/Sts/Cd', type: 'EntryStatus1Code', pattern: /^(BOOK|PDNG|INFO)$/, mandatory: true },
  { path: 'Stmt/Ntry/BookgDt/Dt', type: 'ISODate', pattern: DATE_RE, mandatory: false },
  { path: 'Stmt/Ntry/NtryDtls/TxDtls/Refs/EndToEndId', type: 'Max35Text', maxLength: 35, mandatory: false },
];

function ibanValid(v) {
  const s = v.replace(/\s+/g, '').toUpperCase();
  if (!IBAN_RE.test(s)) return false;
  const rearr = s.slice(4) + s.slice(0, 4);
  const expanded = rearr.replace(/[A-Z]/g, (c) => (c.charCodeAt(0) - 55).toString());
  let rem = 0;
  for (let i = 0; i < expanded.length; i++) rem = (rem * 10 + parseInt(expanded[i], 10)) % 97;
  return rem === 1;
}

function validateGeneric(root, table) {
  const errors = [];
  table.forEach((f) => {
    const vals = queryPath(root, f.path);
    if (f.mandatory && vals.length === 0) {
      errors.push({ path: f.path, rule: 'mandatory', msg: 'Missing mandatory field', fix: 'Add an element at ' + f.path });
      return;
    }
    vals.forEach((v) => {
      if (f.maxLength && v.length > f.maxLength) {
        errors.push({ path: f.path, rule: 'maxLength', msg: 'Value exceeds ' + f.type + ' maxLength ' + f.maxLength + ' (' + v.length + ' chars)', fix: 'Shorten to ' + f.maxLength + ' characters or fewer' });
      }
      if (f.pattern && !f.pattern.test(v)) {
        errors.push({ path: f.path, rule: 'pattern', msg: 'Value "' + v + '" does not match ' + f.type + ' facet pattern', fix: 'Conform to the ' + f.type + ' pattern' });
      }
      if (f.facet === 'iban' && IBAN_RE.test(v) && !ibanValid(v)) {
        errors.push({ path: f.path, rule: 'iban-mod97', msg: 'IBAN "' + v + '" fails the mod-97 checksum', fix: 'Re-check the IBAN digits: checksum does not validate' });
      }
      if (f.facet === 'ccy' && CODE_RE.test(v) && !ISO4217_SUBSET.includes(v)) {
        errors.push({ path: f.path, rule: 'iso4217', msg: 'Currency code "' + v + '" not in the embedded ISO 4217 subset', fix: 'Use a recognised ISO 4217 alphabetic code' });
      }
      if (f.facet === 'ctry' && !ISO3166_SUBSET.includes(v)) {
        errors.push({ path: f.path, rule: 'iso3166', msg: 'Country code "' + v + '" not in the embedded ISO 3166-1 subset', fix: 'Use a recognised ISO 3166-1 alpha-2 code' });
      }
    });
  });
  return errors;
}

function crossCheckPain001(root) {
  const errors = [];
  const nbOfTxsVals = queryPath(root, 'GrpHdr/NbOfTxs');
  const ctrlSumVals = queryPath(root, 'GrpHdr/CtrlSum');
  const amts = queryPath(root, 'PmtInf/CdtTrfTxInf/Amt/InstdAmt');
  const actualCount = amts.length;
  const numericAmts = amts.map((a) => parseFloat(a)).filter((v) => !isNaN(v));
  const actualSum = numericAmts.reduce((a, v) => a + v, 0);
  if (nbOfTxsVals.length && !isNaN(parseInt(nbOfTxsVals[0], 10))) {
    const stated = parseInt(nbOfTxsVals[0], 10);
    if (stated !== actualCount) {
      errors.push({ path: 'GrpHdr/NbOfTxs', rule: 'batch-count', msg: 'NbOfTxs states ' + stated + ' but ' + actualCount + ' CdtTrfTxInf transaction(s) are present', fix: 'Set NbOfTxs to the actual transaction count, ' + actualCount });
    }
  }
  if (ctrlSumVals.length && numericAmts.length === amts.length) {
    const stated = parseFloat(ctrlSumVals[0]);
    if (!isNaN(stated) && Math.abs(stated - actualSum) > 0.005) {
      errors.push({ path: 'GrpHdr/CtrlSum', rule: 'batch-ctrlsum', msg: 'CtrlSum states ' + stated.toFixed(2) + ' but the sum of InstdAmt is ' + actualSum.toFixed(2), fix: 'Set CtrlSum to the actual sum of instructed amounts' });
    }
  }
  return errors;
}

// ─────────────────────────────────────────────────────────────────────────
// pain001_validate — parity with tools/555 (pain.001.001.09 tab).
// ─────────────────────────────────────────────────────────────────────────
export function validatePain001(xmlText) {
  let root;
  try { root = parseXmlDocument(xmlText); }
  catch (e) { return { valid: false, message_type: 'pain.001.001.09', errors: [], parse_error: e.message }; }
  // FIELD_TABLES paths are relative to the message root (CstmrCdtTrfInitn), one level
  // below <Document> — see tools/555 fix (T564 review, 2026-07-21): msgRoot = root.children[0].
  const msgRoot = root.children[0] || root;
  const errors = validateGeneric(msgRoot, PAIN001_FIELDS).concat(crossCheckPain001(msgRoot));
  return { valid: errors.length === 0, message_type: 'pain.001.001.09', errors, parse_error: null };
}

// ─────────────────────────────────────────────────────────────────────────
// camt053_parse — parity with tools/565 parseStatement (structural validation +
// extraction of msgId/stmtId/iban/ccy/balances/entries).
// ─────────────────────────────────────────────────────────────────────────
export function parseCamt053(xmlText) {
  let root;
  try { root = parseXmlDocument(xmlText); }
  catch (e) { return { ok: false, parse_error: e.message, errors: [], statement: null }; }
  const structuralErrors = validateGeneric(root.children[0] || root, CAMT053_FIELDS);
  if (structuralErrors.length) {
    return { ok: false, parse_error: null, errors: structuralErrors, statement: null };
  }
  const msgId = queryPath(root, 'GrpHdr/MsgId')[0];
  const stmtId = queryPath(root, 'Stmt/Id')[0];
  const iban = queryPath(root, 'Stmt/Acct/Id/IBAN')[0];
  const ccy = queryPath(root, 'Stmt/Acct/Ccy')[0];

  let stmtNode = null;
  for (const cstmr of root.children) {
    for (const c of cstmr.children) { if (localName(c) === 'Stmt') stmtNode = c; }
  }
  const balEls = stmtNode.children.filter((c) => localName(c) === 'Bal');
  const ntryEls = stmtNode.children.filter((c) => localName(c) === 'Ntry');

  function balInfo(el) {
    const cd = queryPath(el, 'Tp/CdOrPrtry/Cd')[0];
    const amt = parseFloat(queryPath(el, 'Amt')[0]);
    const ind = queryPath(el, 'CdtDbtInd')[0];
    return { cd, signed: ind === 'DBIT' ? -amt : amt };
  }
  const balances = balEls.map(balInfo);

  const entries = ntryEls.map((n, idx) => {
    const amt = parseFloat(queryPath(n, 'Amt')[0]);
    const ind = queryPath(n, 'CdtDbtInd')[0];
    const bookgDt = queryPath(n, 'BookgDt/Dt')[0] || null;
    const e2e = queryPath(n, 'NtryDtls/TxDtls/Refs/EndToEndId')[0] || null;
    return { index: idx, endToEndId: e2e, amount: ind === 'DBIT' ? -amt : amt, ccy, date: bookgDt };
  });

  return { ok: true, parse_error: null, errors: [], statement: { msgId, stmtId, iban, ccy, balances, entries } };
}

// ─────────────────────────────────────────────────────────────────────────
// recon_match — parity with tools/565 parseExpectations + matchEntries +
// the reconciliation receipt (no per-disposition step here; that's the
// browser workbench's interactive follow-on, same as redline's diff/verify split).
// ─────────────────────────────────────────────────────────────────────────
function parseExpectations(csvText) {
  const rows = parseCSV(csvText).filter((r) => r.length && r.some((c) => c !== ''));
  if (!rows.length) throw new Error('Expectations CSV is empty.');
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const idxE2E = header.indexOf('endtoendid'), idxAmt = header.indexOf('amount'), idxCcy = header.indexOf('currency'), idxDate = header.indexOf('date');
  if (idxE2E === -1 || idxAmt === -1 || idxCcy === -1 || idxDate === -1) throw new Error('Expectations CSV header must be EndToEndId,Amount,Currency,Date');
  return rows.slice(1).map((r, idx) => ({ index: idx, endToEndId: r[idxE2E] || null, amount: parseFloat(r[idxAmt]), ccy: r[idxCcy], date: r[idxDate] }));
}

function daysBetween(a, b) {
  if (!a || !b) return Infinity;
  return Math.abs((new Date(a + 'T00:00:00Z').getTime() - new Date(b + 'T00:00:00Z').getTime()) / 86400000);
}

// Deterministic match: exact EndToEndId first (statement order), then amount+date
// tolerance + currency (statement order, first unmatched expectation in CSV order).
function matchEntries(entries, expectations, amtTol, dateTolDays) {
  const usedExp = new Set();
  const matches = [];
  const unmatchedEntries = [];

  entries.forEach((entry) => {
    if (entry.endToEndId) {
      const hit = expectations.find((x) => !usedExp.has(x.index) && x.endToEndId === entry.endToEndId);
      if (hit) { usedExp.add(hit.index); matches.push({ entry, expectation: hit, rule: 'endtoend_exact' }); return; }
    }
    unmatchedEntries.push(entry);
  });

  const stillUnmatched = [];
  unmatchedEntries.forEach((entry) => {
    const hit = expectations.find((x) => !usedExp.has(x.index) && x.ccy === entry.ccy && Math.abs(x.amount - entry.amount) <= amtTol && daysBetween(x.date, entry.date) <= dateTolDays);
    if (hit) { usedExp.add(hit.index); matches.push({ entry, expectation: hit, rule: 'amount_date_tolerance' }); return; }
    stillUnmatched.push(entry);
  });

  const unmatchedExpectations = expectations.filter((x) => !usedExp.has(x.index));
  return { matches, unmatchedEntries: stillUnmatched, unmatchedExpectations };
}

export async function reconMatch({ statement_xml, expectations_csv, amount_tolerance, date_tolerance_days }) {
  const amtTol = typeof amount_tolerance === 'number' ? amount_tolerance : 0.01;
  const dateTol = typeof date_tolerance_days === 'number' ? date_tolerance_days : 0;

  const parsed = parseCamt053(statement_xml);
  if (!parsed.ok) {
    return { isError: true, error: parsed.parse_error || 'camt.053 failed schema-subset validation: ' + parsed.errors.map((x) => x.path + ' (' + x.rule + ')').join('; ') };
  }
  const statement = parsed.statement;

  let expectations;
  try { expectations = parseExpectations(expectations_csv); }
  catch (e) { return { isError: true, error: e.message }; }

  const { matches, unmatchedEntries, unmatchedExpectations } = matchEntries(statement.entries, expectations, amtTol, dateTol);
  const exceptions = [
    ...unmatchedEntries.map((e) => ({ type: 'unmatched_statement_entry', key: 'entry-' + e.index, detail: e })),
    ...unmatchedExpectations.map((e) => ({ type: 'unmatched_expectation', key: 'expectation-' + e.index, detail: e })),
  ];

  const statementDigest = await executionHash({ msgId: statement.msgId, stmtId: statement.stmtId, iban: statement.iban, ccy: statement.ccy }, { balances: statement.balances, entries: statement.entries });
  const expectationSetDigest = await executionHash({}, { expectations });
  const matchRuleDeclaration = {
    primary_rule: 'EndToEndId exact match',
    secondary_rule: 'amount tolerance ±' + amtTol + ' + date tolerance ±' + dateTol + ' day(s) + currency match',
    order: 'deterministic — statement-entry order first, expectation CSV order for tie-break',
  };
  const exceptionDigests = [];
  for (const exc of exceptions) exceptionDigests.push(await executionHash({ type: exc.type, key: exc.key }, exc.detail));

  const reconciliationPolicy = { statement_digest: statementDigest, expectation_set_digest: expectationSetDigest, match_rule_declaration: matchRuleDeclaration };
  const reconciliationPayload = { matched_count: matches.length, unmatched_entry_count: unmatchedEntries.length, unmatched_expectation_count: unmatchedExpectations.length, exception_digests: exceptionDigests };
  const execution_hash = await executionHash(reconciliationPolicy, reconciliationPayload);

  return {
    isError: false,
    reconciliation_receipt: { ...reconciliationPolicy, ...reconciliationPayload, execution_hash },
    matches: matches.map((m) => ({ entry_index: m.entry.index, expectation_index: m.expectation.index, rule: m.rule })),
    exceptions,
  };
}
