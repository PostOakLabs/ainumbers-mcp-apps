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
    description: 'Search the AINumbers catalog (480+ client-side fintech tools). Returns deep-links; prefill-enabled tools accept #in=<base64url(JSON of {element_id: value})>[&run=1] for one-click invocation.',
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

  // ── MCP-STREAMABLE-HTTP-CONFORMANCE-1 ─────────────────────────────────────
  // The dev door mirrors worker.mjs's transport conformance so scripts/transport-conformance.sh
  // exercises the same six controls locally. Stateless throughout: the session id issued at
  // initialize is an opaque echo token — accepted on later requests, never required, so a
  // request without one behaves exactly as before.
  const KNOWN_PROTOCOL_VERSIONS = ['2025-03-26', '2025-06-18']; // what the bundled SDK implements
  const PAGE_SIZE = 1000; // keep in sync with TOOLS_LIST_PAGE_SIZE in worker.mjs (flip to 200 only
                          // after live-smoke + the site's check-ask-agent-block.mjs are cursor-aware)

  // DELETE /mcp: session end. WITH the id issued at initialize → 204; a bare DELETE has nothing
  // to end and stays a spec-clean 405 whose Allow never advertises DELETE (SEP-2567 removed it).
  app.delete('/mcp', (req, res) => {
    const sid = req.headers['mcp-session-id'];
    if (sid) return res.status(204).set('Mcp-Session-Id', sid).set('Allow', 'POST, GET, OPTIONS').end();
    return res.status(405).set('Allow', 'POST, GET, OPTIONS').json({
      jsonrpc: '2.0', error: { code: -32601, message: 'Method Not Allowed: DELETE ends a session and requires the Mcp-Session-Id header issued at initialize. Use POST for JSON-RPC.' }, id: null,
    });
  });

  // GET /mcp: SESSION-GATED server->client SSE channel (reference-SDK shape with sessions
  // enabled): a GET presenting the Mcp-Session-Id issued at initialize streams an immediate
  // first frame + 25 s keepalive comments and closes on disconnect; a session-less GET gets the
  // same spec-clean 405 + Allow as before this row (mirrors worker.mjs / gate-mcp-era).
  app.get('/mcp', (req, res) => {
    const sid = req.headers['mcp-session-id'];
    if (sid && String(req.headers.accept ?? '').toLowerCase().includes('text/event-stream')) {
      res.status(200).set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' });
      res.set('Mcp-Session-Id', sid);
      res.write(': stream open\n\n');
      const timer = setInterval(() => res.write(': ping\n\n'), 25000);
      req.on('close', () => clearInterval(timer));
      return;
    }
    return res.status(405).set('Allow', 'POST, GET, OPTIONS').json({
      jsonrpc: '2.0', error: { code: -32601, message: 'Method Not Allowed: use POST for JSON-RPC, or GET with Accept: text/event-stream and your Mcp-Session-Id (from initialize) for the server-to-client stream.' }, id: null,
    });
  });

  app.post('/mcp', async (req, res) => {
    try {
      // MCP-Protocol-Version: an unknown explicit assertion is a JSON-RPC 400, never a 500
      // (mirrors unsupportedMcpVersionResponse in worker.mjs; absent header = legacy, allowed).
      const pv = req.headers['mcp-protocol-version'];
      if (pv && !KNOWN_PROTOCOL_VERSIONS.includes(String(pv))) {
        return res.status(400).json({
          jsonrpc: '2.0', id: req.body?.id ?? null,
          error: { code: -32022, message: `Unsupported protocol version: ${pv}`, data: { supported: KNOWN_PROTOCOL_VERSIONS, requested: String(pv) } },
        });
      }
      const server = buildServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => { transport.close(); server.close(); });
      await server.connect(transport);
      // Issue the session id at initialize; echo it on every other request that presents one.
      const sid = req.body?.method === 'initialize' ? crypto.randomUUID() : (req.headers['mcp-session-id'] ?? null);
      if (sid) res.set('Mcp-Session-Id', sid);
      // tools/list with a cursor → honour it: capture the SDK's full response at the HTTP layer
      // (Hono's node listener writes head, then N body chunks, then end()) and slice to one page,
      // adding nextCursor only when a further page exists. Handles both the JSON single-response
      // shape and the default SSE-framed shape (mirrors worker.mjs's own reframe pattern).
      const rawCursor = req.body?.method === 'tools/list' ? req.body?.params?.cursor : undefined;
      if (typeof rawCursor === 'string' && rawCursor !== '') {
        const offset = /^[0-9]{1,9}$/.test(rawCursor) ? Number(rawCursor) : null;
        if (offset === null) {
          return res.status(400).json({
            jsonrpc: '2.0', id: req.body?.id ?? null,
            error: { code: -32602, message: 'Invalid params: unknown cursor (this server issues decimal-offset cursors via nextCursor)' },
          });
        }
        const paginate = (parsed) => {
          const tools = parsed?.result?.tools;
          if (!Array.isArray(tools)) return false;
          const total = tools.length;
          parsed.result.tools = tools.slice(offset, offset + PAGE_SIZE);
          if (offset + PAGE_SIZE < total) parsed.result.nextCursor = String(offset + PAGE_SIZE);
          else delete parsed.result.nextCursor;
          return true;
        };
        const origWriteHead = res.writeHead.bind(res);
        const origWrite = res.write.bind(res);
        const origEnd = res.end.bind(res);
        let head = null;
        const chunks = [];
        res.writeHead = (...args) => { head = args; return res; };
        // Hono's node listener hands Uint8Array chunks — Buffer.from(uint8array) copies bytes,
        // whereas String() of a typed array would yield comma-joined byte codes (measured).
        const toBuf = (chunk) => (typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk));
        res.write = (chunk, ...rest) => { if (chunk != null) chunks.push(toBuf(chunk)); return res; };
        res.end = (chunk, ...rest) => {
          if (chunk != null) chunks.push(toBuf(chunk));
          const raw = Buffer.concat(chunks).toString('utf8');
          let out = raw;
          try {
            const parsed = JSON.parse(raw);            // JSON single-response shape
            paginate(parsed);
            out = JSON.stringify(parsed);
          } catch {
            const lines = raw.split('\n');             // SSE-framed shape: one data: line
            const di = lines.findIndex((l) => l.startsWith('data: '));
            if (di >= 0) {
              try {
                const parsed = JSON.parse(lines[di].slice(6));
                if (paginate(parsed)) {
                  lines[di] = 'data: ' + JSON.stringify(parsed);
                  out = lines.join('\n');
                }
              } catch { /* not JSON we recognise — pass through untouched */ }
            }
          }
          if (head) {
            // body length may have changed → drop the precomputed content-length, let Node chunk
            const h = head[1];
            if (h && typeof h === 'object' && !Array.isArray(h)) delete h['content-length'];
            origWriteHead(...head);
          }
          origWrite(Buffer.from(out, 'utf8'));
          return origEnd();
        };
      }
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      // C2 mirror (WORKER-CAPS-1, 2026-09-03; audit WORK-3): the caller-visible message used to
      // be String(e) — the internals-leak shape worker.mjs's C2 fix removed (2026-08-22; any
      // SDK/zod/kernel exception text can embed internals). Full detail (String(e) + stack) goes
      // to console.error for diagnosis; the response body is a constant. Dev-only surface (this
      // listener runs only when server.mjs is executed directly), closed so the leak shape has
      // no home left. Enforced by scripts/test-access-caps.mjs.
      console.error('[ainumbers-apps] server.mjs handler error:', String(e), e?.stack ?? '');
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
    }
  });
  app.get('/healthz', (_req, res) => res.json({ ok: true, widgets: PILOT.length }));

  const PORT = process.env.PORT ?? 3300;
  app.listen(PORT, () => console.log('ainumbers-apps MCP server → http://localhost:' + PORT + '/mcp  (' + PILOT.length + ' widget tools + catalog)'));
}
