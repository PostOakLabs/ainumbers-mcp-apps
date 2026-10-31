# Security Policy

## Reporting a vulnerability

Email **security@postoaklabs.com**. The full vulnerability-disclosure program, scope, and safe-harbor terms are published at <https://ainumbers.co/security.html>.

## Scope

- This repository (`ainumbers-mcp-apps`) and the production MCP endpoint `https://mcp.ainumbers.co/mcp`.
- The worker never records inputs, parameters, or outputs; its telemetry is structural metadata only (tool name, success/failure, latency, chain depth, per-request correlation id, plus client name/version, User-Agent, and ASN once per connection). Report anything that contradicts that claim as a security issue.
- The no-auth posture of the public endpoint is a design property of a zero-PII, read-only compute service, not an oversight. Reports about missing authentication on user-data surfaces do not apply: there are no user-data surfaces.

## Supported versions

The `main` branch is the supported line; production deploys from it through GitHub Actions only.
