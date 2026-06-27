# AINumbers MCP Apps Server

**Live endpoint:** `https://mcp.ainumbers.co/mcp` (streamable HTTP, no auth)

An [MCP Apps](https://blog.modelcontextprotocol.io/posts/2026-01-26-mcp-apps/) (SEP-1865) server that renders
[AINumbers.co](https://ainumbers.co) fintech tools as **interactive widgets inside Claude, ChatGPT,
M365 Copilot, VS Code**, and any other MCP Apps host. Published in the Official MCP Registry as
[`co.ainumbers/tools`](https://registry.modelcontextprotocol.io/v0.1/servers?search=co.ainumbers).

## Tools

Fifteen flagship tools render as widgets — the actual single-file AINumbers tool, served as a
`text/html;profile=mcp-app` resource, driven by the AIN Bridge (prefill → run → Policy Mandate export):

| MCP tool | AINumbers tool |
|---|---|
| `baas_provider_comparator` | T152 BaaS Provider Comparator |
| `validate_ap2_mcp_policy` | T320 AP2 MCP Policy Validator & Bridge |
| `build_google_ap2_mandate` | T285 Google AP2 Checkout/Payment Mandate Builder |
| `score_mcp_readiness` | T288 MCP Developer Readiness Scorecard |
| `agentic_mandate_sandbox` | RBE-06 Agentic Mandate Sandbox |
| `customer_risk_rating` | T110 Customer Risk Rating Engine |
| `ap2_aml_mandate_builder` | T131 AP2 AML Mandate Builder |
| `lint_mcp_tool_definition` | T274 MCP Tool-Definition Linter |
| `validate_mcp_server_json` | T275 MCP server.json Validator |
| `compare_agentic_payment_protocols` | T276 Agentic Payments Protocol Comparator |
| `decode_x402_payment` | T277 x402 Decoder & 402 Flow Simulator |
| `audit_mcp_oauth` | T278 MCP OAuth 2.1 Authorization Auditor |
| `scan_tool_poisoning` | T282 MCP Tool-Poisoning Scanner |
| `validate_a2a_agent_card` | T283 A2A Agent Card Validator |
| `inspect_visa_tap_signature` | T286 Visa TAP Signature Inspector |

Plus `list_ainumbers_tools` — catalog search across all **480+** tools, returning deep-links;
prefill-enabled tools accept `#in=<base64url(JSON of {element_id: value})>[&run=1]` for one-click invocation.

All 16 tools are read-only (`readOnlyHint: true`), no account, no auth, zero PII — inputs are
processed transiently and never stored.

## Connect it

- **Claude:** Settings → Connectors → Add custom connector → `https://mcp.ainumbers.co/mcp`
- **Inspector:** `npx @modelcontextprotocol/inspector` → Streamable HTTP → same URL
- Production runs on Cloudflare Workers (`/healthz` reports `runtime: cloudflare-workers`) — no cold starts.

## Develop

```bash
npm install
node generate.mjs   # re-vendor tool HTML + manifests + catalog from ../repo into ./data
npm start           # http://localhost:3300/mcp  (+ /healthz) — Node/express variant (server.mjs)
npx wrangler deploy # deploy the Cloudflare Workers variant (worker.mjs)
```

`pilot.mjs` is the single source of truth for the widget tool set. After changing any pilot tool
in the AINumbers repo, run `node generate.mjs`, commit `data/`, and push; run `npx wrangler deploy`
to update production.

Docs: [ainumbers.co/mcp.html](https://ainumbers.co/mcp.html) (privacy, terms, support).

All tool content is client-side, deterministic, zero PII — © Post Oak Labs, CC BY 4.0.
See `README-SPEC.md` for architecture and history.
