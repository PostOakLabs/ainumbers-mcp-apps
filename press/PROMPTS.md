# Carousel screenshots — paired prompts
Captured 2026-06-07 in claude.ai (desktop web) against https://mcp.ainumbers.co/mcp. All PNG, ≥1000px wide, cropped to the app response only. Where a second line is shown, the state in the screenshot was produced by the initial prompt followed by the follow-up (both reproduce it exactly; the initial prompt alone renders the same widget awaiting one click).

## 01-baas-provider-comparator.png (1045×660)
Prompt: "Use the BaaS Provider Comparator tool to compare providers for a mid-size card programme — weight compliance and ledger flexibility highest"
Follow-up: "Call baas_provider_comparator again, this time passing inputs {"w_regulatory": 5, "w_compliance": 5} so the weights are applied and the comparison runs automatically"

## 02-mcp-readiness-scorecard.png (1070×650)
Prompt: "Use the MCP Developer Readiness Scorecard tool to score my MCP server: 16 tools, all annotated read-only with titles, streamable HTTP transport, no auth, server.json published in the official registry, hosted on Cloudflare Workers with no cold starts"
Follow-up: "Call score_mcp_readiness again passing inputs {"sc_tooldef_schema":"yes","sc_tooldef_desc":"yes","sc_tooldef_ann":"yes","sc_serverjson_name":"yes","sc_serverjson_meta":"yes","sc_serverjson_pkg":"yes","sc_oauth_prm":"no","sc_oauth_aud":"no","sc_oauth_pass":"partial","sc_transport_origin":"no","sc_transport_bind":"yes","sc_poison_clean":"yes","sc_poison_trust":"yes","sc_spec_rev":"yes","sc_spec_stateless":"partial"} so the scorecard computes automatically"

## 03-a2a-agent-card-validator.png (1053×705)
Prompt: "Use the A2A Agent Card Validator tool, passing inputs {"cardIn": "{\"name\":\"acme-payments-agent\",\"description\":\"Handles B2B invoice payment scheduling\",\"url\":\"https://agents.example.com/a2a\",\"version\":\"1.0.0\",\"capabilities\":{\"streaming\":true},\"skills\":[{\"id\":\"pay-invoice\",\"name\":\"Pay invoice\",\"description\":\"Schedules an invoice payment\"}],\"defaultInputModes\":[\"application/json\"],\"defaultOutputModes\":[\"application/json\"]}"} so it validates automatically"

## 04-x402-decoder.png (1074×639)
Prompt: "Use the x402 Header Decoder tool, passing inputs {"hdrIn": "eyJ4NDAyVmVyc2lvbiI6IDEsICJhY2NlcHRzIjogW3sic2NoZW1lIjogImV4YWN0IiwgIm5ldHdvcmsiOiAiYmFzZS1zZXBvbGlhIiwgIm1heEFtb3VudFJlcXVpcmVkIjogIjEwMDAwIiwgInJlc291cmNlIjogImh0dHBzOi8vYXBpLmV4YW1wbGUuY29tL3JlcG9ydCIsICJkZXNjcmlwdGlvbiI6ICJQcmVtaXVtIGZpbnRlY2ggZGF0YSIsICJwYXlUbyI6ICIweDIwOTY5M0JjNmFmYzBDNTMyOGJBMzZGYUYwM0M1MTRFRjMxMjI4N0MiLCAibWF4VGltZW91dFNlY29uZHMiOiA2MCwgImFzc2V0IjogIjB4MDM2Q2JENTM4NDJjNTQyNjYzNGU3OTI5NTQxZUMyMzE4ZjNkQ0Y3ZSJ9XX0="} so it decodes the real header automatically"

## 05-protocol-comparator.png (1056×569)
Prompt: "Use the Agentic Payments Protocol Comparator tool to compare AP2, x402, and Visa TAP for an agentic checkout integration"
