// Post-deploy smoke test for the live MCP endpoint.
// (1) Real MCP `initialize` handshake — asserts a JSON-RPC result with serverInfo. Catches a
//     RUNTIME tool-registration throw in buildServer() (e.g. duplicate mcp_name) that 500s the
//     /mcp handshake while the rest of the worker serves (the 2026-06-19 outage class).
// (2) `export_artifact` (OCG §13): asserts it is in tools/list, then a real round-trip —
//     tools/call export_artifact { artifact, format:"xlsx" } must return an xlsx blob (PK zip)
//     with the source execution_hash carried in metadata. Proves the export tool actually runs.
//     Skip with MCP_SMOKE_SKIP_EXPORT=1.
//
// Transport note: the worker is STATELESS streamable-HTTP (new transport per request, no session)
// and answers as SSE. We therefore STREAM each response and resolve on the first JSON-RPC message
// matching our id, then abort — never block on res.text() waiting for a stream that may stay open.
// Every request has a hard timeout so the smoke can't hang.
//
// RATE BUDGET (MCP-SMOKE-PAGINATION-BUDGET-1, 2026-09-18; walk collapsed per MCP-SMOKE-CI-EXEMPTION-1,
// 2026-09-20). A full pass is ~39 requests: ONE 16-page cursor walk in paginationConformance whose
// names exportRoundTrip REUSES (the pre-collapse pass walked the pages twice and measured 55), plus
// ~20 fixed conformance calls. /mcp is protected by MCP_RATE_LIMITER —
// `simple { limit: 30, period: 60 }` per CF-Connecting-IP (wrangler.jsonc) checked in
// rateLimitExceeded() before any body parse. An unpaced pass therefore ALWAYS trips 429 mid-walk,
// and the old "retry the whole pass after 4s" loop re-entered a still-drained window six times:
// every master deploy since #358 was red on HTTP 429 while the deploy itself succeeded.
// The fix is a single token bucket shared by EVERY request this script makes (not just the walk):
// never more than (limit − headroom) requests per window, and never two requests closer than
// window/(limit − headroom). On a 429 we sleep one full window + 1s and resume the SAME request —
// the pass is never restarted for a limiter response. A hard wall-clock cap bounds the job.
//
// Usage:  node scripts/smoke-mcp.mjs [url]
//         node scripts/smoke-mcp.mjs --self-test   (offline: exercises the pacer, no network)
//   url default: https://mcp.ainumbers.co/mcp (or env MCP_SMOKE_URL)
//   env: MCP_SMOKE_RETRIES (2), MCP_SMOKE_DELAY_MS (4000), MCP_SMOKE_TIMEOUT_MS (15000),
//        MCP_SMOKE_SKIP_EXPORT, MCP_SMOKE_PACE (0 disables pacing — reproduces the 429),
//        MCP_SMOKE_RL_LIMIT (30), MCP_SMOKE_RL_WINDOW_MS (60000), MCP_SMOKE_RL_HEADROOM (3),
//        MCP_SMOKE_429_RETRIES (3), MCP_SMOKE_MAX_WALL_MS (600000),
//        MCP_SMOKE_PROPAGATION_MS (90000).
// Exit 0 = healthy; exit 1 = broken (fails the deploy job → roll back in Cloudflare).

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GetPromptResultSchema } from '@modelcontextprotocol/sdk/types.js';

const ARGV = process.argv.slice(2);
const SELF_TEST = ARGV.includes('--self-test');
const URL = ARGV.find((a) => !a.startsWith('--')) || process.env.MCP_SMOKE_URL || 'https://mcp.ainumbers.co/mcp';
// Attempt restarts now cost a full paced pass, and a 429 no longer consumes one (it is absorbed
// in-request), so the retry count drops from 6 to 2: retries exist for a genuinely transient
// non-429 fault, and MAX_WALL is the real ceiling.
const RETRIES = Number(process.env.MCP_SMOKE_RETRIES ?? 2);
const DELAY = Number(process.env.MCP_SMOKE_DELAY_MS ?? 4000);
const TIMEOUT = Number(process.env.MCP_SMOKE_TIMEOUT_MS ?? 15000);
const PROTO = '2025-06-18';
const ACCEPT = 'application/json, text/event-stream';

// ── Rate pacing ────────────────────────────────────────────────────────────────────────────────
// `let`, not `const`, only so --self-test can shrink the window and exercise the SHIPPED math.
// LEGACY mode (`--no-pace` / MCP_SMOKE_PACE=0) reproduces the PRE-FIX behaviour on demand: no
// bucket, no in-request 429 backoff, no phase resume. It exists so the red this row fixes can be
// observed deliberately against the live endpoint (SO #34c) instead of only in a CI archive.
const LEGACY = ARGV.includes('--no-pace') || process.env.MCP_SMOKE_PACE === '0';
const PACE_ON = !LEGACY;
let RL_LIMIT = Number(process.env.MCP_SMOKE_RL_LIMIT ?? 30);        // MCP_RATE_LIMITER simple.limit
let RL_WINDOW_MS = Number(process.env.MCP_SMOKE_RL_WINDOW_MS ?? 60000); // simple.period × 1000
let RL_HEADROOM = Number(process.env.MCP_SMOKE_RL_HEADROOM ?? 3);   // leave room for a co-running caller
let RL_BUDGET = Math.max(1, RL_LIMIT - RL_HEADROOM);                // 27 req / 60s
let RL_SPACING_MS = Math.ceil(RL_WINDOW_MS / RL_BUDGET);            // 2223 ms between any two requests
let RL_BACKOFF_MS = RL_WINDOW_MS + 1000;                            // 61s: one full window + 1s
const RL_429_RETRIES = Number(process.env.MCP_SMOKE_429_RETRIES ?? 3);
let MAX_WALL_MS = Number(process.env.MCP_SMOKE_MAX_WALL_MS ?? 600000);  // 10 min hard cap
const PROPAGATION_MS = Number(process.env.MCP_SMOKE_PROPAGATION_MS ?? 90000);
function recomputePace() {
  RL_BUDGET = Math.max(1, RL_LIMIT - RL_HEADROOM);
  RL_SPACING_MS = Math.ceil(RL_WINDOW_MS / RL_BUDGET);
  RL_BACKOFF_MS = RL_WINDOW_MS + 1000;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let START_MS = Date.now();
let requestCount = 0;
let sent = [];               // send timestamps inside the current window
function resetPace() { sent = []; }
function wallLeftMs() { return MAX_WALL_MS - (Date.now() - START_MS); }
function assertWall(label) {
  if (wallLeftMs() <= 0) throw new Error(`wall-clock budget of ${MAX_WALL_MS}ms exhausted at "${label}" after ${requestCount} requests`);
}

// Block until sending one more request keeps us inside the budget. Enforces BOTH the sliding-window
// count and a minimum spacing, so we can neither burst past the limiter nor drift into it.
async function paceGate(label) {
  assertWall(label);
  if (!PACE_ON) return;
  for (;;) {
    const now = Date.now();
    sent = sent.filter((t) => now - t < RL_WINDOW_MS);
    let wait = 0;
    if (sent.length >= RL_BUDGET) wait = Math.max(wait, RL_WINDOW_MS - (now - sent[0]) + 50);
    const last = sent[sent.length - 1];
    if (last !== undefined) wait = Math.max(wait, RL_SPACING_MS - (now - last));
    if (wait <= 0) return;
    if (wait >= wallLeftMs()) throw new Error(`wall-clock budget of ${MAX_WALL_MS}ms cannot absorb a ${wait}ms pace wait at "${label}"`);
    await sleep(wait);
  }
}

// Every network call in this file goes through here. `makeInit` is a THUNK because a retried
// request needs a fresh AbortSignal (a reused expired signal aborts instantly).
async function pacedFetch(url, makeInit, label) {
  for (let attempt = 0; ; attempt++) {
    await paceGate(label);
    sent.push(Date.now());
    requestCount++;
    const res = await fetch(url, makeInit());
    if (res.status !== 429) return res;
    let body = ''; try { body = await res.text(); } catch { /* ignore */ }
    if (LEGACY) {
      const e = new Error(`HTTP 429 on ${label}: ${body.slice(0, 200)}`);
      e.rateLimited = true;
      throw e;
    }
    if (attempt >= RL_429_RETRIES) {
      const e = new Error(`HTTP 429 on ${label} after ${attempt + 1} paced attempts: ${body.slice(0, 200)}`);
      e.rateLimited = true;
      throw e;
    }
    if (RL_BACKOFF_MS >= wallLeftMs()) {
      const e = new Error(`HTTP 429 on ${label} and the ${RL_BACKOFF_MS}ms backoff exceeds the remaining wall budget`);
      e.rateLimited = true;
      throw e;
    }
    console.error(`  · 429 on ${label} — draining the limiter for ${RL_BACKOFF_MS}ms (window ${RL_WINDOW_MS}ms), then resuming THIS request (no pass restart)`);
    resetPace();
    await sleep(RL_BACKOFF_MS);
  }
}

// Phase-level backstop: if a phase still surfaces a rate-limited error after the in-request
// backoffs, drain once more and re-run THAT phase only. Non-429 errors propagate to the attempt loop.
async function phase(name, fn) {
  for (let i = 0; ; i++) {
    try { return await fn(); } catch (e) {
      if (LEGACY || !e || !e.rateLimited || i >= 1) throw e;
      console.error(`  · phase "${name}" still rate-limited — draining ${RL_BACKOFF_MS}ms and resuming this phase`);
      resetPace();
      await sleep(RL_BACKOFF_MS);
    }
  }
}

// SEP-2243 routing headers. Every smoke request SENDS them, so a green smoke actually
// proves the header path end to end (and that the Cloudflare WAF forwards them).
// Mcp-Name applies only to the methods that carry a name/uri in params.
function sep2243Headers(method, params) {
  const h = { 'mcp-method': method };
  const name = (method === 'tools/call' || method === 'prompts/get') ? params?.name
             : (method === 'resources/read') ? params?.uri
             : undefined;
  if (name !== undefined) h['mcp-name'] = String(name);
  return h;
}

// POST a JSON-RPC request and STREAM the response, resolving on the first object whose id matches.
// Returns { result, error }. Throws on timeout/HTTP error/no-match-before-end.
async function call(method, params, id) {
  // controller/timer are (re)built per attempt inside the thunk — a 429 retry must not inherit an
  // already-fired timeout signal.
  let controller, timer;
  const makeInit = () => {
    if (timer) clearTimeout(timer);
    controller = new AbortController();
    timer = setTimeout(() => controller.abort(new Error('timeout')), TIMEOUT);
    return {
      method: 'POST', signal: controller.signal,
      headers: {
        'content-type': 'application/json', accept: ACCEPT, 'mcp-protocol-version': PROTO,
        ...sep2243Headers(method, params),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    };
  };
  let res;
  try {
    res = await pacedFetch(URL, makeInit, method);
  } catch (e) {
    clearTimeout(timer);
    if (e && e.rateLimited) throw e;
    throw new Error(`fetch failed/timed out on ${method}: ${e.message}`);
  }
  if (res.status !== 200) {
    let t = ''; try { t = await res.text(); } catch { /* ignore */ }
    clearTimeout(timer);
    throw new Error(`HTTP ${res.status} on ${method}: ${t.slice(0, 300)}`);
  }

  // Scan accumulated text for a JSON-RPC object with our id (plain JSON or SSE data: lines).
  const find = (buf) => {
    const whole = buf.trim();
    if (whole.startsWith('{')) { try { const o = JSON.parse(whole); if (o.id === id) return o; } catch { /* partial */ } }
    for (const line of buf.split('\n')) {
      if (line.startsWith('data:')) { try { const o = JSON.parse(line.slice(5).trim()); if (o.id === id) return o; } catch { /* partial */ } }
    }
    return null;
  };

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (value) buf += decoder.decode(value, { stream: true });
      const hit = find(buf);
      if (hit) { controller.abort(); clearTimeout(timer); return { result: hit.result, error: hit.error }; }
      if (done) break;
    }
  } catch (e) {
    const hit = find(buf);
    if (hit) { clearTimeout(timer); return { result: hit.result, error: hit.error }; }
    clearTimeout(timer);
    throw new Error(`stream read failed on ${method}: ${e.message}`);
  }
  clearTimeout(timer);
  throw new Error(`no JSON-RPC response for ${method} (id ${id}) before stream end. Got: ${buf.slice(0, 200)}`);
}

// MCP-SMOKE-CI-EXEMPTION-1 (2026-09-20, option 3): there is exactly ONE cursor walk per pass now,
// inside paginationConformance() below. exportRoundTrip() reuses the names that walk collected
// instead of walking the pages a second time — the second full walk cost 16 requests per pass for
// no extra assertion (the page set and the committed template are already proven equal in (b)),
// and at the 27 req/60s pace it was the whole difference between ~10% and ~28% headroom under the
// per-IP MCP_RATE_LIMITER (30 req/60s). The old standalone helper is gone so a second walk cannot
// quietly grow back.

// §M1.6 dual-version window: the 2026-07-28 RC drops the mandatory `initialize` handshake. Prove
// the worker answers tools/list (and a real tools/call) WITHOUT ever calling initialize first —
// the RC path — on top of the current initialize()-first path proven below.
async function rcNoInitializePath() {
  const list = await call('tools/list', {}, 101);
  if (list.error) throw new Error(`RC-path tools/list error ${list.error.code}: ${list.error.message}`);
  const names = (list.result?.tools ?? []).map((t) => t.name);
  if (!names.includes('find_tool')) throw new Error('RC-path tools/list missing lean-core tool find_tool');
  const out = await call('tools/call', { name: 'find_tool', arguments: { query: 'reserve' } }, 102);
  if (out.error) throw new Error(`RC-path tools/call error ${out.error.code}: ${out.error.message}`);
  if (out.result?.isError) throw new Error('RC-path find_tool isError: ' + JSON.stringify(out.result.content).slice(0, 200));
  return { tools: names.length };
}

// §M1.2 named toolsets: ?toolset=reserve must expand the advertised (non-deferred) set beyond the
// 9-name lean core with reserve-domain tools, generator-emitted (data/mcp/toolsets.json).
async function toolsetProfile() {
  const profileUrl = URL + (URL.includes('?') ? '&' : '?') + 'toolset=reserve';
  const res = await pacedFetch(profileUrl, () => ({
    method: 'POST', headers: { 'content-type': 'application/json', accept: ACCEPT, 'mcp-protocol-version': PROTO },
    body: JSON.stringify({ jsonrpc: '2.0', id: 201, method: 'tools/list', params: {} }),
  }), 'tools/list?toolset=reserve');
  if (res.status !== 200) throw new Error(`?toolset=reserve tools/list HTTP ${res.status}`);
  const text = await res.text();
  const line = text.split('\n').find((l) => l.startsWith('data:'));
  const obj = JSON.parse((line || text).replace(/^data:\s*/, ''));
  const tools = obj.result?.tools ?? [];
  const nonDeferred = tools.filter((t) => !t.defaultConfig?.defer_loading).length;
  if (nonDeferred <= 9) throw new Error(`?toolset=reserve did not expand the advertised set (${nonDeferred} non-deferred, expected >9)`);
  return { nonDeferred };
}

async function initialize() {
  const { result, error } = await call('initialize', {
    protocolVersion: PROTO, capabilities: {}, clientInfo: { name: 'ci-smoke', version: '1' },
  }, 1);
  if (error) throw new Error(`initialize JSON-RPC error ${error.code}: ${error.message}`);
  const info = result && result.serverInfo;
  if (!info || !info.name) throw new Error('unexpected initialize result');
  return info;
}

// MCPVER-ECHO-FIX-1: an unsupported/bogus protocolVersion must NOT be echoed back — the server
// must respond with a version it actually implements (PROTO), never claim support it lacks.
async function versionNegotiationHonesty() {
  const bogus = '9999-01-01-not-a-real-version';
  const { result, error } = await call('initialize', {
    protocolVersion: bogus, capabilities: {}, clientInfo: { name: 'ci-smoke-negotiation', version: '1' },
  }, 4);
  if (error) throw new Error(`version-negotiation initialize JSON-RPC error ${error.code}: ${error.message}`);
  const got = result && result.protocolVersion;
  if (got === bogus) throw new Error(`server echoed unsupported protocolVersion "${bogus}" verbatim — version-negotiation regression`);
  if (!got) throw new Error('version-negotiation initialize returned no protocolVersion');
  return { requested: bogus, negotiated: got };
}

// SEP-2243 (MCP-728 §T1). Two assertions, and BOTH matter:
//   (a) a header/body MISMATCH is rejected with HTTP 400 + JSON-RPC -32020 (HeaderMismatch).
//       ⛔ Not -32602 (that is §T2's unknown-tool condition) and not -32001 (renumbered by
//       modelcontextprotocol#2907).
//   (b) a request sending NO SEP-2243 headers still works — the dual-support window. This is
//       the outage guard: it fails loudly if validation ever starts rejecting on ABSENCE.
async function sep2243HeaderValidation() {
  // (a) Mcp-Method says prompts/get, the body says tools/list.
  const bad = await pacedFetch(URL, () => ({
    method: 'POST',
    headers: {
      'content-type': 'application/json', accept: ACCEPT, 'mcp-protocol-version': PROTO,
      'mcp-method': 'prompts/get',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 301, method: 'tools/list', params: {} }),
    signal: AbortSignal.timeout(TIMEOUT),
  }), 'SEP-2243 mismatch');
  const badText = await bad.text();
  if (bad.status !== 400) {
    throw new Error(`SEP-2243 mismatch returned HTTP ${bad.status}, expected 400: ${badText.slice(0, 200)}`);
  }
  let badObj;
  try { badObj = JSON.parse(badText); } catch { throw new Error(`SEP-2243 mismatch body is not JSON: ${badText.slice(0, 200)}`); }
  if (badObj?.error?.code !== -32020) {
    throw new Error(`SEP-2243 mismatch returned code ${badObj?.error?.code}, expected -32020 (HeaderMismatch)`);
  }

  // (b) Legacy client: no SEP-2243 headers at all must still answer 200 and list tools.
  const legacy = await pacedFetch(URL, () => ({
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: ACCEPT },
    body: JSON.stringify({ jsonrpc: '2.0', id: 302, method: 'tools/list', params: {} }),
    signal: AbortSignal.timeout(TIMEOUT),
  }), 'SEP-2243 legacy control');
  const legacyText = await legacy.text();
  if (legacy.status !== 200) {
    throw new Error(`legacy (no SEP-2243 headers) tools/list returned HTTP ${legacy.status} — dual-support broken: ${legacyText.slice(0, 200)}`);
  }
  const legacyLine = legacyText.split('\n').find((l) => l.startsWith('data:'));
  const legacyObj = JSON.parse((legacyLine || legacyText).replace(/^data:\s*/, ''));
  const legacyTools = legacyObj.result?.tools?.length ?? 0;
  if (!legacyTools) throw new Error('legacy (no SEP-2243 headers) tools/list returned no tools — dual-support broken');
  return { code: badObj.error.code, legacyTools };
}

// MCP-728 §T2: a genuinely unknown mcp_name is a JSON-RPC PROTOCOL error, -32602, NOT a
// tool-result with isError:true, and NOT -32002 (an older/wrong code this WU corrects).
// MCP-500 §M1.1 regression, same call: a tool that is REGISTERED but not in the lean-core
// advertised set (defer_loading:true) must still resolve — it must NOT false-reject as
// "unknown" just because tools/list hid it behind the deferred-loading hint.
async function unknownToolErrorCode() {
  const bogus = 'definitely_not_a_real_tool_' + Date.now();
  const { result, error } = await call('tools/call', { name: bogus, arguments: {} }, 401);
  if (!error) throw new Error(`unknown tool "${bogus}" returned no JSON-RPC error (got result: ${JSON.stringify(result).slice(0, 200)}) — MCP-728 T2 requires a protocol-level error, not a tool result`);
  if (error.code !== -32602) throw new Error(`unknown tool "${bogus}" returned code ${error.code}, expected -32602`);
  if (error.code === -32002) throw new Error('unknown tool returned the retired -32002 code — MCP-728 T2 regression');

  const list = await call('tools/list', {}, 402);
  if (list.error) throw new Error(`tools/list error ${list.error.code}: ${list.error.message}`);
  const deferred = (list.result?.tools ?? []).find((t) => t.defaultConfig?.defer_loading === true);
  if (!deferred) return { unknownCode: error.code, deferredChecked: false };
  const out = await call('tools/call', { name: deferred.name, arguments: {} }, 403);
  if (out.error?.code === -32602) throw new Error(`M1.1 regression: registered-but-deferred tool "${deferred.name}" was rejected as unknown (-32602)`);
  return { unknownCode: error.code, deferredChecked: true, deferredTool: deferred.name };
}

// MCP728-T2B: an unsupported MODERN protocol-version assertion (MCP-Protocol-Version header)
// must be rejected with the FINAL spec's -32022 + HTTP 400 + structured error.data.supported/
// error.data.requested, with the request id preserved — never the SDK's generic -32000 nor a
// dropped id. Checked on BOTH regimes that used to diverge (MCP728-Q3-CONFIRM-1): the O(1)
// static fast path (initialize) and the full SDK-transport path (an unrecognized method, the
// exact server/discover repro that surfaced the bug).
async function protocolVersionRejection() {
  // ⚠ WAS '2026-07-28'. MCP728-CONFORM-FIX-2 makes that a SUPPORTED version, so keeping it here
  // would assert the worker rejects the revision it now implements — the smoke would fail the
  // deploy for doing the right thing. The rejection rule itself is unchanged; only the probe
  // version moved to one that is genuinely unsupported.
  const bad = '1900-01-01';
  const post = (id, method, params) => pacedFetch(URL, () => ({
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: ACCEPT, 'mcp-protocol-version': bad },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    signal: AbortSignal.timeout(TIMEOUT),
  }), `version-rejection ${method}`);
  const assertRejected = async (res, id, label) => {
    const text = await res.text();
    if (res.status !== 400) throw new Error(`${label} w/ unsupported version header returned HTTP ${res.status}, expected 400: ${text.slice(0, 200)}`);
    let obj;
    try { obj = JSON.parse(text); } catch { throw new Error(`${label} w/ unsupported version header body is not JSON: ${text.slice(0, 200)}`); }
    if (obj?.error?.code !== -32022) throw new Error(`${label} w/ unsupported version header returned code ${obj?.error?.code}, expected -32022 (MCP728-T2B regression)`);
    if (obj?.id !== id) throw new Error(`${label} w/ unsupported version header lost request id (got ${obj?.id}, expected ${id})`);
    if (!Array.isArray(obj?.error?.data?.supported) || !obj.error.data.supported.length) throw new Error(`${label} w/ unsupported version header missing error.data.supported array`);
    if (obj?.error?.data?.requested !== bad) throw new Error(`${label} w/ unsupported version header missing/wrong error.data.requested`);
    return obj;
  };
  const initObj = await assertRejected(
    await post(501, 'initialize', { protocolVersion: PROTO, capabilities: {}, clientInfo: { name: 'ci-smoke-ver', version: '1' } }),
    501, 'initialize (static fast path)',
  );
  await assertRejected(
    await post(502, 'tools/call', { name: 'list_ainumbers_tools', arguments: {} }),
    502, 'tools/call (SDK path)',
  );
  return { code: initObj.error.code };
}

// MCP728-CONFORM-FIX-2 — the 2026-07-28 rules that only a LIVE endpoint can prove.
// scripts/gate-mcp-era.mjs asserts every pre-dispatch rule offline in CI; the checks below are the
// ones that ride the SDK transport path, which fetch-to-node cannot drive under plain Node. Each
// modern-era assertion is PAIRED with a legacy control, because a fix that strands old clients is
// the outage this whole discipline exists to prevent.
async function era2026Conformance() {
  const MODERN = '2026-07-28';
  const modernMeta = {
    'io.modelcontextprotocol/protocolVersion': MODERN,
    'io.modelcontextprotocol/clientCapabilities': {},
  };
  const post = (headers, body) => pacedFetch(URL, () => ({
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: ACCEPT, ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT),
  }), `era2026 ${body?.method}`);
  const readJson = async (res) => {
    const text = await res.text();
    if (text.startsWith('event:')) {
      const line = text.split('\n').find((l) => l.startsWith('data: '));
      if (line) return JSON.parse(line.slice(6));
    }
    try { return JSON.parse(text); } catch { throw new Error('non-JSON body: ' + text.slice(0, 200)); }
  };

  // (1) server/discover — a modern client learns versions + capabilities here, not from initialize.
  const disc = await post(
    { 'mcp-protocol-version': MODERN, 'mcp-method': 'server/discover' },
    { jsonrpc: '2.0', id: 601, method: 'server/discover', params: { _meta: modernMeta } },
  );
  if (disc.status !== 200) throw new Error(`server/discover returned HTTP ${disc.status}, expected 200`);
  const discObj = await readJson(disc);
  const r = discObj?.result;
  if (!r) throw new Error(`server/discover error ${discObj?.error?.code}: ${discObj?.error?.message}`);
  if (r.resultType !== 'complete') throw new Error(`server/discover resultType is "${r.resultType}", expected "complete"`);
  if (!Array.isArray(r.supportedVersions) || !r.supportedVersions.includes(MODERN)) {
    throw new Error('server/discover supportedVersions does not include ' + MODERN);
  }
  // SEP-1865 must be reachable WITHOUT the legacy initialize handshake.
  if (!r.capabilities?.extensions?.['io.modelcontextprotocol/ui']) {
    throw new Error('server/discover does not advertise the MCP Apps (SEP-1865) ui extension');
  }

  // (2) resultType on tools/list — "The result MUST include a resultType field."
  const tl = await post(
    { 'mcp-protocol-version': MODERN, 'mcp-method': 'tools/list' },
    { jsonrpc: '2.0', id: 602, method: 'tools/list', params: { _meta: modernMeta } },
  );
  const tlObj = await readJson(tl);
  if (tlObj?.result?.resultType !== 'complete') throw new Error(`tools/list resultType is "${tlObj?.result?.resultType}", expected "complete"`);
  const toolCount = tlObj.result.tools?.length ?? 0;
  if (toolCount === 0) throw new Error('tools/list returned no tools');

  // (3) unknown RPC method → 404 + -32601 (modern era only).
  const unk = await post(
    { 'mcp-protocol-version': MODERN, 'mcp-method': 'no/such/method' },
    { jsonrpc: '2.0', id: 603, method: 'no/such/method', params: { _meta: modernMeta } },
  );
  const unkObj = await readJson(unk);
  if (unk.status !== 404) throw new Error(`modern unknown method returned HTTP ${unk.status}, expected 404`);
  if (unkObj?.error?.code !== -32601) throw new Error(`modern unknown method returned code ${unkObj?.error?.code}, expected -32601`);

  // (3b) LEGACY CONTROL for the same shape — an old client must still get 200, never a 404.
  const unkLegacy = await post({}, { jsonrpc: '2.0', id: 604, method: 'no/such/method', params: {} });
  if (unkLegacy.status !== 200) throw new Error(`LEGACY unknown method returned HTTP ${unkLegacy.status}, expected 200 — legacy clients are being stranded`);

  // (4) DELETE → 405, and Allow must stop advertising the verb SEP-2567 removed.
  const del = await pacedFetch(URL, () => ({ method: 'DELETE', signal: AbortSignal.timeout(TIMEOUT) }), 'era2026 DELETE');
  if (del.status !== 405) throw new Error(`DELETE returned HTTP ${del.status}, expected 405`);
  if (/DELETE/.test(del.headers.get('allow') ?? '')) throw new Error(`DELETE still advertised in Allow: ${del.headers.get('allow')}`);

  // (5) LEGACY CONTROL — a bare, header-less, _meta-less request still works.
  const bare = await post({}, { jsonrpc: '2.0', id: 605, method: 'tools/list', params: {} });
  if (bare.status !== 200) throw new Error(`LEGACY bare tools/list returned HTTP ${bare.status}, expected 200`);

  return { tools: toolCount, supported: r.supportedVersions.length };
}

// MCP-TOOLSLIST-PAGINATION-1 — the compatibility duty this row ships with, asserted LIVE:
//   (a) a NO-CURSOR tools/list returns a valid page one (resultType complete, tools non-empty,
//       nextCursor present, body comfortably under the ~200KB size that breaks thin clients);
//   (b) a cursor walk to exhaustion yields EXACTLY the full tool set — count and name-set derived
//       INDEPENDENTLY from the committed static template (SO #34: the gate recomputes its expected
//       value from the primary source, it does not trust the endpoint under test);
//   (c) every page stays under the budget;
//   (d) an invalid cursor is refused -32602 (spec Invalid params), never served page one.
async function paginationConformance() {
  const readPage = async (params, id) => {
    const res = await pacedFetch(URL, () => ({
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: ACCEPT, 'mcp-protocol-version': PROTO },
      body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/list', params }),
      signal: AbortSignal.timeout(TIMEOUT),
    }), params.cursor ? 'pagination page' : 'pagination page 1');
    const text = await res.text();
    if (res.status !== 200) throw new Error(`tools/list (params ${JSON.stringify(params)}) HTTP ${res.status}: ${text.slice(0, 200)}`);
    const line = text.split('\n').find((l) => l.startsWith('data: '));
    return { bytes: text.length, obj: JSON.parse((line || text).replace(/^data:\s*/, '')) };
  };

  // (a) + (c) page one, no cursor
  const p1 = await readPage({}, 700);
  if (p1.obj?.result?.resultType !== 'complete') throw new Error(`page one resultType is "${p1.obj?.result?.resultType}", expected "complete"`);
  const p1Names = (p1.obj.result.tools ?? []).map((t) => t.name);
  if (!p1Names.length) throw new Error('page one returned no tools');
  if (typeof p1.obj.result.nextCursor !== 'string') throw new Error('page one carries no nextCursor — pagination regressed to a single 1.74MB reply');
  if (p1.bytes >= 200 * 1024) throw new Error(`page one body is ${p1.bytes}B — at/above the ~200KB thin-client ceiling`);
  // MCP-TOOLSLIST-TRIM-DESCRIBE-1: list entries carry no outputSchema (one describe_tool call away).
  const p1SchemaEntries = (p1.obj.result.tools ?? []).filter((t) => 'outputSchema' in t).length;
  if (p1SchemaEntries) throw new Error(`page one carries ${p1SchemaEntries} outputSchema entries — the describe_tool trim regressed`);

  // (b) independent expectation from the committed template
  const tplPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'mcp', 'static', 'tools-list.sse.txt');
  const tplLine = readFileSync(tplPath, 'utf8').split('\n').find((l) => l.startsWith('data: '));
  const tplTools = JSON.parse(tplLine.slice(6).replace('__OCG_ID__', '12345')).result.tools.map((t) => t.name);
  const tplSet = new Set(tplTools);

  const walked = [...p1Names];
  const pageBytes = [p1.bytes];
  let cursor = p1.obj.result.nextCursor;
  for (let page = 2, id = 701; cursor; page++, id++) {
    const p = await readPage({ cursor }, id);
    if (p.obj?.result?.resultType !== 'complete') throw new Error(`page ${page} resultType is "${p.obj?.result?.resultType}", expected "complete"`);
    if (p.bytes >= 200 * 1024) throw new Error(`page ${page} body is ${p.bytes}B — at/above the ~200KB thin-client ceiling`);
    const schemaEntries = (p.obj.result.tools ?? []).filter((t) => 'outputSchema' in t).length;
    if (schemaEntries) throw new Error(`page ${page} carries ${schemaEntries} outputSchema entries — the describe_tool trim regressed`);
    walked.push(...(p.obj.result.tools ?? []).map((t) => t.name));
    pageBytes.push(p.bytes);
    cursor = p.obj.result.nextCursor;
    if (page > 100) throw new Error('cursor walk did not terminate within 100 pages');
  }
  const walkSet = new Set(walked);
  if (walked.length !== walkSet.size) throw new Error(`cursor walk returned ${walked.length} names with duplicates (${walkSet.size} unique)`);
  if (walked.length !== tplTools.length) throw new Error(`cursor walk yielded ${walked.length} tools, but the committed template carries ${tplTools.length}`);
  for (const n of tplTools) if (!walkSet.has(n)) throw new Error(`cursor walk is missing tool "${n}" (template carries it)`);
  if (walkSet.size !== tplSet.size) throw new Error(`cursor walk advertises a tool the committed template does not carry (${walkSet.size} vs ${tplSet.size} unique)`);

  // (d) invalid cursor → -32602
  const bad = await pacedFetch(URL, () => ({
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: ACCEPT, 'mcp-protocol-version': PROTO },
    body: JSON.stringify({ jsonrpc: '2.0', id: 790, method: 'tools/list', params: { cursor: 'v1.999999999' } }),
    signal: AbortSignal.timeout(TIMEOUT),
  }), 'pagination invalid-cursor');
  const badObj = JSON.parse(await bad.text());
  if (badObj?.error?.code !== -32602) throw new Error(`invalid cursor returned ${badObj?.error ? badObj.error.code : 'a result'}, expected -32602`);

  return { pages: pageBytes.length, total: walked.length, maxPageBytes: Math.max(...pageBytes), pageOneBytes: p1.bytes, pageOneTools: p1Names.length, names: walked };
}

// MCP-TOOLSLIST-TRIM-DESCRIBE-1 — describe_tool is the server-side answer to the trimmed list:
//   (a) page one lists describe_tool (every page does — the full set is behind the walk);
//   (b) describe_tool("<schema-bearing tool>") returns the FULL definition — name, description,
//       inputSchema, outputSchema, annotations, lifecycle_status — and the outputSchema is
//       byte-consistent with the vendored manifest projection (sha256 over canonical JSON, same
//       serialization both sides: data/mcp/output-schemas.json);
//   (c) an unknown name is a JSON-RPC PROTOCOL error, -32602, carrying error.data.nearest_names
//       (the nearest names from find_tool's BM25 index) — never a tool result, never a 500.
async function describeToolConformance() {
  const p1 = await call('tools/list', {}, 750);
  if (p1.error) throw new Error(`describe_tool page-one listing: tools/list error ${p1.error.code}: ${p1.error.message}`);
  const p1Names = (p1.result?.tools ?? []).map((t) => t.name);
  if (!p1Names.includes('describe_tool')) throw new Error('tools/list page one does not list describe_tool');

  const name = 'recompute_payment_waterfall';
  const ok = await call('tools/call', { name: 'describe_tool', arguments: { name } }, 751);
  if (ok.error) throw new Error(`describe_tool("${name}") error ${ok.error.code}: ${ok.error.message}`);
  if (ok.result?.isError) throw new Error(`describe_tool("${name}") isError: ` + JSON.stringify(ok.result.content).slice(0, 200));
  const def = ok.result?.structuredContent;
  for (const k of ['name', 'description', 'inputSchema', 'outputSchema', 'lifecycle_status']) {
    if (def?.[k] === undefined) throw new Error(`describe_tool("${name}") structuredContent missing "${k}": ` + JSON.stringify(def).slice(0, 200));
  }
  if (def.name !== name) throw new Error(`describe_tool returned "${def.name}", expected "${name}"`);
  let expected;
  try { expected = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'mcp', 'output-schemas.json'), 'utf8'))[name]; } catch { /* CI always has the vendored file */ }
  if (expected) {
    const h = (o) => createHash('sha256').update(JSON.stringify(o)).digest('hex');
    if (h(def.outputSchema) !== h(expected)) throw new Error(`describe_tool("${name}") outputSchema sha256 ${h(def.outputSchema)} != vendored projection ${h(expected)} — the schema describe_tool serves diverged from the manifest`);
    return { name, sha256: h(expected), described: true };
  }
  return { name, described: true, vendoredProjection: 'unreadable' };
}

async function describeToolUnknownName() {
  const nope = await call('tools/call', { name: 'describe_tool', arguments: { name: 'nope' } }, 752);
  if (!nope.error) throw new Error('describe_tool("nope") returned a result — expected a JSON-RPC -32602 protocol error');
  if (nope.error.code !== -32602) throw new Error(`describe_tool("nope") returned ${nope.error.code}, expected -32602`);
  if (!Array.isArray(nope.error?.data?.nearest_names)) throw new Error('describe_tool("nope") -32602 carries no error.data.nearest_names — callers get no next step');
  return { code: nope.error.code, nearest: nope.error.data.nearest_names };
}

// PROMPTS-GET-SPEC-FIX-1 — post-deploy proof of the prompts/get spec fix, on the LIVE endpoint.
// same-law-three-doorways is the showcase prompt whose old answer (ONE message whose content was
// the ARRAY [text, resource_link × 3]) failed the official SDK's GetPromptResultSchema and made
// every SDK client unable to fetch it (live-measured 2026-09-24). The deployed worker must answer
// with a result that parses under that SAME schema, every message carrying exactly one content
// block, and message 0 keeping the "Verify at:" appendix that replaced the resource_link array.
async function promptGetConformance() {
  const { result, error } = await call('prompts/get', {
    name: 'same-law-three-doorways',
    arguments: { node_page: 'https://ainumbers.co/chaingraph/art-129-webbotauth-signature-verifier.html' },
  }, 801);
  if (error) throw new Error(`prompts/get error ${error.code}: ${error.message}`);
  const parsed = GetPromptResultSchema.safeParse(result);
  if (!parsed.success) {
    const issues = (parsed.error?.issues ?? []).slice(0, 3)
      .map((i) => (i.path ?? []).join('.') + ': ' + i.message).join(' | ');
    throw new Error(`prompts/get same-law-three-doorways fails GetPromptResultSchema (PROMPTS-GET-SPEC-FIX-1 regression): ${issues}`);
  }
  const bad = (parsed.data.messages ?? []).filter((m) => Array.isArray(m.content) || !m.content).length;
  if (bad) throw new Error(`prompts/get same-law-three-doorways: ${bad} message(s) without exactly one content block`);
  const text = parsed.data.messages?.[0]?.content?.text ?? '';
  if (!text.includes('Verify at:')) throw new Error('prompts/get same-law-three-doorways message 0 lost the "Verify at:" appendix');
  return { messages: parsed.data.messages.length, chars: text.length };
}

async function exportRoundTrip(names) {
  // 1) Discovery — export_artifact must be registered. Reuses the names the ONE cursor walk in
  //    paginationConformance() already collected (MCP-SMOKE-CI-EXEMPTION-1: no second walk — the
  //    full set is behind the pagination walk, not any single page).
  if (!names?.length) throw new Error('exportRoundTrip received no walked tool names');
  if (!names.includes('export_artifact')) throw new Error(`export_artifact not in tools/list (${names.length} tools over the shared cursor walk)`);

  // 2) Round-trip — minimal v0.4 artifact in, xlsx blob out.
  const execution_hash = 'sha256:smoke0000000000000000000000000000000000000000000000000000000000';
  const artifact = {
    chaingraph_version: '0.4.0', tool_id: 'ci-smoke', mandate_type: 'treasury_mandate', compute_mode: 'server',
    execution_hash, chain: { parent_hashes: [], parent_tool_ids: [], chain_depth: 0 },
    policy_parameters: { smoke: true }, output_payload: { verdict: 'OK', value: 42 }, compliance_flags: [],
  };
  const out = await call('tools/call', { name: 'export_artifact', arguments: { artifact, format: 'xlsx' } }, 3);
  if (out.error) throw new Error(`tools/call error ${out.error.code}: ${out.error.message}`);
  const r = out.result;
  if (r?.isError) throw new Error('export_artifact isError: ' + JSON.stringify(r.content).slice(0, 300));
  const sc = r?.structuredContent;
  if (!sc?.bytes_base64) throw new Error('export_artifact returned no bytes_base64: ' + JSON.stringify(r).slice(0, 300));
  const bytes = Buffer.from(sc.bytes_base64, 'base64');
  if (!(bytes[0] === 0x50 && bytes[1] === 0x4b)) throw new Error('export_artifact xlsx is not a ZIP (no PK magic)');
  if (sc.metadata?.execution_hash !== execution_hash) throw new Error('export_artifact metadata execution_hash mismatch');
  return { tools: names.length, bytes: bytes.length };
}

// Deploy-propagation guard (MCP-SMOKE-PAGINATION-BUDGET-1). A Cloudflare deploy reaches edges
// one at a time: for a short window, page one can be answered by an edge running the NEW worker
// while the follow-up cursor request lands on an edge still running the OLD one — which does not
// know the `v1.<offset>` grammar and answers -32602. That is the `-32602 on attempt 1, never
// again` signature in runs 35287594400 / 35289335824, and it is NOT a pagination regression.
// So before any conformance or cursor walk: poll no-cursor tools/list until two CONSECUTIVE
// answers carry the same nextCursor AND that cursor is actually accepted. Bounded, with its own
// distinct message so a real regression is never misread as propagation (or as a 429).
async function propagationGuard() {
  const deadline = Date.now() + PROPAGATION_MS;
  let prev;
  let polls = 0;
  let lastReason = 'no poll completed';
  while (Date.now() < deadline) {
    polls++;
    const { result, error } = await call('tools/list', {}, 900 + polls);
    if (error) throw new Error(`propagation poll: tools/list error ${error.code}: ${error.message}`);
    const cur = result?.nextCursor;
    if (typeof cur !== 'string') throw new Error('propagation poll: page one carries no nextCursor — pagination is not live on this deploy');
    if (prev !== cur) { prev = cur; lastReason = 'nextCursor still changing between edges'; continue; }
    polls++;
    try {
      const probe = await call('tools/list', { cursor: cur }, 900 + polls);
      if (!probe.error) return { polls, cursor: cur };
      if (probe.error.code !== -32602) throw new Error(`propagation probe: tools/list error ${probe.error.code}: ${probe.error.message}`);
    } catch (e) {
      if (e && e.rateLimited) throw e;
      if (!/-32602/.test(e.message)) throw e;
    }
    // An edge still on the old build refused our token. Re-converge from scratch.
    prev = undefined;
    lastReason = 'an edge still refuses the issued cursor (-32602) — old worker still serving';
  }
  throw new Error(`propagation not converged within ${PROPAGATION_MS}ms over ${polls} polls: ${lastReason}`);
}

// The step-1 measurement, printed on every run so the request budget is never guessed again.
function budgetSummary() {
  const secs = ((Date.now() - START_MS) / 1000).toFixed(1);
  const perWindow = (requestCount / Math.max(1, (Date.now() - START_MS) / RL_WINDOW_MS)).toFixed(1);
  console.log(`· budget: ${requestCount} requests in ${secs}s (~${perWindow}/window of ${RL_WINDOW_MS}ms; limiter ${RL_LIMIT}, paced ceiling ${RL_BUDGET})`);
}

// Offline self-test of the pacer — the deterministic gate for this change. Stubs global fetch,
// shrinks the window so the SHIPPED math runs fast, and asserts the three properties that matter:
// spacing, sliding-window ceiling, and 429 → one-window drain → same request retried.
async function selfTest() {
  const fails = [];
  const ok = (cond, msg) => { if (!cond) fails.push(msg); };
  const init = () => ({ method: 'POST' });

  // (1) spacing + window ceiling. limit 6, headroom 3 → budget 3 per 600ms → spacing 200ms.
  RL_LIMIT = 6; RL_WINDOW_MS = 600; RL_HEADROOM = 3; recomputePace();
  ok(RL_BUDGET === 3, `budget math: expected 3, got ${RL_BUDGET}`);
  ok(RL_SPACING_MS === 200, `spacing math: expected 200, got ${RL_SPACING_MS}`);
  const stamps = [];
  globalThis.fetch = async () => { stamps.push(Date.now()); return new Response('{}', { status: 200 }); };
  START_MS = Date.now(); MAX_WALL_MS = 60000; requestCount = 0; resetPace();
  for (let i = 0; i < 9; i++) await pacedFetch('https://example.invalid/', init, 'self-test pace');
  ok(stamps.length === 9, `expected 9 sends, got ${stamps.length}`);
  ok(requestCount === 9, `expected requestCount 9, got ${requestCount}`);
  for (let i = 1; i < stamps.length; i++) {
    ok(stamps[i] - stamps[i - 1] >= RL_SPACING_MS - 30, `send ${i} came ${stamps[i] - stamps[i - 1]}ms after ${i - 1}, below the ${RL_SPACING_MS}ms spacing`);
  }
  for (const t of stamps) {
    const inWindow = stamps.filter((s) => s > t - RL_WINDOW_MS && s <= t).length;
    ok(inWindow <= RL_BUDGET, `${inWindow} sends inside one ${RL_WINDOW_MS}ms window — above the ${RL_BUDGET} ceiling`);
  }

  // (2) a 429 drains one full window + 1s and retries THE SAME request; the pass is not restarted.
  let calls = 0; const times = [];
  globalThis.fetch = async () => {
    times.push(Date.now()); calls++;
    return calls === 1 ? new Response('rate limited', { status: 429 }) : new Response('{}', { status: 200 });
  };
  START_MS = Date.now(); resetPace();
  const res = await pacedFetch('https://example.invalid/', init, 'self-test 429');
  ok(res.status === 200, `expected the retry to return 200, got ${res.status}`);
  ok(calls === 2, `expected exactly 2 sends (429 then retry), got ${calls}`);
  ok(times[1] - times[0] >= RL_BACKOFF_MS - 50, `429 backoff was ${times[1] - times[0]}ms, expected ≥ ${RL_BACKOFF_MS}ms (window + 1s)`);

  // (3) a persistent 429 surfaces a rate-limited error rather than looping forever.
  calls = 0;
  globalThis.fetch = async () => { calls++; return new Response('rate limited', { status: 429 }); };
  START_MS = Date.now(); MAX_WALL_MS = 3000; resetPace();
  let caught;
  try { await pacedFetch('https://example.invalid/', init, 'self-test 429-persistent'); } catch (e) { caught = e; }
  ok(!!caught && caught.rateLimited === true, 'a persistent 429 must throw a rateLimited error');

  // (4) the wall cap is real.
  START_MS = Date.now() - 10_000; MAX_WALL_MS = 1000;
  let wallErr;
  try { await pacedFetch('https://example.invalid/', init, 'self-test wall'); } catch (e) { wallErr = e; }
  ok(!!wallErr && /wall-clock budget/.test(wallErr.message), 'an exhausted wall budget must throw "wall-clock budget"');

  if (fails.length) {
    console.error('✗ smoke-mcp pacer self-test FAILED:');
    for (const f of fails) console.error('  · ' + f);
    process.exit(1);
  }
  console.log('✓ smoke-mcp pacer self-test OK — spacing, sliding-window ceiling, 429 one-window drain + same-request retry, persistent-429 surfacing, wall cap');
}

(async () => {
  if (SELF_TEST) { await selfTest(); return; }
  let lastErr;
  for (let i = 1; i <= RETRIES; i++) {
    try {
      START_MS = Date.now();
      requestCount = 0;
      resetPace();
      console.log(`· pacing: ${PACE_ON ? `${RL_BUDGET} req / ${RL_WINDOW_MS}ms (limiter ${RL_LIMIT}, headroom ${RL_HEADROOM}), ≥${RL_SPACING_MS}ms apart, 429 backoff ${RL_BACKOFF_MS}ms ×${RL_429_RETRIES}, wall cap ${MAX_WALL_MS}ms` : 'DISABLED (MCP_SMOKE_PACE=0)'}`);

      const info = await phase('initialize', initialize);
      console.log(`✓ /mcp initialize OK — ${info.name} v${info.version} (${URL})`);

      const prop = await phase('propagation', propagationGuard);
      console.log(`✓ deploy propagation converged — stable nextCursor "${prop.cursor}" accepted after ${prop.polls} paced polls`);

      const vn = await phase('version-negotiation', versionNegotiationHonesty);
      console.log(`✓ version-negotiation honesty OK — requested "${vn.requested}" got server version "${vn.negotiated}" (not echoed)`);

      const sep = await phase('SEP-2243', sep2243HeaderValidation);
      console.log(`✓ SEP-2243 headers OK — mismatch rejected with HTTP 400 / ${sep.code} (HeaderMismatch); header-less legacy request still lists ${sep.legacyTools} tools`);

      const ut = await phase('unknown-tool', unknownToolErrorCode);
      console.log(`✓ MCP-728 T2 unknown-tool code OK — ${ut.unknownCode}` + (ut.deferredChecked ? `; deferred-but-real tool "${ut.deferredTool}" still resolves (§M1.1)` : ' (no deferred tool found to check §M1.1)'));

      const pv = await phase('version-rejection', protocolVersionRejection);
      console.log(`✓ MCP728-T2B protocol-version rejection OK — HTTP 400 / ${pv.code} + data.supported/data.requested + id preserved, on both the static fast path and the SDK path`);

      const era = await phase('era-2026-07-28', era2026Conformance);
      console.log(`✓ 2026-07-28 era OK — server/discover (${era.supported} versions, SEP-1865 ui advertised), resultType on ${era.tools} tools, unknown method 404/-32601 modern + 200 legacy, DELETE 405`);

      const pg = await phase('pagination-conformance', paginationConformance);
      console.log(`✓ MCP-TOOLSLIST-PAGINATION-1 OK — no-cursor page 1 valid (${pg.pageOneTools} tools, ${pg.pageOneBytes}B); cursor walk to exhaustion: ${pg.total} tools over ${pg.pages} pages (max page ${pg.maxPageBytes}B), full set matches the committed template; invalid cursor -32602`);

      const dt = await phase('describe-tool', describeToolConformance);
      console.log(`✓ MCP-TOOLSLIST-TRIM-DESCRIBE-1 OK — describe_tool listed on page one; describe_tool("${dt.name}") full definition, outputSchema sha256 ${dt.sha256} == vendored projection`);

      const dn = await phase('describe-tool-unknown', describeToolUnknownName);
      console.log(`✓ describe_tool unknown-name OK — -32602 with error.data.nearest_names (${dn.nearest.length} nearest)`);

      const pq = await phase('prompt-get', promptGetConformance);
      console.log(`✓ PROMPTS-GET-SPEC-FIX-1 OK — live prompts/get same-law-three-doorways is GetPromptResultSchema-valid (${pq.messages} message(s), ${pq.chars}-char text block with the Verify-at appendix)`);

      if (process.env.MCP_SMOKE_SKIP_EXPORT === '1') {
        console.log('  (export_artifact round-trip skipped via MCP_SMOKE_SKIP_EXPORT=1)');
        budgetSummary();
        process.exitCode = 0; return;
      }
      const x = await phase('export-round-trip', () => exportRoundTrip(pg.names));
      console.log(`✓ export_artifact round-trip OK — xlsx blob ${x.bytes}B (PK zip), hash carried, ${x.tools} tools listed`);

      const rc = await phase('rc-no-initialize', rcNoInitializePath);
      console.log(`✓ §M1.6 RC path (no initialize) OK — tools/list + tools/call answered directly, ${rc.tools} tools listed`);

      const ts = await phase('named-toolset', toolsetProfile);
      console.log(`✓ §M1.2 named toolset OK — ?toolset=reserve advertises ${ts.nonDeferred} non-deferred tools (lean core + reserve profile)`);

      budgetSummary();
      process.exitCode = 0; return;
    } catch (e) {
      lastErr = e;
      console.error(`  attempt ${i}/${RETRIES} failed: ${e.message}`);
      budgetSummary();
      if (i < RETRIES) await new Promise((r) => setTimeout(r, DELAY));
    }
  }
  console.error(`\n✗ /mcp smoke test FAILED after ${RETRIES} attempts: ${lastErr && lastErr.message}`);
  console.error('  Either the MCP handshake is broken (tool-registration throw in buildServer()) or the');
  console.error('  export_artifact round-trip failed. Roll back in Cloudflare → ainumbers-mcp → Deployments.');
  process.exit(1);
})();
