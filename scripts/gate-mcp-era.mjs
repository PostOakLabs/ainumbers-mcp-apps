// gate-mcp-era.mjs — offline gate for the 2026-07-28 era-gated request rules (compute worker).
//
// smoke-mcp.mjs proves these against a DEPLOYED endpoint; this gate proves the same rules in CI
// BEFORE anything deploys, by invoking the Worker's fetch handler directly against the committed
// ./data assets. A rule that only a post-deploy smoke can catch is a rule that reaches production
// before it is checked — and /mcp is the outage-class surface (CONTRACT §A4).
//
// The pairing is the point. Every modern-era rejection below has a LEGACY CONTROL asserting an old
// client still gets 200 for the same shape. Backwards compatibility is a hard requirement, so a fix
// that strands legacy clients must fail here, not in the field.
//
// Shape deliberately mirrors anchor-suite/scripts/gate-mcp-era.mjs — two repos, one dialect.
//
// Usage: node scripts/gate-mcp-era.mjs

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(HERE, '..', 'data');

// Local ASSETS stub backed by the committed ./data directory — the same binding wrangler serves
// (wrangler.jsonc "assets.directory": "./data"). No network egress, deterministic.
const env = {
  ASSETS: {
    fetch: async (url) => {
      const u = new URL(typeof url === 'string' ? url : url.url);
      const filePath = join(DATA_DIR, decodeURIComponent(u.pathname).replace(/^\/+/, ''));
      if (!existsSync(filePath)) return new Response('Not Found', { status: 404 });
      return new Response(readFileSync(filePath), { status: 200 });
    },
  },
};

const worker = (await import('../worker.mjs')).default;

const MODERN = '2026-07-28';
const LEGACY = '2025-06-18';
const URL_MCP = 'https://mcp.ainumbers.co/mcp';

let failed = 0;
function check(label, cond, detail = '') {
  if (cond) console.log('gate-mcp-era: ' + label + '... ok');
  else { failed++; console.error('gate-mcp-era: ' + label + '... FAIL' + (detail ? ' — ' + detail : '')); }
}

let nextId = 1;
// Responses come back as either plain JSON or SSE (`event: message\ndata: {...}`) depending on path.
function parseBody(text) {
  try {
    if (text.startsWith('event:')) {
      const line = text.split('\n').find((l) => l.startsWith('data: '));
      return line ? JSON.parse(line.slice(6)) : {};
    }
    return JSON.parse(text);
  } catch { return {}; }
}

async function call(headers, body, method = 'POST') {
  const res = await worker.fetch(
    new Request(URL_MCP, {
      method,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
      body: method === 'POST' ? JSON.stringify({ jsonrpc: '2.0', id: nextId++, ...body }) : undefined,
    }),
    env,
    { waitUntil: () => {}, passThroughOnException: () => {} },
  );
  const text = await res.text();
  return { status: res.status, headers: res.headers, text, body: parseBody(text) };
}

const meta = (extra = {}) => ({
  'io.modelcontextprotocol/protocolVersion': MODERN,
  'io.modelcontextprotocol/clientCapabilities': {},
  ...extra,
});
const MODERN_H = { 'MCP-Protocol-Version': MODERN };

// ---- version negotiation -----------------------------------------------------

{
  const r = await call({ ...MODERN_H, 'Mcp-Method': 'tools/list' }, { method: 'tools/list', params: { _meta: meta() } });
  check('modern: fully conformant tools/list → 200 + resultType complete',
    r.status === 200 && r.body.result?.resultType === 'complete' && r.body.result?.tools?.length > 0,
    `status=${r.status} resultType=${r.body.result?.resultType}`);
}

{
  const r = await call({ 'MCP-Protocol-Version': '1900-01-01', 'Mcp-Method': 'tools/list' },
    { method: 'tools/list', params: { _meta: meta({ 'io.modelcontextprotocol/protocolVersion': '1900-01-01' }) } });
  check('unsupported version → 400 + -32022 listing 2026-07-28 as supported',
    r.status === 400 && r.body.error?.code === -32022 && r.body.error?.data?.supported?.includes(MODERN),
    `status=${r.status} code=${r.body.error?.code}`);
}

// ---- SDK transport version compatibility -------------------------------------
// The SDK's validateProtocolVersion rejects any mcp-protocol-version outside its own frozen
// SUPPORTED_PROTOCOL_VERSIONS with 400 + -32000, so worker.mjs swaps 2026-07-28 for a version the
// SDK accepts before handing the request to the transport. This asserts that substitute is still
// in the SDK's list — a Dependabot bump that drops it would otherwise 400 every modern-era
// tools/call, and the offline harness cannot drive the SDK path to catch it live.
{
  const { SUPPORTED_PROTOCOL_VERSIONS } = await import('@modelcontextprotocol/sdk/types.js');
  const src = readFileSync(join(HERE, '..', 'worker.mjs'), 'utf8');
  const fallback = /MCP_SDK_FALLBACK_VERSION\s*=\s*'([^']+)'/.exec(src)?.[1];
  check('SDK-transport fallback version is still accepted by the installed SDK',
    !!fallback && SUPPORTED_PROTOCOL_VERSIONS.includes(fallback),
    `fallback=${fallback} sdk=${SUPPORTED_PROTOCOL_VERSIONS.join(',')}`);
}

// ---- server/discover ---------------------------------------------------------

{
  const r = await call({ ...MODERN_H, 'Mcp-Method': 'server/discover' }, { method: 'server/discover', params: { _meta: meta() } });
  check('server/discover → 200 + supportedVersions + capabilities + resultType',
    r.status === 200 && r.body.result?.resultType === 'complete' &&
    r.body.result?.supportedVersions?.includes(MODERN) && !!r.body.result?.capabilities,
    `status=${r.status} code=${r.body.error?.code}`);
  // SEP-1865: the MCP Apps extension must be reachable WITHOUT the legacy initialize handshake.
  check('server/discover advertises the MCP Apps (SEP-1865) extension',
    !!r.body.result?.capabilities?.extensions?.['io.modelcontextprotocol/ui'],
    JSON.stringify(r.body.result?.capabilities ?? {}).slice(0, 200));
}

// ---- modern era: the 2026-07-28 rules are enforced ---------------------------

// ⚠ SCOPE OF THIS OFFLINE GATE. Every rule above and below runs BEFORE dispatch, so the fetch
// handler answers it without the SDK. The rules that live ON the SDK transport path — unknown
// method → 404 + -32601, and a real-args tools/call — cannot be asserted here: fetch-to-node's
// toReqRes/StreamableHTTPServerTransport pair returns an empty HTTP 400 under plain Node, with or
// without this change (verified against the pristine worker on origin/master before writing this).
// That is a harness limitation, not a worker defect — the live endpoint serves both correctly.
// Those three checks (modern 404, the legacy-200 control for the same shape, and a real-args
// tools/call) are asserted POST-DEPLOY in scripts/smoke-mcp.mjs instead, so they are covered —
// just not offline.

{
  const r = await call(MODERN_H, { method: 'tools/list', params: { _meta: meta() } });
  check('modern: missing Mcp-Method header → 400 + -32020',
    r.status === 400 && r.body.error?.code === -32020, `status=${r.status} code=${r.body.error?.code}`);
}

{
  const r = await call({ ...MODERN_H, 'Mcp-Method': 'tools/list' }, { method: 'tools/list', params: {} });
  check('modern: missing required _meta → 400 + -32602 naming the fields',
    r.status === 400 && r.body.error?.code === -32602 && (r.body.error?.data?.missingFields ?? []).length === 2,
    `status=${r.status} code=${r.body.error?.code}`);
}

{
  const r = await call({ ...MODERN_H, 'Mcp-Method': 'tools/list' },
    { method: 'tools/list', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': MODERN } } });
  check('modern: _meta without clientCapabilities → 400 + -32602',
    r.status === 400 && r.body.error?.code === -32602, `status=${r.status} code=${r.body.error?.code}`);
}

{
  // R16: the version header must match the body _meta version. Both values are individually
  // supported, so only the COMPARISON can reject this — the check the body._meta path bug hid.
  const r = await call({ ...MODERN_H, 'Mcp-Method': 'tools/list' },
    { method: 'tools/list', params: { _meta: meta({ 'io.modelcontextprotocol/protocolVersion': LEGACY }) } });
  check('modern: version header ≠ body _meta version → 400 + -32020',
    r.status === 400 && r.body.error?.code === -32020, `status=${r.status} code=${r.body.error?.code}`);
}

{
  const r = await call({ ...MODERN_H, 'Mcp-Method': 'tools/call', 'Mcp-Name': 'wrong_tool_name' },
    { method: 'tools/call', params: { name: 'list_ainumbers_tools', arguments: {}, _meta: meta() } });
  check('modern: Mcp-Name mismatch → 400 + -32020',
    r.status === 400 && r.body.error?.code === -32020, `status=${r.status} code=${r.body.error?.code}`);
}

{
  const r = await call({ ...MODERN_H, 'Mcp-Method': 'tools/call' },
    { method: 'tools/call', params: { name: 'list_ainumbers_tools', arguments: {}, _meta: meta() } });
  check('modern: tools/call missing Mcp-Name → 400 + -32020',
    r.status === 400 && r.body.error?.code === -32020, `status=${r.status} code=${r.body.error?.code}`);
}

// ---- verbs -------------------------------------------------------------------

for (const verb of ['GET', 'DELETE']) {
  const r = await call({}, undefined, verb);
  check(`${verb} → 405 and Allow does not advertise DELETE`,
    r.status === 405 && !/DELETE/.test(r.headers.get('allow') ?? ''),
    `status=${r.status} allow=${r.headers.get('allow')}`);
}

// ---- LEGACY CONTROLS: an old client must NOT be stranded ---------------------

{
  const r = await call({}, { method: 'tools/list', params: {} });
  check('legacy control: bare tools/list, no headers at all → 200 + tools',
    r.status === 200 && r.body.result?.tools?.length > 0, `status=${r.status}`);
}

{
  const r = await call({ 'MCP-Protocol-Version': LEGACY }, { method: 'tools/list', params: {} });
  check('legacy control: version header, no Mcp-Method, no _meta → 200 (absence not enforced)',
    r.status === 200 && r.body.result?.tools?.length > 0, `status=${r.status} code=${r.body.error?.code}`);
}

// initialize must answer 200 for every era. ⚠ What it NEGOTIATES is narrower than what it
// ACCEPTS: only the server's own version and 2026-07-28 are echoed, because those are the two
// wire shapes this worker actually serves (MCPVER-ECHO-FIX-1). 2024-11-05 is accepted without
// error and answered with the server's version — 200, never a strand.
for (const v of ['2024-11-05', LEGACY, MODERN]) {
  const r = await call({}, { method: 'initialize', params: { protocolVersion: v, capabilities: {}, clientInfo: { name: 'gate', version: '1' } } });
  const expected = v === '2024-11-05' ? LEGACY : v;
  check(`legacy control: initialize @${v} → 200 + negotiates ${expected}`,
    r.status === 200 && r.body.result?.protocolVersion === expected, `status=${r.status} got=${r.body.result?.protocolVersion}`);
  if (v === MODERN) {
    // SEP-1865 through the modern revision as well as through server/discover.
    check('initialize @2026-07-28 advertises the MCP Apps extension',
      !!r.body.result?.capabilities?.extensions?.['io.modelcontextprotocol/ui']);
  }
}

if (failed > 0) {
  console.error(`\ngate-mcp-era: ${failed} check(s) FAILED`);
  process.exit(1);
}
console.log('\ngate-mcp-era: all checks passed');
