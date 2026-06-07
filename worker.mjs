// AINumbers MCP Apps server — Cloudflare Workers runtime.
// Same tool surface as server.mjs (Render/express); stateless streamable-HTTP via fetch-to-node.
// Deploy: npx wrangler deploy   (data/ vendored by generate.mjs is served via the ASSETS binding)
// Test locally: node test-worker.mjs (simulates the Workers env in plain Node)

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { toReqRes, toFetchResponse } from 'fetch-to-node';
import { registerAppTool, registerAppResource, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { z } from 'zod';
import { PILOT } from './pilot.mjs';

const BASE_URL = 'https://ainumbers.co';

// Widget-side glue: drives the AIN Bridge already inside every tool.
// The ext-apps SDK is INLINED (vendored by generate.mjs as data/ext-apps-inline.js): the widget
// sandbox CSP and the tools' own CSP meta both block third-party CDN imports (esm.sh), which
// left app.connect() never firing and the widget iframe stuck invisible at its placeholder size.
const widgetGlue = (sdkInline) => `
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

// The vendored tool pages ship a strict CSP meta for serving on ainumbers.co; inside the host's
// sandboxed widget iframe it would fight the inline glue. The host enforces its own CSP — strip ours.
const stripCspMeta = (html) => html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>\s*/i, '');

// Module-scope cache: assets are immutable per deploy, so load once per isolate.
let dataCache = null;
async function loadData(env) {
  if (dataCache) return dataCache;
  const get = async (path) => {
    const r = await env.ASSETS.fetch('https://assets.local/' + path);
    if (!r.ok) throw new Error('asset miss: ' + path + ' → ' + r.status);
    return r;
  };
  const glue = widgetGlue(await (await get('ext-apps-inline.js')).text());
  const manifests = {}, widgets = {};
  for (const slug of PILOT) {
    manifests[slug] = await (await get('manifests/' + slug + '.manifest.json')).json();
    widgets[slug] = stripCspMeta(await (await get('tools/' + slug + '.html')).text()) + glue;
  }
  const catalog = await (await get('mcp/catalog.json')).json();
  dataCache = { manifests, widgets, catalog };
  return dataCache;
}

function buildServer({ manifests, widgets, catalog }) {
  const server = new McpServer({ name: 'ainumbers-apps', version: '0.3.0' });

  for (const slug of PILOT) {
    const m = manifests[slug];
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
      contents: [{ uri, mimeType: RESOURCE_MIME_TYPE, text: widgets[slug] }],
    }));
  }

  server.registerTool('list_ainumbers_tools', {
    title: 'List AINumbers tools',
    description: 'Search the AINumbers catalog (420+ client-side fintech tools). Returns deep-links; prefill-enabled tools accept #in=<base64url(JSON of {element_id: value})>[&run=1] for one-click invocation.',
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

export default {
  async fetch(request, env, _ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/healthz') {
      return Response.json({ ok: true, widgets: PILOT.length, runtime: 'cloudflare-workers' });
    }
    if (url.pathname !== '/mcp') {
      return new Response('Not found', { status: 404 });
    }

    try {
      const data = await loadData(env);
      const server = buildServer(data);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await server.connect(transport);

      const body = request.method === 'POST' ? await request.clone().json() : undefined;
      const { req, res } = toReqRes(request);
      // fetch() strips the Host header; the MCP SDK needs it to reconstruct the request URL.
      req.headers.host = url.host;
      res.on('close', () => { transport.close(); server.close(); });
      await transport.handleRequest(req, res, body);
      return await toFetchResponse(res);
    } catch (e) {
      return Response.json(
        { jsonrpc: '2.0', error: { code: -32603, message: String(e) }, id: null },
        { status: 500 },
      );
    }
  },
};
