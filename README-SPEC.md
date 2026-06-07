# AINumbers MCP Apps Server — Spec & Scaffold (DRAFT)
**Date:** 2026-06-06 · **Owner:** AINumbers (part of the AINumbers project; lives beside repo/ pending a decision on folding it into the repo)
**Status:** LIVE at **https://mcp.ainumbers.co/mcp** (deployed 2026-06-06; Render free tier, auto-deploy from GitHub master; Cloudflare DNS, CNAME DNS-only). SDK 1.29.0 + ext-apps 1.7.4.
**Verified:** initialize / tools/list (8 tools) / tools/call with structuredContent / resources/read serving tool HTML as `text/html;profile=mcp-app` with AIN Bridge + widget glue. Run `node server.mjs`, test at `http://localhost:3300/mcp`.

## What this is
A thin MCP server that exposes selected AINumbers tools as **MCP Apps** — interactive widgets rendered inside Claude, ChatGPT, M365 Copilot, and VS Code chat. The single-file, zero-network, schema-declared AINumbers tools are nearly drop-in `ui://` resources; this server is mostly plumbing.

## Architecture
```
Claude / ChatGPT / Copilot (MCP Apps host)
        │  MCP (streamable HTTP)
        ▼
  this server (Node on Render free tier, https://mcp.ainumbers.co)
        │  reads at build time (no runtime fetch to ainumbers.co needed)
        ▼
  AINumbers repo artifacts:
    • mcp/catalog.json            → tool list, descriptions, inputSchemas
    • tools/<slug>.html           → widget HTML (served as ui:// resources)
    • manifests/<slug>.manifest.json → execution.function_name, prefill flag
```

## Key design decisions
1. **Widget = the existing tool HTML, unmodified.** The AIN Bridge (already injected in prefill-enabled tools) gives the widget a programmatic surface: `AINBridge.apply(fields)`, `AINBridge.run()`, `AINBridge.getMandate()`. The host-side glue calls these via the MCP Apps postMessage channel instead of a parent iframe — same contract as the Policy Composer.
2. **Tool call → widget flow.** Each MCP tool (`run_baas_comparator`, etc.) accepts the manifest `input_schema`; the handler returns the widget resource + the inputs. Widget boot script applies inputs via `AINBridge.apply`, calls `AINBridge.run()`, and returns `AINBridge.getMandate()` (or the rendered state) to the model as structured content.
3. **Pilot set (8):** 152 (canonical template), 320, 285, 288, rbe-06, 110, 131, agentic-readiness-diagnostic. All bridge-enabled as of 2026-06-06.
4. **Zero-PII posture carries over.** Tool execution remains in the host's widget sandbox; the server serves static HTML and never receives user inputs (tool-call inputs go host→widget, and POL should document that hosts may log tool calls — synthetic data only, same as the website).
5. **CSP/offline:** MCP Apps widget sandboxes restrict network; AINumbers tools are zero-network by contract → no rework needed. Google Fonts links will fail closed in sandboxes that block fonts — acceptable (system font fallback), or inline a subset later.

## Build steps (when pursued)
1. `npm init` + current `@modelcontextprotocol/sdk` + ext-apps extension package (verify name/version in docs).
2. Generation script (`scripts/generate.mjs` here) copies the 8 pilot tool HTML files + slices of catalog.json into `dist/`.
3. `server.mjs` registers: one MCP tool per pilot tool (name from `mcp_tool_definition.name`), one `ui://ainumbers/<slug>` resource each, plus a `list_ainumbers_tools` catalog tool for discovery of the other ~400 (returns deep-links with `#in=` prefill).
4. Host testing order: MCPJam/Postman → Claude desktop → ChatGPT dev mode → Copilot.
5. Auth: start unauthenticated read-only (static widgets, no state). Add OAuth 2.1 only if/when per-user state appears.

## Open questions for Tim
- ~~Domain~~ → **mcp.ainumbers.co** (decided 2026-06-06).
- Submit to MCP registries / Claude connectors directory at launch, or after a private pilot?
