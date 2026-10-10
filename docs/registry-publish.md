# MCP Registry publish — runbook (REGISTRY-PUBLISH-AUTO-1)

How `co.ainumbers/tools` gets published to the official MCP Registry
(`registry.modelcontextprotocol.io`), and how to rotate the key that gates it.

## How publishing works now

- `server.json` (repo root) is the publishable artifact. Bump it (usually via
  `node scripts/sync-registry.mjs --write`, then commit).
- A push to `master` that touches `server.json` triggers
  `.github/workflows/publish-registry.yml` automatically:
  schema-validate → `mcp-publisher validate` (dry-run, aborts before login) →
  DNS login → publish → post-publish `--check-drift`.
- `workflow_dispatch` supports `dry_run: true` (validation only, no login) and
  `negative_test: true` (proves a wrong key is rejected by the DNS challenge).
- The `Registry Drift (scheduled)` workflow (`.github/workflows/registry-drift-schedule.yml`)
  is the tripwire: every 6 h it compares `server.json` vs the live listing and
  raises a tracking issue on real drift. An unreachable registry API is
  reported (`REGISTRY_UNREACHABLE`, exit 0), not failed.
- Manual fallback: `mcp-publisher` locally, logged in with the **dedicated
  registry key only** (see below). Never any other key.

## Key custody — the registry key is NOT the estate key

| | Registry key | Estate signing key |
|---|---|---|
| What | Ed25519 keypair whose public half is published in a TXT record on `ainumbers.co` (`v=MCPv1; k=ed25519; p=…`) | The estate's single §16 signing key (gitignored, local-only) used for agent-card / receipt audit signatures |
| Where it lives | `MCP_PRIVATE_KEY` secret, `mcp-registry` GitHub environment (master-only branch policy) | Local, gitignored, NEVER on CI, never read by any workflow |
| Used for | `mcp-publisher login dns --domain ainumbers.co` — proves domain control for publishing | Contract audit signatures |

**Hard rule (Tim, 2026-10-01):** the estate key NEVER touches CI and is never
referenced by any workflow. If you find a workflow reading it, that is a breach
— stop and report.

Format note: `mcp-publisher login dns --private-key` takes the **64-hex-char
private seed** (not a PEM file) — that is what `MCP_PRIVATE_KEY` holds.

## Rotation

1. Generate a NEW dedicated Ed25519 keypair. Keep the private seed (hex) ready
   for the secret; you will never need the old one again.
2. Publish the NEW public key in the TXT record at the domain APEX
   `ainumbers.co` (Cloudflare, authoritative NS) — the registry looks up TXT
   records on the domain itself (ACME DNS-01 style). The record is
   `v=MCPv1; k=ed25519; p=<base64 public key>`.
3. Verify the TXT is live (`dig TXT … @<authoritative NS>`), then update the
   `MCP_PRIVATE_KEY` secret in the `mcp-registry` environment with the new
   private seed.
4. Re-run `publish-registry.yml` via `workflow_dispatch` (plain, real publish)
   and confirm the post-check `--check-drift` is green.
5. Optional but recommended: run `workflow_dispatch` with `negative_test: true`
   once after rotation to confirm a wrong key is still rejected.

## First publish note (RULINGS 204)

The first real publish ran on Tim's word; every publish after a normal
`server.json` bump is automated and needs no human step.
