// Single source of truth for the MCP Apps pilot tool set.
// Imported by server.mjs (Render/express), worker.mjs (Cloudflare Workers), and generate.mjs (vendoring).
// After changing this list: run `node generate.mjs`, then commit + push (Render auto-deploys; run `npx wrangler deploy` for Workers).
export const PILOT = [
  // original 7
  '152-baas-provider-comparator',
  '320-ap2-mcp-policy-validator',
  '285-google-ap2-mandate-builder',
  '288-mcp-developer-readiness-scorecard',
  'rbe-06-agentic-mandate-sandbox',
  '110-customer-risk-rating',
  '131-ap2-aml-mandate-builder',
  // MCP-dev + agentic-checkout flagships (added 2026-06-06, pilot widened 7 → 15)
  '274-mcp-tool-definition-linter',
  '275-mcp-server-json-validator',
  '276-agentic-payments-protocol-comparator',
  '277-x402-payload-decoder-flow-simulator',
  '278-mcp-oauth-authorization-auditor',
  '282-mcp-tool-poisoning-scanner',
  '283-a2a-agent-card-validator',
  '286-visa-trusted-agent-protocol-inspector',
  // VM-1a kernel VM widget (added 2026-07-09) — kernel-VM-as-tool via this PILOT surface.
  // Re-landed after #57 revert: safe now that widget HTML loads lazily (worker.mjs loadWidget),
  // so this 16th widget no longer tips cold-start past the Free-plan 50-subrequest cap.
  'kernel-vm-widget',
];
