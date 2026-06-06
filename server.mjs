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

const PILOT = [
  '152-baas-provider-comparator',
  '320-ap2-mcp-policy-validator',
  '285-google-ap2-mandate-builder',
  '288-mcp-developer-readiness-scorecard',
  'rbe-06-agentic-mandate-sandbox',
  '110-customer-risk-rating',
  '131-ap2-aml-mandate-builder',
];

// Widget-side glue: drives the AIN Bridge already inside every tool.
const WIDGET_GLUE = `
<script type="module">
import { App } from 'https://esm.sh/@modelcontextprotocol/ext-apps@1.7.4';
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

const manifest = (slug) => JSON.parse(readFileSync(resolve(REPO, 'manifests', slug + '.manifest.json'), 'utf8'));
const widgetHtml = (slug) => readFileSync(resolve(REPO, 'tools', slug + '.html'), 'utf8') + WIDGET_GLUE;

function buildServer() {
  const server = new McpServer({ name: 'ainumbers-apps', version: '0.2.0' });

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
    description: 'Search the AINumbers catalog (~344 client-side fintech tools). Returns deep-links; prefill-enabled tools accept #in=<base64url(JSON of {element_id: value})>[&run=1] for one-click invocation.',
    inputSchema: { query: z.string().optional(), category: z.string().optional(), limit: z.number().optional() },
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
