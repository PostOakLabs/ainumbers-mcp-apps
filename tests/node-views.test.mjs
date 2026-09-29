#!/usr/bin/env node
// node-views.test.mjs — MCP-APPS-NODE-VIEWS-1 done-criteria, worker side.
//
// Asserts, against the VENDORED data/ (generate.mjs cycle, committed in the same push):
//   1. HASH SENTINEL — data/mcp/node-views.json's per-view sha256 RECOMPUTED over the vendored
//      page bytes (data/chaingraph/pages/<tool_id>.html) matches, byte counts match, and the
//      pages/ directory carries EXACTLY the view set (no strays, no gaps). This is the tie
//      between the served ui:// bytes and the site file at the vendored commit.
//   2. SIZE GUARD — every page recorded in `skipped` exceeds max_page_bytes, every view is
//      within it, and no skipped page leaked into pages/.
//   3. RESOURCES-LIST — every view is listed as `ui://ainumbers/node/<tool_id>` with the MCP
//      Apps mime type, `_meta.ui.resourceDomains` == node-views.json `resource_domains` and
//      `_meta.ui.connectDomains` == [] (connectDomains is NEVER widened); no
//      `ui://ainumbers/node/` entry exists outside the view set.
//   4. TOOL POINTER — every view's node tool (the REAL served set, from the committed static
//      tools-list bytes) carries `_meta.ui { resourceUri, visibility: ['model','app'] }`; every
//      served node tool whose page is vendored has a matching view (no orphan page, no
//      unpointed tool).
//   5. SERVE PATH — resources/read of a view uri through the REAL buildServer returns the
//      vendored bytes VERBATIM (no CSP strip, no widget glue appended — byte-identical to the
//      site file at the vendored commit) with the MCP Apps mime type; an unknown node uri is a
//      JSON-RPC error; and an onlyTool O(1) build registers NO resources at all (resources
//      stay off the tools/call path).
//
// Usage: node tests/node-views.test.mjs   (also runs under `node --test`)

import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer, widgetGlue, stripCspMeta } from '../worker.mjs';
import { PILOT } from '../pilot.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = resolve(ROOT, 'data');

const get = (p) => readFileSync(resolve(DATA, p), 'utf8');

// Parse a pre-framed static SSE list into its result object (same discipline as
// scripts/check-worker-invariants.mjs §5 — splice the id placeholder, take the data line).
function sseResult(file) {
  const txt = get('mcp/static/' + file).replace('__OCG_ID__', '12345');
  const dataLine = txt.split('\n').find((l) => l.startsWith('data:'));
  return JSON.parse(dataLine.slice(5).trim()).result;
}

// Mirror loadData()/loadDataFromDisk() (worker.mjs / scripts/precompute-discovery.mjs): the shape
// buildServer expects, with the node-view fields this row added.
function loadDataFromDisk() {
  const glue = widgetGlue(get('ext-apps-inline.js'));
  const manifests = {}, widgets = {};
  for (const slug of PILOT) {
    manifests[slug] = JSON.parse(get('manifests/' + slug + '.manifest.json'));
    widgets[slug] = stripCspMeta(get('tools/' + slug + '.html')) + glue;
  }
  let nodeViews = null;
  try { nodeViews = JSON.parse(get('mcp/node-views.json')); } catch { /* pre-row deploy — no views */ }
  const loadNodeView = async (toolId) => readFileSync(resolve(DATA, 'chaingraph', 'pages', toolId + '.html'), 'utf8');
  return {
    manifests, widgets,
    loadWidget: async (slug) => widgets[slug],
    catalog: JSON.parse(get('mcp/catalog.json')),
    chaingraph: JSON.parse(get('chaingraph/chaingraph.json')),
    searchIndex: JSON.parse(get('search-index.json')),
    chainFixtures: JSON.parse(get('chain-fixtures.json')),
    nodeViews,
    loadNodeView,
  };
}

// Raw JSON-RPC over an in-memory transport (same harness as tests/chain-plan-and-session-root.test.mjs).
async function withServer(data, onlyTool, fn) {
  const server = buildServer(data, onlyTool ? { onlyTool } : {});
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  await clientT.start();
  const pending = new Map();
  clientT.onmessage = (msg) => {
    if (msg && msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  };
  let nextId = 2;
  const rpc = (method, params) => new Promise((res) => {
    const id = nextId++;
    pending.set(id, res);
    clientT.send({ jsonrpc: '2.0', id, method, params });
  });
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'node-views-test', version: '1' } }, 1);
  await clientT.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  try {
    return await fn(rpc);
  } finally {
    await clientT.close();
    await server.close();
  }
}

test('node-views: hash sentinel + vendored page set', () => {
  const nv = JSON.parse(get('mcp/node-views.json'));
  assert.ok(nv, 'data/mcp/node-views.json must exist (run node generate.mjs)');
  assert.ok(Array.isArray(nv.views) && nv.views.length > 0, 'node-views.json carries a non-empty views[] set');
  assert.equal(nv.connect_domains_note, 'always empty — the worker pages make zero network calls (CONTRACT); this row must never widen it');
  const pageFiles = readdirSync(resolve(DATA, 'chaingraph', 'pages')).sort();
  const viewFiles = nv.views.map((v) => v.tool_id + '.html').sort();
  assert.deepEqual(pageFiles, viewFiles, 'data/chaingraph/pages/ carries EXACTLY the view set');
  const seenUri = new Set();
  for (const v of nv.views) {
    const bytes = readFileSync(resolve(DATA, 'chaingraph', 'pages', v.tool_id + '.html'));
    const sha = createHash('sha256').update(bytes).digest('hex');
    assert.equal(sha, v.sha256, 'sha256 sentinel recomputes over the vendored bytes for ' + v.tool_id);
    assert.equal(bytes.length, v.bytes, 'byte count matches the vendored file for ' + v.tool_id);
    assert.equal(v.uri, 'ui://ainumbers/node/' + v.tool_id, 'uri convention holds for ' + v.tool_id);
    assert.ok(v.mcp_name, 'view carries its mcp_name for ' + v.tool_id);
    assert.ok(!seenUri.has(v.uri), 'view uris are unique');
    seenUri.add(v.uri);
    assert.ok(bytes.length <= nv.max_page_bytes, 'vendored page within the size guard for ' + v.tool_id);
  }
  for (const s of nv.skipped ?? []) {
    assert.ok(s.bytes > nv.max_page_bytes, 'skipped page ' + s.tool_id + ' really exceeds the guard');
    assert.ok(!seenUri.has('ui://ainumbers/node/' + s.tool_id), 'skipped page ' + s.tool_id + ' is not served as a view');
    assert.ok(!pageFiles.includes(s.tool_id + '.html'), 'skipped page ' + s.tool_id + ' is not vendored');
  }
});

test('node-views: resources-list entries carry the MCP Apps metadata', () => {
  const nv = JSON.parse(get('mcp/node-views.json'));
  const { resources } = sseResult('resources-list.sse.txt');
  assert.ok(Array.isArray(resources) && resources.length > 0, 'resources-list is non-empty');
  const byUri = new Map(resources.map((r) => [r.uri, r]));
  for (const v of nv.views) {
    const r = byUri.get(v.uri);
    assert.ok(r, 'resources-list carries ' + v.uri);
    assert.equal(r.mimeType, 'text/html;profile=mcp-app', 'view mime type is the MCP Apps profile for ' + v.uri);
    assert.equal(r.title, v.display_name, 'resource title is the node display_name for ' + v.uri);
    assert.deepEqual(r._meta?.ui?.resourceDomains, nv.resource_domains, 'resourceDomains exactly as generated for ' + v.uri);
    assert.deepEqual(r._meta?.ui?.connectDomains, [], 'connectDomains is empty for ' + v.uri);
  }
  const nodeUris = resources.map((r) => r.uri).filter((u) => u.startsWith('ui://ainumbers/node/'));
  assert.deepEqual(
    [...new Set(nodeUris)].sort(),
    nv.views.map((v) => v.uri).sort(),
    'the ui://ainumbers/node/ surface is EXACTLY the view set',
  );
});

test('node-views: every served node tool with a vendored page carries the ui pointer', () => {
  const nv = JSON.parse(get('mcp/node-views.json'));
  const { tools } = sseResult('tools-list.sse.txt');
  const byName = new Map(tools.map((t) => [t.name, t]));
  const viewByMcpName = new Map(nv.views.map((v) => [v.mcp_name, v]));
  const skipped = new Set((nv.skipped ?? []).map((s) => s.tool_id));
  const nodeByMcpName = new Map(
    JSON.parse(get('chaingraph/chaingraph.json')).nodes
      .filter((n) => n.mcp_name)
      .map((n) => [n.mcp_name, n]),
  );
  let pointed = 0;
  for (const t of tools) {
    const node = nodeByMcpName.get(t.name);
    if (!node) continue; // PILOT widget / utility tool — not a node tool
    const v = viewByMcpName.get(t.name);
    if (v) {
      pointed++;
      assert.equal(t._meta?.ui?.resourceUri, v.uri, 'tool ' + t.name + ' points at its view resourceUri');
      assert.deepEqual(t._meta?.ui?.visibility, ['model', 'app'], 'tool ' + t.name + ' visibility is [model, app]');
    } else {
      // No view: legal ONLY when the node has no vendored chaingraph page or is size-skipped.
      const hasPage = node.tool_id && pageVendored(node.tool_id);
      const isSkipped = skipped.has(node.tool_id);
      assert.ok(!hasPage || isSkipped,
        'served node tool ' + t.name + ' (' + node.tool_id + ') has a vendored page but no view and is not size-skipped — seed drift');
      assert.ok(!t._meta?.ui?.resourceUri?.startsWith('ui://ainumbers/node/'),
        'tool ' + t.name + ' must not point at a node view that does not exist');
    }
  }
  assert.equal(pointed, nv.views.length, 'exactly one pointed tool per view');
});

function pageVendored(toolId) {
  try { readFileSync(resolve(DATA, 'chaingraph', 'pages', toolId + '.html')); return true; }
  catch { return false; }
}

test('node-views: resources/read serves the vendored bytes verbatim; O(1) build serves no resources', async () => {
  const nv = JSON.parse(get('mcp/node-views.json'));
  const data = loadDataFromDisk();
  const view = nv.views.find((v) => v.bytes < 200000) ?? nv.views[0]; // keep the read bounded
  const pageOnDisk = readFileSync(resolve(DATA, 'chaingraph', 'pages', view.tool_id + '.html'), 'utf8');

  // Full build (the resources/read path): bytes verbatim, MCP Apps mime type.
  await withServer(data, null, async (rpc) => {
    const res = await rpc('resources/read', { uri: view.uri });
    assert.ok(!res.error, 'resources/read of ' + view.uri + ' succeeds in the full build');
    const c = res.result?.contents?.[0];
    assert.equal(c?.uri, view.uri);
    assert.equal(c?.mimeType, 'text/html;profile=mcp-app', 'served with the MCP Apps mime type');
    assert.equal(c?.text, pageOnDisk, 'served bytes are VERBATIM (no CSP strip, no widget glue)');
  });

  // Unknown node uri → JSON-RPC error, never a fabricated page.
  await withServer(data, null, async (rpc) => {
    const res = await rpc('resources/read', { uri: 'ui://ainumbers/node/not-a-node-page' });
    assert.ok(res.error, 'resources/read of an unknown node uri is an error');
  });

  // O(1) single-tool build (the tools/call path): resources are NOT registered at all.
  await withServer(data, view.mcp_name, async (rpc) => {
    const res = await rpc('resources/read', { uri: view.uri });
    assert.ok(res.error, 'onlyTool build serves no resources (resources stay off the tools/call path)');
  });
});
