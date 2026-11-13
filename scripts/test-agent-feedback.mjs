// test-agent-feedback.mjs — WEBMCP-FEEDBACK-COLLECTOR-1 contract test, mocked bindings.
//
// Drives the REAL worker.mjs default export over a local ASSETS stub (the
// test-mcp-limiter-routing.mjs idiom) and proves:
//   * the full POST /feedback response matrix [AF-11]: 202 / 400 (constant validator strings
//     that never echo body content) / 413 over the 2048-byte cap / 405 + Allow: POST / 429;
//   * the two DEDICATED limiters [AF-5]: ns 3003 per-IP + ns 3004 constant-key global are the
//     ONLY limiters /feedback touches — never the shared 3002 'global' bucket, never any /mcp
//     limiter (a feedback flood must not starve /mcp);
//   * PRIVACY (R2): the FEEDBACK datapoint carries the enum fields, tool_name, the optional
//     hashes, the capped agent_label, occurred_at, the collector-derived tool_known, the
//     network ASN and the request size — and NO IP, NO user-agent, NO raw body, NO
//     unknown-member free text;
//   * collector-side tool_name integrity [BF-5]: alias resolution + registered-set membership,
//     never a reporter assertion;
//   * NO CORS surface on /feedback responses;
//   * R5 [BF-1]: the unknown-tool and removed-tool early returns now write datums (previously
//     NOTHING) classified 'unknown_tool' with the SDK-path positional layout + appended blob 6;
//     and classifyToolCallEnvelope's four classes, including the JSON-escaping soundness case;
//   * [BF-2] discovery: the instructions capture, the server-card pointer and the unknown-tool
//     hint all point at the collector.
//
// Run: node scripts/test-agent-feedback.mjs   (AFTER `node generate.mjs` — the vendored twin
// and the regenerated initialize capture are import/asserted here.)

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const DATA_DIR = join(ROOT, 'data');

const assets = {
  fetch: async (url) => {
    const u = new URL(typeof url === 'string' ? url : url.url);
    const filePath = join(DATA_DIR, decodeURIComponent(u.pathname).replace(/^\/+/, ''));
    if (!filePath.startsWith(DATA_DIR)) return new Response('Not Found', { status: 404 });
    try { return new Response(readFileSync(filePath), { status: 200 }); }
    catch { return new Response('Not Found', { status: 404 }); }
  },
};

const mod = await import('../worker.mjs');
const worker = mod.default;
const { classifyToolCallEnvelope } = mod;

let failed = 0;
const check = (label, cond, detail = '') => {
  if (cond) console.log('test-agent-feedback: ' + label + '... ok');
  else { failed++; console.error('test-agent-feedback: ' + label + '... FAIL' + (detail ? ' — ' + detail : '')); }
};

// Mocks with the real binding shapes.
function mockAnalytics(calls) { return { writeDataPoint: (d) => { calls.push(JSON.parse(JSON.stringify(d))); } }; }
function mockFeedback(calls) { return { writeDataPoint: (d) => { calls.push(JSON.parse(JSON.stringify(d))); } }; }
function mockLimiter(rec, name, success = true) {
  return { limit: async ({ key }) => { rec.push({ binding: name, key }); return { success }; } };
}

// waitUntil promises are COLLECTED and awaited, so datapoint assertions are deterministic.
function makeCtx(pending) {
  return {
    waitUntil: (p) => pending.push(Promise.resolve(p).catch(() => {})),
    passThroughOnException: () => {},
  };
}

function makeEnv({ ipOk = true, globalOk = true, feedbackThrows = false } = {}) {
  const rec = { mcp: [], ip: [], glob: [], analytics: [], feedback: [] };
  const env = {
    ASSETS: assets,
    ANALYTICS: mockAnalytics(rec.analytics),
    FEEDBACK: mockFeedback(rec.feedback),
    FEEDBACK_IP_LIMITER: mockLimiter(rec.ip, 'FEEDBACK_IP_LIMITER', ipOk),
    FEEDBACK_GLOBAL_LIMITER: mockLimiter(rec.glob, 'FEEDBACK_GLOBAL_LIMITER', globalOk),
    MCP_PREPARSE_LIMITER: mockLimiter(rec.mcp, 'MCP_PREPARSE_LIMITER'),
    MCP_RATE_LIMITER: mockLimiter(rec.mcp, 'MCP_RATE_LIMITER'),
    MCP_GLOBAL_RATE_LIMITER: mockLimiter(rec.mcp, 'MCP_GLOBAL_RATE_LIMITER'),
    MCP_DISCOVERY_GLOBAL_LIMITER: mockLimiter(rec.mcp, 'MCP_DISCOVERY_GLOBAL_LIMITER'),
    _rec: rec,
  };
  if (feedbackThrows) env.FEEDBACK = { writeDataPoint: () => { throw new Error('simulated AE outage'); } };
  return env;
}

async function drain(pending) { await Promise.all(pending); pending.length = 0; }

async function postFeedback(env, pending, { body, raw, method = 'POST' } = {}) {
  const hasBody = method !== 'GET' && method !== 'HEAD' && (raw !== undefined || body !== undefined);
  const res = await worker.fetch(
    new Request('https://mcp.ainumbers.co/feedback', {
      method,
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.7' },
      ...(hasBody ? { body: raw ?? JSON.stringify(body) } : {}),
    }),
    env,
    makeCtx(pending),
  );
  const text = await res.text();
  let json = {};
  try { json = JSON.parse(text); } catch { /* non-JSON body — asserted raw where needed */ }
  return { status: res.status, text, json, headers: res.headers };
}

async function postMcp(env, pending, rpcBody) {
  const res = await worker.fetch(
    new Request('https://mcp.ainumbers.co/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'CF-Connecting-IP': '203.0.113.7' },
      body: JSON.stringify(rpcBody),
    }),
    env,
    makeCtx(pending),
  );
  const text = await res.text();
  let parsed = {};
  try {
    parsed = text.startsWith('event:')
      ? JSON.parse((text.split('\n').find((l) => l.startsWith('data: ')) ?? 'data: {}').slice(6))
      : JSON.parse(text || '{}');
  } catch { parsed = {}; }
  return { status: res.status, text, parsed };
}

const VALID = { schema_version: 'ain-agent-feedback-v0', report: { tool_name: 'find_tool', doorway: 'worker', failure_class: 'execution_failed' } };

// ── 0. the vendored twin is present and is the published schema ──────────────────────────────
let twin = null;
try { twin = JSON.parse(readFileSync(join(DATA_DIR, 'mcp', 'agent-feedback.schema.json'), 'utf8')); } catch { /* red below */ }
check('vendored twin parses and carries the v0 const', !!twin && twin?.properties?.schema_version?.const === 'ain-agent-feedback-v0');

// ── 1. 405 + Allow: POST for every non-POST method ───────────────────────────────────────────
{
  const env = makeEnv(); const pending = [];
  const get = await postFeedback(env, pending, { method: 'GET', body: VALID });
  check('GET /feedback → 405', get.status === 405);
  check('405 carries Allow: POST', get.headers.get('Allow') === 'POST');
  check('405 body is the constant shape', get.json.error === 'feedback.method_not_allowed');
  const put = await postFeedback(env, pending, { method: 'PUT', body: VALID });
  check('PUT /feedback → 405', put.status === 405);
  check('no CORS surface on /feedback', get.headers.get('access-control-allow-origin') === null && put.headers.get('access-control-allow-origin') === null);
  await drain(pending);
}

// ── 2. 202 + the exact FEEDBACK datapoint shape (no IP / no UA / no body echo) ────────────────
{
  const env = makeEnv(); const pending = [];
  const res = await postFeedback(env, pending, { body: VALID });
  check('valid report → 202', res.status === 202, 'got ' + res.status + ' ' + res.text.slice(0, 200));
  check('202 body is the constant accepted shape', res.json.status === 'accepted' && res.json.schema_version === 'ain-agent-feedback-v0');
  await drain(pending);
  const d = env._rec.feedback[0];
  check('exactly one FEEDBACK datapoint', env._rec.feedback.length === 1);
  check('blob 1 tool_name', d?.blobs?.[0] === 'find_tool', JSON.stringify(d?.blobs));
  check('blob 2 doorway', d?.blobs?.[1] === 'worker');
  check('blob 3 failure_class', d?.blobs?.[2] === 'execution_failed');
  check('blobs 4-7 optional members are empty strings', d?.blobs?.[3] === '' && d?.blobs?.[4] === '' && d?.blobs?.[5] === '' && d?.blobs?.[6] === '');
  check('blob 8 ASN (network-level, no cf object in test → unknown)', d?.blobs?.[7] === 'unknown');
  check('blob 9 collector-derived tool_known=true for a registered utility tool', d?.blobs?.[8] === 'true');
  check('index = failure_class (digest aggregate key)', d?.indexes?.[0] === 'execution_failed');
  check('double 1 = accepted body byte length', d?.doubles?.[0] === Buffer.byteLength(JSON.stringify(VALID)));
  check('datapoint carries no IP', !JSON.stringify(d).includes('203.0.113.7'));
  check('datapoint carries no user-agent member', !JSON.stringify(d).toLowerCase().includes('user-agent'));
  check('MCP limiters untouched by /feedback', env._rec.mcp.length === 0, JSON.stringify(env._rec.mcp));
  check('per-IP limiter keyed on the connection IP', env._rec.ip[0]?.key === '203.0.113.7');
  check('global limiter keyed on the CONSTANT key', env._rec.glob[0]?.key === 'feedback-global');
}

// ── 3. tool_known: collector-side integrity [BF-5] ───────────────────────────────────────────
{
  const env = makeEnv(); const pending = [];
  await postFeedback(env, pending, { body: { ...VALID, report: { ...VALID.report, tool_name: 'zzz_never_registered' } } });
  await postFeedback(env, pending, { body: { ...VALID, report: { ...VALID.report, tool_name: 'attest_mcp_server' } } });   // permanent alias
  await drain(pending);
  check('unregistered name → tool_known=false', env._rec.feedback[0]?.blobs?.[8] === 'false');
  check('permanently-aliased old name → tool_known=true (resolved, not asserted)', env._rec.feedback[1]?.blobs?.[8] === 'true', JSON.stringify(env._rec.feedback[1]?.blobs));
}

// ── 4. unknown members are ignored AND never stored (R2: no free text) ───────────────────────
{
  const env = makeEnv(); const pending = [];
  const res = await postFeedback(env, pending, { body: { ...VALID, report: { ...VALID.report, free_text: 'SECRET-MARKER', note: 'SECRET-MARKER-2' } } });
  await drain(pending);
  check('pre-stable v0 ignores unknown members → 202', res.status === 202);
  check('unknown members never reach the datapoint', !JSON.stringify(env._rec.feedback).includes('SECRET-MARKER'));
  check('unknown members never echo in the response', !res.text.includes('SECRET-MARKER'));
}

// ── 5. 400 matrix: constant validator strings, never body echoes ─────────────────────────────
async function violation(body, path, rule, label, forbidden) {
  const env = makeEnv(); const pending = [];
  const res = await postFeedback(env, pending, { body });
  await drain(pending);
  const v = (res.json.violations ?? []).some((x) => x.path === path && x.rule === rule);
  check(label + ' → 400 with {' + path + ', ' + rule + '}', res.status === 400 && v, res.text.slice(0, 200));
  check(label + ' response never echoes the offending value', forbidden === undefined || !res.text.includes(forbidden));
  check(label + ' wrote no datapoint', env._rec.feedback.length === 0);
}
await violation({ ...VALID, report: { ...VALID.report, failure_class: 'bananas' } }, 'report.failure_class', 'enum', 'enum violation', 'bananas');
await violation({ ...VALID, report: { ...VALID.report, doorway: 'smoke_signal' } }, 'report.doorway', 'enum', 'doorway enum violation', 'smoke_signal');
await violation({ schema_version: 'ain-agent-feedback-v0', report: { tool_name: 'find_tool', failure_class: 'other' } }, 'report.doorway', 'required', 'missing required doorway');
await violation({ schema_version: 'ain-agent-feedback-v0', report: { doorway: 'worker', failure_class: 'other' } }, 'report.tool_name', 'required', 'missing required tool_name');
await violation({ report: VALID.report }, 'schema_version', 'required', 'missing schema_version');
await violation({ ...VALID, schema_version: 'ain-agent-feedback-v1' }, 'schema_version', 'const', 'wrong schema_version const', 'ain-agent-feedback-v1');
await violation({ ...VALID, report: { ...VALID.report, tool_name: 'BAD NAME!' } }, 'report.tool_name', 'pattern', 'tool_name pattern violation', 'BAD NAME!');
await violation({ ...VALID, report: { ...VALID.report, agent_label: 'a'.repeat(65) } }, 'report.agent_label', 'maxLength', 'agent_label over 64');
await violation({ ...VALID, report: { ...VALID.report, occurred_at: 'yesterday-ish' } }, 'report.occurred_at', 'pattern', 'occurred_at pattern violation', 'yesterday-ish');
await violation({ ...VALID, report: { ...VALID.report, expected_hash: 'NOThex' } }, 'report.expected_hash', 'pattern', 'expected_hash pattern violation', 'NOThex');
{
  const env = makeEnv(); const pending = [];
  const res = await postFeedback(env, pending, { raw: 'not-json{{{' });
  await drain(pending);
  check('malformed JSON → 400 feedback.invalid_json', res.status === 400 && res.json.error === 'feedback.invalid_json');
  check('malformed-JSON response never echoes the body', !res.text.includes('not-json{{{'));
}

// ── 6. 413 over the 2048-byte cap ─────────────────────────────────────────────────────────────
{
  const env = makeEnv(); const pending = [];
  const res = await postFeedback(env, pending, { body: { ...VALID, pad: 'x'.repeat(3000) } });
  await drain(pending);
  check('oversized body → 413 with the canonical max_bytes', res.status === 413 && res.json.error === 'feedback.payload_too_large' && res.json.max_bytes === 2048);
  check('413 wrote no datapoint', env._rec.feedback.length === 0);
}

// ── 7. 429: each dedicated limiter alone can refuse; never a /mcp limiter ─────────────────────
{
  const env = makeEnv({ ipOk: false }); const pending = [];
  const res = await postFeedback(env, pending, { body: VALID });
  await drain(pending);
  check('per-IP limiter success:false → 429', res.status === 429 && res.json.error === 'feedback.rate_limited');
  check('429 wrote no datapoint', env._rec.feedback.length === 0);
}
{
  const env = makeEnv({ globalOk: false }); const pending = [];
  const res = await postFeedback(env, pending, { body: VALID });
  await drain(pending);
  check('global ceiling success:false → 429', res.status === 429 && res.json.error === 'feedback.rate_limited');
  check('global ceiling was keyed on the constant key', env._rec.glob[0]?.key === 'feedback-global');
}

// ── 8. fire-and-forget: a throwing FEEDBACK binding never fails the response ──────────────────
{
  const env = makeEnv({ feedbackThrows: true }); const pending = [];
  const res = await postFeedback(env, pending, { body: VALID });
  await drain(pending);
  check('AE write failure → still 202 (drop-on-error)', res.status === 202);
}

// ── 9. R5 [BF-1]: classifyToolCallEnvelope — all four classes + escaping soundness ─────────────
check('classify: 200 clean result → ok', classifyToolCallEnvelope(200, '{"result":{}}') === 'ok');
check('classify: 200 isError → tool_error', classifyToolCallEnvelope(200, '{"result":{"isError":true}}') === 'tool_error');
check('classify: 5xx → infrastructure_error (no scan needed)', classifyToolCallEnvelope(500, 'anything') === 'infrastructure_error');
check('classify: unreadable envelope → null (honest unknown)', classifyToolCallEnvelope(200, null) === null);
check('classify: ESCAPED payload echo is NOT a tool error', classifyToolCallEnvelope(200, '{"result":{"content":[{"text":"\\"isError\\":true"}]}}') === 'ok');

// ── 10. R5 [BF-1] + [BF-2](ii): the unknown-tool early return ────────────────────────────────
{
  const env = makeEnv(); const pending = [];
  const res = await postMcp(env, pending, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'zzz_no_such_tool_xyz', arguments: {} } });
  await drain(pending);
  check('unknown tool → HTTP 200 -32602 (dispatch-layer refusal, unchanged)', res.status === 200 && res.parsed?.error?.code === -32602);
  check('message keeps the frozen Tool-not-found prefix', String(res.parsed?.error?.message).startsWith('Tool not found:'));
  check('hint points at the collector endpoint', String(res.parsed?.error?.data?.hint || '').includes('https://mcp.ainumbers.co/feedback'));
  check('hint names the schema twin', String(res.parsed?.error?.data?.hint || '').includes('agent-feedback.schema.json'));
  check('nearest_names present and bounded at 5', Array.isArray(res.parsed?.error?.data?.nearest_names) && res.parsed.error.data.nearest_names.length <= 5);
  const d = env._rec.analytics[env._rec.analytics.length - 1];
  check('unknown-tool datum written (was: nothing)', !!d);
  check('unknown-tool datum keeps the positional layout (blobs 1-5)', d?.blobs?.[0] === 'zzz_no_such_tool_xyz' && d?.blobs?.[2] === 'ok' && d?.blobs?.[3] === 'ainumbers-mcp' && typeof d?.blobs?.[4] === 'string' && d.blobs[4].length > 0);
  check('unknown-tool datum classified unknown_tool in blob 6', d?.blobs?.[5] === 'unknown_tool');
  check('unknown-tool datum indexed on tool_name, doubles intact', d?.indexes?.[0] === 'zzz_no_such_tool_xyz' && Array.isArray(d?.doubles) && d.doubles.length === 2);
}

// ── 11. R5 [BF-1]: the removed-tool early return (lifecycle override injection) ───────────────
{
  const env = makeEnv(); const pending = [];
  const data = await mod.loadData(env);
  const saved = data.lifecycle;
  data.lifecycle = { default: 'Active', overrides: { find_tool: 'Removed' } };
  try {
    const res = await postMcp(env, pending, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'find_tool', arguments: { query: 'x' } } });
    await drain(pending);
    check('Removed tool keeps its isError tool-result rejection (HTTP 200, never 500)', res.status === 200 && res.parsed?.result?.isError === true);
    const d = env._rec.analytics[env._rec.analytics.length - 1];
    check('removed-tool datum written (was: nothing)', !!d);
    check('removed-tool datum classified unknown_tool', d?.blobs?.[5] === 'unknown_tool' && d?.blobs?.[0] === 'find_tool');
  } finally {
    data.lifecycle = saved;   // restore — later assertions must see the real tree
  }
}

// ── 12. [BF-2](i)+(iii): instructions capture + server-card pointer ───────────────────────────
{
  let cap = '';
  try { cap = readFileSync(join(DATA_DIR, 'mcp', 'static', 'initialize.json'), 'utf8'); } catch { /* red below */ }
  check('static initialize capture carries the feedback line', cap.includes('https://mcp.ainumbers.co/feedback') && cap.includes('Tool broken/missing?'));
}
{
  const env = makeEnv(); const pending = [];
  const res = await worker.fetch(new Request('https://mcp.ainumbers.co/.well-known/mcp/server-card.json', { method: 'GET' }), env, makeCtx(pending));
  await drain(pending);
  const card = await res.json();
  check('server-card carries the feedback pointer', card?.feedback?.endpoint === 'https://mcp.ainumbers.co/feedback' && card?.feedback?.schema === 'https://ainumbers.co/.well-known/agent-feedback.schema.json');
}

if (failed) {
  console.error(`test-agent-feedback: ${failed} check(s) FAILED`);
  process.exit(1);
}
console.log('test-agent-feedback: all checks green');
