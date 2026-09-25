// Build-time precompute of the static MCP discovery responses.
//
// WHY: the Worker runs on the Cloudflare FREE plan (low per-invocation CPU). buildServer()
// registers ~160 tools and the SDK converts every tool's zod schema -> JSON Schema on each
// tools/list — rebuilding that per request on a cold isolate trips Cloudflare error 1102
// (exceeded CPU). These four discovery responses are immutable per deploy, so we capture them
// ONCE here (Node, unlimited CPU) and the Worker serves them statically — never rebuilding the
// server for initialize/tools/list/resources/list/prompts/list. Only tools/call still builds.
//
// HOW: import the REAL buildServer from worker.mjs and drive it through an in-memory transport
// at the RAW JSON-RPC layer (not the high-level Client, which validates and would strip
// execution/_meta/defaultConfig fields). The captured bytes therefore equal what the Worker's
// SDK path emits today — verified by a byte-diff against a live server in CI/local.
//
// Run:  node scripts/precompute-discovery.mjs   (also invoked at the end of generate.mjs)

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer, widgetGlue, stripCspMeta, HOT_TOOLS, orderToolsHotFirst, CALL_TOOL_NAME } from '../worker.mjs';
import { PILOT } from '../pilot.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = resolve(ROOT, 'data');

// Replicate worker.mjs loadData() from disk (env.ASSETS -> filesystem). Must produce the
// same shape buildServer expects: { manifests, widgets, catalog, chaingraph, searchIndex }.
function loadDataFromDisk() {
  const get = (p) => readFileSync(resolve(DATA, p), 'utf8');
  const glue = widgetGlue(get('ext-apps-inline.js'));
  const manifests = {}, widgets = {};
  for (const slug of PILOT) {
    manifests[slug] = JSON.parse(get('manifests/' + slug + '.manifest.json'));
    widgets[slug] = stripCspMeta(get('tools/' + slug + '.html')) + glue;
  }
  let fvStatusIndex = { entries: [] };
  try { fvStatusIndex = JSON.parse(get('mcp/fv-status-index.json')); } catch { /* none yet */ }
  let recipes = null;
  try { recipes = JSON.parse(get('mcp/recipes.json')); } catch { /* none yet — suite_howto/prompt loop degrade; generate.mjs self-check is the loud gate */ }
  let showcasePrompts = null;
  try { showcasePrompts = JSON.parse(get('mcp/showcase-prompts.json')); } catch { /* none yet — showcase prompt loop degrades; generate.mjs self-check is the loud gate */ }
  // MCP-TOOLSLIST-TRIM-DESCRIBE-1: give buildServer's describe_tool the same vendored inputs the
  // worker's dispatch path uses. Both tolerant: a first-ever run has no describe map yet (this
  // script writes it), and lifecycle.json is optional by contract (defaults to all-Active).
  let describeMap = null;
  try { describeMap = JSON.parse(get('mcp/static/tool-describe.json')); } catch { /* first run — written below */ }
  let lifecycle = { default: 'Active', overrides: {} };
  try { lifecycle = JSON.parse(get('mcp/lifecycle.json')); } catch { /* none yet */ }
  return {
    manifests, widgets,
    catalog: JSON.parse(get('mcp/catalog.json')),
    chaingraph: JSON.parse(get('chaingraph/chaingraph.json')),
    searchIndex: JSON.parse(get('search-index.json')),
    fvStatusIndex,
    recipes,
    showcasePrompts,
    describeMap,
    lifecycle,
  };
}

export async function precomputeDiscovery() {
  const data = loadDataFromDisk();
  const server = buildServer(data);

  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  await clientT.start();

  // Raw JSON-RPC over the transport: resolve on the response whose id matches.
  const pending = new Map();
  clientT.onmessage = (msg) => {
    if (msg && msg.id !== undefined && pending.has(msg.id)) {
      const { resolve: r } = pending.get(msg.id);
      pending.delete(msg.id);
      r(msg);
    }
  };
  const rpc = (method, params, id) => new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    clientT.send({ jsonrpc: '2.0', id, method, params });
  });

  // Handshake (McpServer requires initialize before list calls).
  const initMsg = await rpc('initialize', {
    protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'precompute', version: '1' },
  }, 0);
  await clientT.send({ jsonrpc: '2.0', method: 'notifications/initialized' });

  const toolsMsg = await rpc('tools/list', {}, 1);

  // Tool deprecation lifecycle (§M2.2) — tools/list is served from THESE precomputed static
  // bytes at runtime (worker.mjs STATIC_DISCOVERY_METHODS fast path), so lifecycle_status must be
  // baked in here, not injected per-request. A Removed tool is DROPPED from the advertised set
  // entirely (tools/call also rejects it at request time — worker.mjs lifecycleStatusOf gate —
  // so tools/list and tools/call stay in agreement). Deprecated tools stay listed + callable,
  // just flagged (advisory).
  let lifecycle = { default: 'Active', overrides: {} };
  try { lifecycle = JSON.parse(readFileSync(resolve(DATA, 'mcp', 'lifecycle.json'), 'utf8')); } catch { /* none yet */ }
  const lifecycleStatusOf = (name) => lifecycle.overrides?.[name] ?? lifecycle.default ?? 'Active';
  toolsMsg.result.tools = toolsMsg.result.tools.filter((t) => lifecycleStatusOf(t.name) !== 'Removed');
  for (const t of toolsMsg.result.tools) t.lifecycle_status = lifecycleStatusOf(t.name);

  // outputSchema (§M1.4) — read-only projection from repo/manifests/*, attach when present.
  let outputSchemas = {};
  try { outputSchemas = JSON.parse(readFileSync(resolve(DATA, 'mcp', 'output-schemas.json'), 'utf8')); } catch { /* none yet */ }
  for (const t of toolsMsg.result.tools) if (outputSchemas[t.name]) t.outputSchema = outputSchemas[t.name];

  // ── MCP-TOOLSLIST-TRIM-DESCRIBE-1 ────────────────────────────────────────────────────────────
  // (1) Capture the FULL definitions (outputSchema still attached, descriptions still original)
  //     into the describe map describe_tool serves: data/mcp/static/tool-describe.json. Exactly
  //     the keys describe_tool's outputSchema declares — transport hints (cacheHint,
  //     defaultConfig) are deliberately not part of a definition.
  // (2) Trim outputSchema OUT of every list entry (597 tools ≈ 463KB of the 2.24MB reply), and
  //     append to each trimmed description EXACTLY ONE pointer sentence — the manifest prose
  //     itself is never rewritten. The map above keeps the original description + schema, so
  //     describe_tool("<name>") returns the definition the list no longer carries.
  const trimStats = { tools: toolsMsg.result.tools.length, trimmed: 0, outputSchemaBytes: 0, pointerBytes: 0 };
  const describeEntries = toolsMsg.result.tools.map((t) => {
    const def = { name: t.name, description: t.description, inputSchema: t.inputSchema };
    if (t.outputSchema !== undefined) { def.outputSchema = t.outputSchema; }
    if (t.annotations !== undefined) { def.annotations = t.annotations; }
    return def;
  });
  for (const t of toolsMsg.result.tools) {
    if (t.outputSchema === undefined) continue;
    const dropped = JSON.stringify(t.outputSchema);
    trimStats.outputSchemaBytes += dropped.length;
    delete t.outputSchema;
    // describe_tool itself is THE pointer target: its own (SDK-declared, self-describing) schema
    // is reachable by describing it — pointing it at itself would read as a bug, so no sentence.
    if (t.name !== 'describe_tool') {
      const pointer = ' Output schema: call describe_tool("' + t.name + '").';
      t.description += pointer;
      trimStats.trimmed++;
      trimStats.pointerBytes += pointer.length;
    }
  }
  const describeMapOut = {};
  for (const def of describeEntries) describeMapOut[def.name] = def; // registration order (page order); names unique (check-tool-names gate)

  // ttlMs cache metadata (§M1.5) — every AINumbers tool is deterministic pure compute (CONTRACT
  // zero-fetch/zero-side-effect invariant: same inputs -> same execution_hash, forever), so a
  // conservative client-side cache is always safe to advertise. The cache KEY a client should use
  // is the RFC 8785/JCS canonical `policy_parameters` preimage (the same preimage execution_hash is
  // derived from) — never wall-clock, never a session id. The worker holds no server-side cache
  // (stays stateless); this is metadata only.
  const TTL_MS = 86400000; // 24h — conservative; a tool's compute never changes for the same input.
  for (const t of toolsMsg.result.tools) {
    t.cacheHint = { ttlMs: TTL_MS, cacheKey: 'input_hash', note: 'cache by the JCS-canonical policy_parameters hash only; never by wall-clock or session' };
  }

  // ⛔ NO `defaultConfig:{defer_loading:true}` ON THE DEFAULT LIST (MCP-REACH-DISPATCH-1 D4).
  // Measured 2026-09-24: 15,620 B per full walk for a field NO host reads — `defer_loading` is a
  // CLIENT-side setting in both documented implementations (Anthropic `mcp_toolset.default_config`,
  // OpenAI `defer_loading` + `tool_search`). The named-toolset profile files below still set it on
  // their non-advertised entries; those five files are untouched by this row (spec §T rules on them).
  //
  // MCP-REACH-DISPATCH-1 D2 — hot tools to page-1 positions 1-13, via the ONE ordering function
  // worker.mjs's runtime fallback path also calls. Applied BEFORE framing, so every artifact below
  // (default list, profile lists, the paginated pages the worker slices out of these bytes) shares
  // one order. Registration order had left the hot set at positions 17-34 (R-P6).
  toolsMsg.result.tools = orderToolsHotFirst(toolsMsg.result.tools);

  // MCP-REACH-DISPATCH-1 D1 — the GENERATED dispatch allowlist. Derived here, from the SAME tool
  // definitions the list serves, so it can never drift from what is advertised: every tool whose
  // annotations say readOnlyHint===true AND openWorldHint===false, minus call_tool itself.
  // ⛔ FAIL CLOSED: a tool missing either annotation is EXCLUDED, because "unannotated" and
  // "harmless" are different claims. Measured 2026-09-24: 722/722 tools carry both hints; 712 are
  // eligible and 10 are not (8 not read-only + 2 open-world).
  const allowTools = [];
  const excludedTools = [];
  for (const t of toolsMsg.result.tools) {
    if (t.name === CALL_TOOL_NAME) continue;
    const a = t.annotations ?? {};
    if (a.readOnlyHint === true && a.openWorldHint === false) allowTools.push(t.name);
    else excludedTools.push(t.name);
  }

  // MCP-REACH-DISPATCH-1 D1 — the non-node tool index for find_tool. search-index.json (vendored
  // from the site repo) indexes ChainGraph NODES only, so before this file no discovery tool could
  // name a utility or widget tool. Emitted for exactly those: every served tool that is not a node
  // mcp_name. Descriptions are capped — find_tool returns at most 3 of these per call.
  const nodeNames = new Set((data.chaingraph?.nodes ?? []).map((n) => n.mcp_name).filter(Boolean));
  const utilityIndexTools = toolsMsg.result.tools
    .filter((t) => !nodeNames.has(t.name))
    .map((t) => ({ name: t.name, title: t.title ?? null, description: String(t.description ?? '').slice(0, 400) }));

  let resources = [], prompts = [];
  try { resources = (await rpc('resources/list', {}, 2)).result.resources ?? []; } catch { /* none */ }
  try { prompts   = (await rpc('prompts/list',   {}, 3)).result.prompts   ?? []; } catch { /* none */ }

  await clientT.close(); await server.close();

  // initialize result is constant per deploy EXCEPT protocolVersion (echoes the client's
  // requested version at runtime). Store capabilities + serverInfo; the Worker fills
  // protocolVersion from the live request.
  const initResult = initMsg.result;

  mkdirSync(resolve(DATA, 'mcp', 'static'), { recursive: true });
  const w = (name, obj) => writeFileSync(resolve(DATA, 'mcp', 'static', name), JSON.stringify(obj) + '\n');
  // initialize stays a small parsed object (protocolVersion is echoed from the live request).
  // MCP-REACH-DISPATCH-1 D2: `instructions` is captured from the REAL server result (McpServer was
  // constructed with SERVER_INSTRUCTIONS), never re-typed here — worker.mjs serves these bytes on
  // both `initialize` and `server/discover`, so all three surfaces carry one string by construction.
  if (initResult.instructions && initResult.instructions.length > 600) {
    throw new Error('precompute: initialize.instructions is ' + initResult.instructions.length
      + ' chars — the MCP-REACH-DISPATCH-1 D2 bound is 600 (it is prepended to model context every session)');
  }
  w('initialize.json', { protocolVersion: initResult.protocolVersion, capabilities: initResult.capabilities, serverInfo: initResult.serverInfo,
                         ...(initResult.instructions ? { instructions: initResult.instructions } : {}) });

  // MCP-REACH-DISPATCH-1 D1 — the dispatch allowlist, one directory up from the static bytes
  // (worker.mjs getDispatchAllowlist reads mcp/dispatch-allowlist.json). Sorted for a stable diff.
  mkdirSync(resolve(DATA, 'mcp'), { recursive: true });
  writeFileSync(resolve(DATA, 'mcp', 'dispatch-allowlist.json'), JSON.stringify({
    generated_by: 'scripts/precompute-discovery.mjs (MCP-REACH-DISPATCH-1 D1)',
    rule: 'annotations.readOnlyHint === true && annotations.openWorldHint === false, minus ' + CALL_TOOL_NAME + '; a tool missing either annotation is excluded (fail closed)',
    tool_count: allowTools.length,
    excluded_count: excludedTools.length,
    excluded: [...excludedTools].sort(),
    tools: [...allowTools].sort(),
  }, null, 2) + '\n');
  writeFileSync(resolve(DATA, 'mcp', 'utility-tool-index.json'), JSON.stringify({
    generated_by: 'scripts/precompute-discovery.mjs (MCP-REACH-DISPATCH-1 D1)',
    note: 'non-node (utility + PILOT widget) tools, so find_tool can name them; search-index.json covers nodes only',
    tool_count: utilityIndexTools.length,
    tools: utilityIndexTools,
  }) + '\n');

  // LIST responses → PRE-FRAMED SSE text with an id placeholder, so the Worker serves them with a
  // single string replace (no JSON.parse / no re-stringify of the ~330KB tools/list on a cold
  // isolate). id is placed FIRST so the splice scans only ~25 chars. The framed JSON is byte-for-
  // byte what the Worker emitted before (envelope {jsonrpc,id,result} + the same result object), so
  // served output is unchanged — verified by byte-diff. Assert the placeholder is unique (never
  // appears inside the payload itself).
  const ID_PLACEHOLDER = '__OCG_ID__';
  const wtxt = (name, str) => writeFileSync(resolve(DATA, 'mcp', 'static', name), str);
  // ⭐ THE SINGLE FRAMING POINT for tools/list and every named-toolset profile. `resultType` is
  // stamped HERE, once, rather than on 548 tools — the FINAL text requires "The result MUST
  // include a resultType field", and "complete" is the defined value for a finished result
  // (MCP728-CONFORM-FIX-2). The worker's SDK fallback path stamps the same field the same way,
  // so static bytes and SDK output stay in agreement.
  const frame = (label, resultObj) => {
    const txt = 'event: message\ndata: {"jsonrpc":"2.0","id":' + ID_PLACEHOLDER + ',"result":' + JSON.stringify({ resultType: 'complete', ...resultObj }) + '}\n\n';
    if (txt.split(ID_PLACEHOLDER).length !== 2) throw new Error('precompute: id placeholder collision in ' + label + ' — choose a more unique ID_PLACEHOLDER');
    return txt;
  };
  wtxt('tools-list.sse.txt',     frame('tools/list',     { tools: toolsMsg.result.tools }));
  wtxt('resources-list.sse.txt', frame('resources/list', { resources }));
  wtxt('prompts-list.sse.txt',   frame('prompts/list',   { prompts }));

  // Named toolsets (§M1.2) — one extra static tools-list per profile: lean §M1.1 core (9 names,
  // never deferred) UNION the profile's members (also never deferred — "expands the advertised
  // set to that domain's tools on top of the lean core"), everything else stays defer_loading:true.
  // Generator-emitted membership only (data/mcp/toolsets.json, written by generate.mjs) — no
  // hand-typed list here. A client requests one via ?toolset=<name> on /mcp (worker.mjs).
  let toolsetProfiles = {};
  try { toolsetProfiles = JSON.parse(readFileSync(resolve(DATA, 'mcp', 'toolsets.json'), 'utf8')).profiles ?? {}; } catch { /* none yet */ }
  const profileNames = [];
  for (const [profile, members] of Object.entries(toolsetProfiles)) {
    const advertised = new Set([...HOT_TOOLS, ...members]);
    const profileTools = toolsMsg.result.tools.map((t) => {
      const clone = { ...t };
      if (advertised.has(t.name)) delete clone.defaultConfig;
      else clone.defaultConfig = { defer_loading: true };
      return clone;
    });
    wtxt('tools-list.' + profile + '.sse.txt', frame('tools/list:' + profile, { tools: profileTools }));
    profileNames.push(profile);
  }

  // describe_tool map (MCP-TOOLSLIST-TRIM-DESCRIBE-1) — one entry per SERVED (non-Removed) tool,
  // keyed by mcp_name, single-line JSON so the worker's O(entry) extractor can slice it without a
  // full-map parse (worker.mjs getDescribeTemplate/extractDescribeEntry).
  writeFileSync(resolve(DATA, 'mcp', 'static', 'tool-describe.json'), JSON.stringify(describeMapOut));
  console.log('tools/list trim: dropped outputSchema from ' + trimStats.trimmed + '/' + trimStats.tools
    + ' entries (' + trimStats.outputSchemaBytes + 'B of schemas out, +' + trimStats.pointerBytes
    + 'B of pointer sentences in); describe map: ' + Object.keys(describeMapOut).length
    + ' entries -> data/mcp/static/tool-describe.json');

  console.log('dispatch allowlist: ' + allowTools.length + ' eligible, ' + excludedTools.length
    + ' excluded -> data/mcp/dispatch-allowlist.json; utility index: ' + utilityIndexTools.length
    + ' non-node tools -> data/mcp/utility-tool-index.json');
  return { tools: toolsMsg.result.tools.length, resources: resources.length, prompts: prompts.length, toolsets: profileNames,
           dispatchAllowlist: allowTools.length, dispatchExcluded: excludedTools.length };
}

// Standalone invocation
if (process.argv[1] && process.argv[1].endsWith('precompute-discovery.mjs')) {
  precomputeDiscovery()
    .then((r) => console.log('precomputed discovery static responses:', r))
    .catch((e) => { console.error('precompute-discovery FAILED:', e); process.exit(1); });
}
