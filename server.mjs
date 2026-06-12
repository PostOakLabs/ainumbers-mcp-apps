// AINumbers MCP Apps server — WIRED PoC (target: https://mcp.ainumbers.co)
// SDK: @modelcontextprotocol/sdk 1.29 + ext-apps 1.7 (SEP-1865 / 2026-01-26 spec)
// Run:  node server.mjs   → streamable HTTP MCP endpoint at http://localhost:3300/mcp
// Test: MCPJam / Postman / `npx @modelcontextprotocol/inspector` → connect to /mcp

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { registerAppTool, registerAppResource, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { z } from 'zod';

const ROOT = dirname(fileURLToPath(import.meta.url));
// Standalone deploys (Render etc.) read vendored ./data; local dev falls back to ../repo.
import { existsSync } from 'node:fs';
const REPO = existsSync(resolve(dirname(fileURLToPath(import.meta.url)), 'data', 'mcp', 'catalog.json'))
  ? resolve(dirname(fileURLToPath(import.meta.url)), 'data')
  : resolve(dirname(fileURLToPath(import.meta.url)), '..', 'repo');
const BASE_URL = 'https://ainumbers.co';

import { PILOT } from './pilot.mjs';

// Widget-side glue: drives the AIN Bridge already inside every tool.
// SDK is inlined (export-free transform of app-with-deps.js) — CDN imports are blocked by the
// host's widget sandbox CSP and by the tools' own CSP meta. Keep in sync with worker.mjs.
const sdkInline = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), 'node_modules', '@modelcontextprotocol', 'ext-apps', 'dist', 'src', 'app-with-deps.js'), 'utf8')
  .replace(/export\{([\s\S]*?)\};?\s*$/, (_, names) => {
    const props = names.split(',').map(s => s.trim()).filter(Boolean).map(s => {
      const m = s.split(/\s+as\s+/);
      return m.length === 2 ? `${m[1]}:${m[0]}` : `${s}:${s}`;
    }).join(',');
    return `globalThis.__EXT_APPS__={${props}};`;
  });
const WIDGET_GLUE = `
<script type="module">
${sdkInline}
const { App } = globalThis.__EXT_APPS__;
const app = new App({ name: 'ainumbers-widget', version: '1.0.0' });
app.ontoolresult = (result) => {
  try {
    const inputs = result?.structuredContent?.inputs ?? {};
    if (window.AINBridge) {
      const n = window.AINBridge.apply(inputs);
      if (n > 0) window.AINBridge.run();
    }
  } catch (e) { /* widget stays interactive regardless */ }
};
await app.connect();
</script>`;

const stripCspMeta = (html) => html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>\s*/i, '');
const manifest = (slug) => JSON.parse(readFileSync(resolve(REPO, 'manifests', slug + '.manifest.json'), 'utf8'));
const widgetHtml = (slug) => stripCspMeta(readFileSync(resolve(REPO, 'tools', slug + '.html'), 'utf8')) + WIDGET_GLUE;

function buildServer() {
  const server = new McpServer({ name: 'ainumbers-apps', version: '1.0.0' });

  for (const slug of PILOT) {
    const m = manifest(slug);
    const uri = 'ui://ainumbers/' + slug;
    const name = m.mcp_tool_definition?.name ?? slug.replace(/-/g, '_');

    registerAppTool(server, name, {
      title: m.title,
      description: (m.mcp_tool_definition?.description ?? m.description) +
        ' Renders the interactive AINumbers tool as a widget; inputs are applied via the AIN Bridge and the tool runs client-side (zero PII, zero network).',
      inputSchema: { inputs: z.record(z.any()).optional()
        .describe('Map of tool input element IDs to values (see manifest input_schema). Applied via AIN Bridge prefill.') },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      _meta: { ui: { resourceUri: uri } },
    }, async ({ inputs }) => ({
      content: [{ type: 'text', text: 'Opened ' + m.title + '. ' + (inputs ? Object.keys(inputs).length + ' inputs applied via AIN Bridge.' : 'Configure inputs in the widget.') + ' Tool runs deterministically in the widget sandbox; export a Policy Mandate for the audit trail.' }],
      structuredContent: { tool_id: m.tool_id, version: m.version, inputs: inputs ?? {}, url: BASE_URL + '/tools/' + slug + '.html' },
    }));

    registerAppResource(server, m.title, uri, {}, async () => ({
      contents: [{ uri, mimeType: RESOURCE_MIME_TYPE, text: widgetHtml(slug) }],
    }));
  }

  const catalog = JSON.parse(readFileSync(resolve(REPO, 'mcp', 'catalog.json'), 'utf8'));
  server.registerTool('list_ainumbers_tools', {
    title: 'List AINumbers tools',
    description: 'Search the AINumbers catalog (420 client-side fintech tools). Returns deep-links; prefill-enabled tools accept #in=<base64url(JSON of {element_id: value})>[&run=1] for one-click invocation.',
    inputSchema: { query: z.string().optional(), category: z.string().optional(), limit: z.number().optional() },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ query, category, limit }) => {
    const q = (query ?? '').toLowerCase();
    const rows = (catalog.tools ?? [])
      .filter((t) => !category || t.metadata?.category === category)
      .filter((t) => !q || (t.name + ' ' + t.description).toLowerCase().includes(q))
      .slice(0, limit ?? 20)
      .map((t) => ({ name: t.name, tool_id: t.metadata?.tool_id, url: t.metadata?.url, prefill: !!t.metadata?.prefill, ap2_export: !!t.metadata?.ap2_export, description: t.description.slice(0, 160) }));
    return { content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }], structuredContent: { count: rows.length, tools: rows } };
  });

  return server;
}

export { buildServer };

// Start the streamable-HTTP server only when this file is run directly (node server.mjs).
// When imported (e.g. by stdio.mjs for the Glama containerized build) we must NOT listen
// or log to stdout — stdout is the stdio MCP JSON-RPC channel and any stray write corrupts it.
if (resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1] ?? '')) {
  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.post('/mcp', async (req, res) => {
    try {
      const server = buildServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => { transport.close(); server.close(); });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: String(e) }, id: null });
    }
  });
  app.get('/healthz', (_req, res) => res.json({ ok: true, widgets: PILOT.length }));

  const PORT = process.env.PORT ?? 3300;
  app.listen(PORT, () => console.log('ainumbers-apps MCP server → http://localhost:' + PORT + '/mcp  (' + PILOT.length + ' widget tools + catalog)'));
}
