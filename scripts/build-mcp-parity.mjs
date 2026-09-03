// build-mcp-parity.mjs — prove the O(1) single-tool buildServer is byte-identical to the full build.
//
// WHY: worker.mjs buildServer(data, {onlyTool}) now early-skips constructing every non-requested
// node's zod schema/description/closure (kills the cold-isolate 1102). This asserts that for any
// requested tool, the registered tool DEFINITION (name/description/inputSchema/annotations, as
// emitted by tools/list) is IDENTICAL whether built full or single-tool — so responses are
// unchanged. Definition parity (not tools/call output) is compared because some node handlers stamp
// a non-deterministic timestamp; the definition is what the build path affects.
//
// Also captures the SDK's exact unknown-tool error shape so the worker's unknown-tool short-circuit
// can emit a byte-identical JSON-RPC error.
//
// Run: node scripts/build-mcp-parity.mjs

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer, widgetGlue, stripCspMeta, KNOWN_REQUEST_METHODS } from '../worker.mjs';
import { PILOT } from '../pilot.mjs';
import { UTILITY_TOOL_NAMES } from '../utility-tools.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = resolve(ROOT, 'data');

function loadDataFromDisk() {
  const get = (p) => readFileSync(resolve(DATA, p), 'utf8');
  const glue = widgetGlue(get('ext-apps-inline.js'));
  const manifests = {}, widgets = {};
  for (const slug of PILOT) {
    manifests[slug] = JSON.parse(get('manifests/' + slug + '.manifest.json'));
    widgets[slug] = stripCspMeta(get('tools/' + slug + '.html')) + glue;
  }
  return {
    manifests, widgets,
    catalog: JSON.parse(get('mcp/catalog.json')),
    chaingraph: JSON.parse(get('chaingraph/chaingraph.json')),
    searchIndex: JSON.parse(get('search-index.json')),
  };
}

// Drive a server through one initialize + one request at the raw JSON-RPC layer.
async function rpcOnce(server, method, params) {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  await clientT.start();
  const pending = new Map();
  clientT.onmessage = (msg) => {
    if (msg && msg.id !== undefined && pending.has(msg.id)) {
      const { resolve: r } = pending.get(msg.id); pending.delete(msg.id); r(msg);
    }
  };
  const rpc = (m, p, id) => new Promise((r) => { pending.set(id, { resolve: r }); clientT.send({ jsonrpc: '2.0', id, method: m, params: p }); });
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'parity', version: '1' } }, 0);
  await clientT.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const out = await rpc(method, params, 1);
  await clientT.close(); await server.close();
  return out;
}

async function toolDef(data, name, onlyTool) {
  const server = buildServer(data, onlyTool ? { onlyTool: name } : {});
  const msg = await rpcOnce(server, 'tools/list', {});
  const tools = msg.result?.tools ?? [];
  return tools.find((t) => t.name === name) ?? null;
}

const data = loadDataFromDisk();
const liveNodes = (data.chaingraph?.nodes ?? []).filter((n) => n.status === 'live' && n.mcp_name).map((n) => n.mcp_name);
const pilotNames = PILOT.map((slug) => data.manifests[slug]?.mcp_tool_definition?.name ?? slug.replace(/-/g, '_'));
const dupNames = pilotNames.filter((n) => liveNodes.includes(n)); // pilot↔node duplicate mcp_names (dedup path)

// Sample: first/last live nodes (incl. Wave 27), 3 utilities, every pilot↔node duplicate.
const sample = [
  ...liveNodes.slice(0, 3),
  ...liveNodes.slice(-3),
  'build_chaingraph', 'list_ainumbers_tools', 'find_chain', 'emit_chaingraph_artifact',
  ...dupNames.slice(0, 3),
];
const uniqueSample = [...new Set(sample)];

let failures = 0;
for (const name of uniqueSample) {
  const full = await toolDef(data, name, false);
  const one  = await toolDef(data, name, true);
  const fS = JSON.stringify(full), oS = JSON.stringify(one);
  if (!full)            { console.error('✗ ' + name + ' — NOT in full build tools/list'); failures++; continue; }
  if (!one)             { console.error('✗ ' + name + ' — NOT registered in single-tool build'); failures++; continue; }
  if (fS !== oS)        { console.error('✗ ' + name + ' — definition DIFFERS full vs single-tool'); failures++; continue; }
  const tag = dupNames.includes(name) ? ' (pilot↔node dup)' : '';
  console.log('✓ ' + name + tag + ' — identical');
}

// CRITICAL safety check for the unknown-tool short-circuit: the worker's derived known-set
// (data.__toolNames = PILOT names + 9 utilities + live node mcp_names) MUST exactly equal the real
// registered tool set (full tools/list). If it under-covers, a VALID tool would be wrongly rejected
// with a false -32602; if it over-covers, an unknown name would route to a (harmless) full build.
const fullList = await rpcOnce(buildServer(data, {}), 'tools/list', {});
const registered = new Set((fullList.result?.tools ?? []).map((t) => t.name));
const derivedKnown = new Set([
  ...pilotNames,
  ...UTILITY_TOOL_NAMES,   // single source of truth — see utility-tools.mjs
  ...liveNodes,
]);
const missingFromDerived = [...registered].filter((n) => !derivedKnown.has(n)); // would be FALSE-rejected
const extraInDerived = [...derivedKnown].filter((n) => !registered.has(n));      // harmless (routes to full build)
if (missingFromDerived.length) { console.error('✗ known-set UNDER-covers (would false-reject): ' + missingFromDerived.join(', ')); failures++; }
else console.log('✓ known-set covers all ' + registered.size + ' registered tools (0 false-reject); ' + extraInDerived.length + ' extra (harmless)');

// ── MW2-UNKNOWN-METHOD-GUARD-1: method allowlist parity (0 false-reject) ──────────────────────
// The worker short-circuits any request method outside KNOWN_REQUEST_METHODS with -32601 WITHOUT
// building the server. That is only safe if the allowlist exactly covers every method the full
// build (SDK dispatch) would NOT answer with -32601. Derive that set INDEPENDENTLY from the SDK:
// probe the full-build server with each candidate method and record whether the SDK itself returns
// -32601 ("Method not found"). SO #34: the gate recomputes the answer from the primary source (the
// SDK's own dispatch), it never reads the allowlist it is validating as its evidence.
// ⛔ HARDCODED — deliberately NOT derived from the worker's allowlist. Deriving the probe set
// from the set under test would make an allowlist entry invisible to this gate by construction
// (mutation test: dropping 'ping' from the allowlist passed the gate until this list was pinned).
const METHOD_CANDIDATES = [
  // worker routes + static discovery:
  'initialize', 'tools/list', 'resources/list', 'prompts/list', 'server/discover', 'tools/call',
  // SDK dispatch surface (server/index.js 1.29.0) and neighbours:
  'ping', 'prompts/get', 'resources/read', 'resources/templates/list',
  'completion/complete', 'logging/setLevel', 'resources/subscribe', 'resources/unsubscribe',
  'tasks/get', 'tasks/list', 'tasks/result', 'tasks/cancel',
  // probe/garbage classes that must NOT be allowed:
  'server/info', 'resources/subscribe/extras', 'completion/foo', 'tasks/submit',
  'sampling/createMessage', 'roots/list', 'elicitation/create', 'garbage/probe/method',
  'tools/delete', 'initialize/v2',
];
const sdkHandled = [], sdkUnhandled = [];
for (const m of new Set(METHOD_CANDIDATES)) {
  const resp = await rpcOnce(buildServer(data, {}), m, {});
  if (resp.error?.code === -32601) sdkUnhandled.push(m); else sdkHandled.push(m);
}
const workerAllowed = new Set(KNOWN_REQUEST_METHODS);
// Every allowlist entry MUST have been probed — otherwise the gate is blind to it (SO #34).
const unprobed = [...workerAllowed].filter((m) => !METHOD_CANDIDATES.includes(m));
if (unprobed.length) {
  console.error('✗ allowlist entries never probed by this gate (gate blind spot): ' + unprobed.join(', '));
  failures++;
}
// FALSE-REJECT: SDK handles it but the worker would short-circuit it — changes a real answer into
// an error. NEVER permitted.
const methodFalseRejects = sdkHandled.filter((m) => !workerAllowed.has(m));
// OVER-ALLOW: worker claims it but the SDK itself answers -32601 — harmless but drift; report.
const methodOverAllow = [...workerAllowed].filter((m) => sdkUnhandled.includes(m));
if (methodFalseRejects.length) {
  console.error('✗ method allowlist UNDER-covers (would FALSE-REJECT with -32601): ' + methodFalseRejects.join(', '));
  failures++;
} else {
  console.log('✓ method allowlist covers all ' + sdkHandled.length + ' SDK-handled methods (0 false-reject); ' +
    methodOverAllow.length + ' over-allowed (SDK also answers -32601 there — harmless): ' +
    (methodOverAllow.join(', ') || 'none'));
}
// Baseline for the short-circuit: the SDK's OWN answer to a garbage method is -32601 — the worker's
// early-exit must match that code and shape.
const garbageResp = await rpcOnce(buildServer(data, {}), 'garbage/probe/method', {});
if (garbageResp.error?.code === -32601) {
  console.log('✓ SDK full-build baseline: garbage method → -32601 ' + JSON.stringify(garbageResp.error.message));
} else {
  console.error('✗ SDK full-build baseline changed: garbage method → ' + JSON.stringify(garbageResp));
  failures++;
}

// ── PRE-DEPLOY count-drift guard ──────────────────────────────────────────────
// The committed data/counts.json.mcp_tools_total MUST equal the ACTUAL registered tool count.
// This is the same assertion CI's post-deploy count-drift gate makes against the LIVE /mcp, but
// here it runs at BUILD time (no deploy needed) — so a new tool with a stale count fails in the
// "Validate MCP server" job BEFORE deploy instead of producing a bad deploy + red post-deploy gate.
const committedTotal = JSON.parse(readFileSync(resolve(DATA, 'counts.json'), 'utf8')).mcp_tools_total;
if (committedTotal !== registered.size) {
  console.error('✗ count drift: data/counts.json mcp_tools_total=' + committedTotal + ' != registered tools=' + registered.size + '. Re-run node generate.mjs and commit data/counts.json (utility count is derived from utility-tools.mjs).');
  failures++;
} else {
  console.log('✓ counts.json mcp_tools_total=' + committedTotal + ' matches ' + registered.size + ' registered tools (pre-deploy count-drift guard)');
}

// Capture the SDK's exact unknown-tool error shape (for the worker short-circuit).
const unknownName = 'definitely_not_a_real_tool_xyz';
const full = buildServer(data, {});
const errMsg = await rpcOnce(full, 'tools/call', { name: unknownName, arguments: {} });
console.log('\n--- unknown-tool tools/call response (full build) ---');
console.log(JSON.stringify(errMsg, null, 2));

console.log('\n' + (failures ? '❌ build-mcp-parity FAILED: ' + failures + ' mismatch(es)' : '✅ build-mcp-parity OK — ' + uniqueSample.length + ' tools identical (full == single-tool), ' + dupNames.length + ' pilot↔node dup(s) covered'));
process.exit(failures ? 1 : 0);
