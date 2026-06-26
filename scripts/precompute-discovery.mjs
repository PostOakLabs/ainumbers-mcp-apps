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
import { buildServer, widgetGlue, stripCspMeta, HOT_TOOLS } from '../worker.mjs';
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
  return {
    manifests, widgets,
    catalog: JSON.parse(get('mcp/catalog.json')),
    chaingraph: JSON.parse(get('chaingraph/chaingraph.json')),
    searchIndex: JSON.parse(get('search-index.json')),
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
  // Inject defer_loading exactly as the Worker does at runtime (worker.mjs tools/list branch).
  for (const t of toolsMsg.result.tools) if (!HOT_TOOLS.has(t.name)) t.defaultConfig = { defer_loading: true };

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
  w('initialize.json',      { protocolVersion: initResult.protocolVersion, capabilities: initResult.capabilities, serverInfo: initResult.serverInfo });
  w('tools-list.json',      { tools: toolsMsg.result.tools });
  w('resources-list.json',  { resources });
  w('prompts-list.json',    { prompts });

  return { tools: toolsMsg.result.tools.length, resources: resources.length, prompts: prompts.length };
}

// Standalone invocation
if (process.argv[1] && process.argv[1].endsWith('precompute-discovery.mjs')) {
  precomputeDiscovery()
    .then((r) => console.log('precomputed discovery static responses:', r))
    .catch((e) => { console.error('precompute-discovery FAILED:', e); process.exit(1); });
}
