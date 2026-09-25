#!/usr/bin/env node
// gate-error-registry.selftest.mjs — proves gate-error-registry.mjs can actually FAIL.
//
// SO #34c (same discipline as gate-hash-ssot.selftest.mjs): a gate that has only ever been
// observed green has not been observed at all. This selftest feeds the gate's OWN rule functions
// (auditSource / auditErrorsModule — imported, never re-typed) fixtures that each re-introduce a
// defect the registry exists to prevent, and fails if any of them is accepted. It then runs the
// gate against the REAL tree and expects GREEN — one run shows both "the gate can fail" and
// "the tree passes it".
//
// Spec §4.3 requires at minimum: (a) a live construction site with no baseline entry → RED,
// (b) a second -32029 emitter → RED, (c) the real tree → GREEN. Every case below names the rule
// id that must fire.
//
// SO #34 security rider: fixtures are inert strings; nothing is evaluated.
//
// Run: node scripts/gate-error-registry.selftest.mjs

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { auditSource, auditErrorsModule, setRegistryNames } from './gate-error-registry.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// The registry names, from the real module (single source of truth — never re-typed).
setRegistryNames((await import(pathToFileURL(resolve(ROOT, 'errors.mjs')).href)).PROTOCOL_ERRORS);

const BASELINE_SERVER = [{ file: 'server.mjs', line: 3, code: -32601 }];

// A worker.mjs slice that SATISFIES every rule — the clean control. Registry-built sites, the
// tool builder sourcing code/message from the TOOL_ERRORS registry with the additive
// structuredContent member, the request_id blob on the tool datum and NOT on the initialize datum.
const CLEAN_WORKER = `import { mintRequestId, protocolErrorResponse, TOOL_ERRORS } from './errors.mjs';
function ijsonErrorResult(detail, where) {
  const out = {
    error: {
      code: TOOL_ERRORS['tool.ijson_violation'].code,
      message: TOOL_ERRORS['tool.ijson_violation'].message,
      data: { reason: 'ijson_violation', where, detail },
    },
  };
  const structuredContent = requestId != null ? { ...out, error: { ...out.error, request_id: requestId } } : out;
  return { isError: true, content: [{ type: 'text', text: JSON.stringify(out, null, 2) }], structuredContent };
}
function handler(request) {
  const requestId = mintRequestId();
  if (bad) return protocolErrorResponse('protocol.parse_error', { requestId, headers: corsHeaders });
  if (limited) return protocolErrorResponse('protocol.rate_limited', { requestId, headers: corsHeaders });
  env.ANALYTICS.writeDataPoint({
    blobs:   [toolName, asn, success ? 'ok' : 'error', 'ainumbers-mcp', requestId],
  });
}
`;
const CLEAN_SERVER = `app.post('/mcp', (req, res) => {
  res.status(405).json({
    jsonrpc: '2.0', error: { code: -32601, message: 'Method Not Allowed: guidance' }, id: null,
  });
});
`;

const INLINE_BAD = `return new Response(JSON.stringify({ jsonrpc: '2.0', error: { code: -32600, message: 'nope' }, id: null }));`;
const lineOfIn = (src, needle) => src.slice(0, src.indexOf(needle)).split('\n').length;

// Each mutant re-introduces a defect a different way. `expect` names the rule id that must fire
// (null = negative control: must stay legal).
const MUTANTS = [
  {
    name: 'spec §4.3a: a live inline construction site with NO baseline entry',
    expect: 'unregistered-construction',
    sources: { 'worker.mjs': CLEAN_WORKER + INLINE_BAD + '\n' },
  },
  {
    name: 'the deleted hand-rolled helper reintroduced',
    expect: 'unregistered-construction',
    sources: { 'worker.mjs': CLEAN_WORKER + `return mcpJsonRpcErrorResponse(body.id, -32602, 'Tool not found: x', cors, 200);\n` },
  },
  {
    name: 'the same inline shape WITH a matching baseline entry is absorbed (baseline mechanism works)',
    expect: null,
    sources: { 'worker.mjs': CLEAN_WORKER + INLINE_BAD + '\n', 'server.mjs': CLEAN_SERVER },
    baseline: [{ file: 'worker.mjs', line: lineOfIn(CLEAN_WORKER + INLINE_BAD, "error: { code: -32600"), code: -32600 }, ...BASELINE_SERVER],
  },
  {
    name: 'spec §4.3b: -32029 minted OUTSIDE errors.mjs (a second emitter)',
    expect: 'frozen-code-outside-registry',
    sources: { 'worker.mjs': CLEAN_WORKER + `const echoed = -32029;\n` },
  },
  {
    name: '-32001 minted outside errors.mjs (the "restored" header-mismatch mapping)',
    expect: 'frozen-code-outside-registry',
    sources: { 'worker.mjs': CLEAN_WORKER + `const legacy = -32001;\n` },
  },
  {
    name: 'an inline error.data.reason literal other than ijson_violation',
    expect: 'data-reason-literal',
    sources: { 'worker.mjs': CLEAN_WORKER + `const out = { error: { code: -32602, message: 'm', data: { reason: 'validation_failed' } } };\n` },
  },
  {
    name: 'the request_id blob dropped from the tool Analytics datum',
    expect: 'request_id-analytics-blob-missing',
    sources: { 'worker.mjs': CLEAN_WORKER.replace("'ainumbers-mcp', requestId],", "'ainumbers-mcp'],") },
  },
  {
    name: 'the initialize Analytics datum gained a request_id blob (spec §3: initialize unchanged)',
    expect: 'initialize-datum-changed',
    sources: { 'worker.mjs': CLEAN_WORKER + `env.ANALYTICS.writeDataPoint({ blobs: ['initialize', clientName, clientVersion, 'ainumbers-mcp', userAgent, asn, requestId] });\n` },
  },
  {
    name: 'a typoed registry name (would throw at request time)',
    expect: 'unregistered-name',
    sources: { 'worker.mjs': CLEAN_WORKER + `return protocolErrorResponse('protocol.rate_limted', { requestId });\n` },
  },
  {
    name: 'a baseline entry whose anchored line no longer carries the wire code',
    expect: 'stale-baseline-anchor',
    baseline: [{ file: 'server.mjs', line: 4, code: -32603 }, ...BASELINE_SERVER],
  },
  {
    name: 'negative control: the defect QUOTED in a comment stays legal',
    expect: null,
    sources: { 'worker.mjs': CLEAN_WORKER + `// History: this used to be an inline JSON.stringify({ jsonrpc: '2.0', error: { code: -32600, ... } }) literal.\n`, 'server.mjs': CLEAN_SERVER },
  },
];

// Mutants for the REGISTRY MODULE's own source (auditErrorsModule).
const ERRORS_MUTANTS = [
  {
    name: 'errors.mjs: request_id member stripped from protocolErrorBody',
    expect: 'request_id-envelope-missing',
    src: `export function protocolErrorBody(name, opts) {\n  return { jsonrpc: '2.0', id, error: { code, message } };\n}\n`,
  },
  {
    name: 'errors.mjs: the frozen -32029 literal removed from the registry',
    expect: 'registry-frozen-code-missing',
    src: `export const PROTOCOL_ERRORS = { 'protocol.rate_limited': { code: -32600 } };\nconst a = -32001; const b = -32020;\n`,
  },
  {
    name: 'errors.mjs: the `Tool not found:` prefix reworded',
    expect: 'registry-message-drift',
    src: `export const PROTOCOL_ERRORS = { 'protocol.tool_not_found.zero_tools': { code: -32602, message: (v) => 'Unknown tool: ' + v.toolName } };\nconst codes = { a: -32029, b: -32001, c: -32020 };\nconst keep1 = 'Header mismatch: '; const keep2 = 'Server timeout'; const keep3 = 'Internal error'; const keep4 = 'Rate limit exceeded. Wait and retry.'; const keep5 = 'ijson_violation';\n`,
  },
  {
    name: 'errors.mjs: error.data.reason re-typed away from ijson_violation',
    expect: 'registry-message-drift',
    src: `export const PROTOCOL_ERRORS = {};\nconst codes = { a: -32029, b: -32001, c: -32020 };\nexport const TOOL_ERRORS = { 'tool.ijson_violation': { reason: 'invalid_json' } };\nconst keep1 = 'Tool not found: '; const keep2 = 'Header mismatch: '; const keep3 = 'Server timeout'; const keep4 = 'Internal error'; const keep5 = 'Rate limit exceeded. Wait and retry.';\n`,
  },
];

function main() {
  let fail = 0;
  const rows = [];

  // 1. The clean control must be ACCEPTED.
  const cleanViolations = auditSource({ 'worker.mjs': CLEAN_WORKER, 'server.mjs': CLEAN_SERVER }, { baseline: BASELINE_SERVER });
  if (cleanViolations.length) {
    fail++;
    rows.push({ ok: false, name: 'clean control accepted', note: 'rejected with: ' + cleanViolations.map((v) => `${v.id}@${v.file}:${v.line}`).join(', ') });
  } else {
    rows.push({ ok: true, name: 'clean control accepted', note: 'no violations' });
  }

  // 2. Every tree mutant must be REJECTED by the specific rule it was built to trip.
  for (const m of MUTANTS) {
    const violations = auditSource(m.sources ?? { 'worker.mjs': CLEAN_WORKER, 'server.mjs': CLEAN_SERVER }, { baseline: m.baseline ?? BASELINE_SERVER });
    const ids = violations.map((v) => v.id);
    if (m.expect === null) {
      const ok = violations.length === 0;
      if (!ok) fail++;
      rows.push({ ok, name: m.name, note: ok ? 'correctly accepted' : 'FALSE POSITIVE: ' + ids.join(', ') });
      continue;
    }
    const ok = ids.includes(m.expect);
    if (!ok) fail++;
    rows.push({ ok, name: m.name, note: ok ? `rejected by ${m.expect}` : `NOT rejected by ${m.expect} (got: ${ids.join(', ') || 'nothing'})` });
  }

  // 3. Every registry-module mutant must be REJECTED too.
  for (const m of ERRORS_MUTANTS) {
    const ids = auditErrorsModule(m.src).map((v) => v.id);
    const ok = ids.includes(m.expect);
    if (!ok) fail++;
    rows.push({ ok, name: m.name, note: ok ? `rejected by ${m.expect}` : `NOT rejected by ${m.expect} (got: ${ids.join(', ') || 'nothing'})` });
  }

  // 4. The REAL tree must be clean — the RED-then-GREEN second half, reported in the same run.
  const baseline = JSON.parse(readFileSync(resolve(ROOT, 'scripts', 'error-registry.baseline.json'), 'utf8')).sites;
  const live = [
    ...auditErrorsModule(readFileSync(resolve(ROOT, 'errors.mjs'), 'utf8')),
    ...auditSource(
      { 'worker.mjs': readFileSync(resolve(ROOT, 'worker.mjs'), 'utf8'), 'server.mjs': readFileSync(resolve(ROOT, 'server.mjs'), 'utf8') },
      { baseline },
    ),
  ];
  if (live.length) { fail++; rows.push({ ok: false, name: 'live tree clean (worker.mjs + server.mjs + errors.mjs)', note: live.map((v) => `${v.id}@${v.file}:${v.line}`).join(', ') }); }
  else rows.push({ ok: true, name: 'live tree clean (worker.mjs + server.mjs + errors.mjs)', note: 'no violations' });

  console.log('\n════ gate-error-registry selftest (mutation) ════');
  for (const r of rows) console.log(`  ${r.ok ? '✓' : '✗'} ${r.name} — ${r.note}`);
  console.log('');

  if (fail) {
    console.error(`✗ gate-error-registry.selftest: ${fail} case(s) failed — the registry gate does not reliably distinguish an unregistered error construction from a registry-built one, so its green means nothing.`);
    process.exit(1);
  }
  console.log(`✅ gate-error-registry.selftest: ${MUTANTS.length + ERRORS_MUTANTS.length} mutants classified correctly + clean control accepted + live tree clean. The gate is load-bearing.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
