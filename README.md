# AINumbers MCP Apps Server

**Live endpoint:** `https://mcp.ainumbers.co/mcp` (streamable HTTP, no auth)

An [MCP Apps](https://blog.modelcontextprotocol.io/posts/2026-01-26-mcp-apps/) (SEP-1865) server that renders
[AINumbers.co](https://ainumbers.co) fintech tools as **interactive widgets inside Claude, ChatGPT,
M365 Copilot, VS Code**, and any other MCP Apps host.

## Tools

Seven flagship tools render as widgets — the actual single-file AINumbers tool, served as a
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

Plus `list_ainumbers_tools` — catalog search across all **420** tools, returning deep-links;
prefill-enabled tools accept `#in=<base64url(JSON of {element_id: value})>[&run=1]` for one-click invocation.

## Connect it

- **Claude:** Settings → Connectors → Add custom connector → `https://mcp.ainumbers.co/mcp`
- **Inspector:** `npx @modelcontextprotocol/inspector` → Streamable HTTP → same URL
- Note: free-tier hosting spins down when idle — the first request after a quiet period can take up to a minute.

## Develop

```bash
npm install
node generate.mjs   # re-vendor tool HTML + manifests + catalog from ../repo into ./data
npm start           # http://localhost:3300/mcp  (+ /healthz)
```

Pushing to `master` auto-deploys. After changing any pilot tool in the AINumbers repo,
run `node generate.mjs`, commit `data/`, and push.

All tool content is client-side, deterministic, zero PII — © Post Oak Labs, CC BY 4.0.
See `README-SPEC.md` for architecture and history.
