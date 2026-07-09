# AINumbers MCP Apps Server

**Live endpoint:** `https://mcp.ainumbers.co/mcp` (streamable HTTP, no auth) · **Docs:** [ainumbers.co/mcp.html](https://ainumbers.co/mcp.html) · **Registry:** [`co.ainumbers/tools`](https://registry.modelcontextprotocol.io/v0.1/servers?search=co.ainumbers) on the Official MCP Registry

An [MCP Apps](https://blog.modelcontextprotocol.io/posts/2026-01-26-mcp-apps/) (SEP-1865) server that exposes the
[AINumbers.co](https://ainumbers.co) fintech tool suite to any MCP host (Claude, ChatGPT, M365 Copilot, VS Code,
Cursor).

![baas_provider_comparator — one of the 15 flagship widget tools, the same HTML MCP Apps hosts render inline in chat](docs/mcp-widget-demo.gif)

**327 read-only MCP tools** as of the last vendor — see `data/counts.json` for the live figure; never
hand-type this number, `scripts/surface-parity.mjs` and the site repo's count-drift gate both check against it.
15 flagship tools render as interactive widgets, the rest are ChainGraph compute nodes plus a handful of
catalog/discovery utility tools (`list_ainumbers_tools`, `find_tool`, `find_chain`, `build_workflow_links`,
`run_chain`, `verify_execution_hash`, `build_chaingraph`, `emit_chaingraph_artifact`, `build_session_receipt`).

## Architecture

```
../repo (site repo, PostOakLabs/ainumbers)
   │  chaingraph.json, manifests/, pilot.mjs-referenced tool HTML
   │
   ▼  node generate.mjs  (build-time only — cannot run in cloud CI, needs the sibling repo)
data/                         ← vendored: chaingraph.json, catalog.json, manifests, counts.json
kernels/                      ← vendored: server-side compute kernels
   │
   ▼
worker.mjs  (Cloudflare Workers, this repo's live runtime)
server.mjs  (Node/express variant — local dev only, not deployed)
   │
   ▼
https://mcp.ainumbers.co/mcp  ← the one live endpoint (Worker, not the express variant)
```

`data/` and `kernels/` are **generated, committed artifacts** — the Worker boots from what's committed, not from
a live read of `../repo`. Any change to `chaingraph.json`, a manifest, `pilot.mjs`, or a kernel in the site repo
requires re-running `generate.mjs` here and committing `data/` + `kernels/` in the same push, or the worker
deploys stale.

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

Plus discovery/catalog tools — `list_ainumbers_tools` / `find_tool` search the full catalog (see
`data/counts.json` for the current tool count) and return deep-links; prefill-enabled tools accept
`#in=<base64url(JSON of {element_id: value})>[&run=1]` for one-click invocation. `find_chain` /
`build_workflow_links` return ordered deep-links for a named multi-tool workflow; `run_chain` executes one
server-side; `verify_execution_hash` independently re-verifies a returned artifact's hash.

Every tool declares `readOnlyHint: true` — no account, no auth, zero PII, nothing mutates state.

## Connect it

- **Claude:** Settings → Connectors → Add custom connector → `https://mcp.ainumbers.co/mcp`
- **Cursor / Open Plugins directories:** root `.mcp.json` in this repo declares the same remote endpoint.
- **Inspector:** `npx @modelcontextprotocol/inspector` → Streamable HTTP → same URL
- Production runs on Cloudflare Workers (`/healthz` reports `runtime: cloudflare-workers`) — no cold starts.

## Deploy flow (CI-owned)

Branch → PR → CI (`validate` job: tool-name collisions, surface-parity, kernel coverage, chain validation,
vendor-freshness, `wrangler deploy --dry-run`) → merge to `master` → GitHub Actions `deploy` job runs
`wrangler deploy` against Cloudflare Workers → post-deploy `/mcp` smoke test (a real `initialize` call against
the live endpoint). No manual `wrangler deploy`, ever — Cloudflare Workers Builds stays disconnected on purpose
(running both is a double-deployer and has caused outages). A green CI bundle does not by itself prove the
live handshake works; only the smoke step does.

Dependabot auto-merges every dependency update (patch/minor/major, CI-gated) — `git pull --rebase` before
pushing any local branch, `master` moves on its own.

## Develop

```bash
npm install
node generate.mjs   # re-vendor tool HTML + manifests + catalog + kernels from ../repo into data/ + kernels/
npm start            # http://localhost:3300/mcp (+ /healthz) — Node/express variant (server.mjs), local dev only
node scripts/check-tool-names.mjs   # verify no mcp_name collision before pushing
node scripts/surface-parity.mjs     # verify counts.json matches the registered surface
```

`pilot.mjs` is the single source of truth for the widget tool set. After changing any pilot tool in the site
repo, run `node generate.mjs`, commit `data/` + `kernels/`, and push — CI validates and deploys.

All tool content is client-side, deterministic, zero PII — © Post Oak Labs, CC BY 4.0.
See `README-SPEC.md` for architecture and history.
