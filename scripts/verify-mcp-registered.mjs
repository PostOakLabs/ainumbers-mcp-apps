#!/usr/bin/env node
// verify-mcp-registered.mjs — the END-TO-END check that was missing.
// Queries the LIVE /mcp server's tools/list and asserts every expected mcp_name is registered
// (callable). Distinguishes "the build session said it was done" from "agents can actually call
// it" — the gap that let Wave 14/15 sit unlanded while sessions reported closed.
//
// v2 fixes: (1) MCP Streamable-HTTP requires Accept: application/json, text/event-stream — a bare
// application/json gets HTTP 406; (2) the server may answer as SSE (text/event-stream) — parse the
// data: line; (3) clean Windows exit via process.exitCode (no abrupt process.exit() that races
// undici socket teardown → the "UV_HANDLE_CLOSING" assertion).
//
// Usage:
//   node verify-mcp-registered.mjs --all                 # all of Wave 13/14/15
//   WAVE=15 node verify-mcp-registered.mjs               # one wave
//   node verify-mcp-registered.mjs run_ai_act_highrisk_fit …   # explicit names
//   MCP_URL=https://mcp.ainumbers.co/mcp node verify-mcp-registered.mjs --all
//
// Run AFTER the worker deploy + Actions green. Exit 0 only if every expected name is present.

const MCP_URL = process.env.MCP_URL || 'https://mcp.ainumbers.co/mcp';
const PROTO = process.env.MCP_PROTOCOL_VERSION || '2025-06-18';
// Cloudflare WAF rate-limits /mcp (50 req/10s per IP → 429/503). After the post-deploy
// hash-sweep burst this single tools/list can land in a saturated window; retry past it
// (window is 10s, so a few 6s backoffs clear it). Mirrors hash-sweep's RL_RETRIES.
const RL_RETRIES = Number(process.env.RL_RETRIES || 5);
const RL_BACKOFF_MS = Number(process.env.RL_BACKOFF_MS || 6000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const WAVES = {
  13: ['run_tokenized_settlement_fit', 'validate_deposit_token_compliance', 'validate_cross_network_settlement', 'classify_settlement_asset_finality'],
  14: ['run_agent_economy_fit', 'reconcile_x402_batch_settlement', 'verify_ap2_payment_receipt', 'model_agent_service_metering'],
  15: ['run_ai_act_highrisk_fit', 'build_ai_conformity_pack', 'build_fria_monitoring_plan', 'classify_agentic_ai_risk'],
};

await main();

async function main() {
  let expected = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if (process.argv.includes('--all')) expected = Object.values(WAVES).flat();
  else if (process.env.WAVE) expected = WAVES[process.env.WAVE] || [];
  if (!expected.length) {
    console.error('No expected names. Pass names, or WAVE=13|14|15, or --all.');
    process.exitCode = 2; return;
  }

  const live = await listTools();
  if (!live) { process.exitCode = 2; return; }
  const liveSet = new Set(live);
  console.log(`/mcp tools/list returned ${live.length} tools from ${MCP_URL}\n`);

  let missing = 0;
  for (const name of expected) {
    if (liveSet.has(name)) console.log(`✓ ${name}`);
    else { console.error(`✗ ${name} — NOT registered on the live server`); missing++; }
  }
  console.log(`\n${expected.length - missing}/${expected.length} registered.`);
  if (missing) {
    console.error('verify-mcp-registered FAILED — the deploy did not register all expected tools.');
    process.exitCode = 1;
  } else {
    process.exitCode = 0;
  }
}

// tools/list is paginated (MCP-TOOLSLIST-PAGINATION-1): walk nextCursor to exhaustion so the
// registration check sees the FULL set, not just page one. Each page reuses the rate-limit
// backoff — a 12-page walk can land in the same WAF window the post-deploy hash-sweep burst left.
async function listTools() {
  const names = [];
  let cursor;
  for (let page = 1, id = 1; page <= 100; page++, id++) {
    for (let attempt = 0; attempt <= RL_RETRIES; attempt++) {
      try {
        const res = await fetch(MCP_URL, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            // MCP Streamable HTTP REQUIRES both — application/json alone => HTTP 406
            accept: 'application/json, text/event-stream',
            'mcp-protocol-version': PROTO,
          },
          body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/list', params: cursor ? { cursor } : {} }),
        });
        const bodyText = await res.text(); // consume fully (releases the socket → clean exit)
        // 429/503 = WAF rate-limit, not a real failure — back off and retry.
        if ((res.status === 429 || res.status === 503) && attempt < RL_RETRIES) {
          console.error(`tools/list page ${page} HTTP ${res.status} (rate-limited) — retry ${attempt + 1}/${RL_RETRIES} after ${RL_BACKOFF_MS}ms`);
          await sleep(RL_BACKOFF_MS); continue;
        }
        if (!res.ok) {
          console.error(`tools/list page ${page} HTTP ${res.status}`);
          if (bodyText) console.error(bodyText.slice(0, 300));
          return null;
        }
        const json = parseMaybeSSE(bodyText, res.headers.get('content-type') || '');
        if (!json) { console.error(`Could not parse tools/list page ${page} response.`); return null; }
        if (json.error) { console.error(`tools/list page ${page} error: ${json.error.message || JSON.stringify(json.error)}`); return null; }
        const pageNames = (json.result?.tools || []).map((t) => t.name);
        if (!pageNames.length) { console.error(`tools/list page ${page} returned no tools.`); return null; }
        names.push(...pageNames);
        cursor = json.result?.nextCursor;
        break;
      } catch (e) {
        if (attempt < RL_RETRIES) {
          console.error(`tools/list page ${page} failed: ${e.message} — retry ${attempt + 1}/${RL_RETRIES} after ${RL_BACKOFF_MS}ms`);
          await sleep(RL_BACKOFF_MS); continue;
        }
        console.error(`tools/list page ${page} failed: ${e.message}`);
        return null;
      }
    }
    if (cursor === undefined) {
      if (names.length === 0) return null; // loop never advanced — treat as failure, not empty
      return names;
    }
    if (cursor !== undefined && page === 100) { console.error('cursor walk did not terminate within 100 pages.'); return null; }
  }
  return names;
}

// Streamable-HTTP servers may answer as JSON or as a single SSE event ("event: message\ndata: {…}").
function parseMaybeSSE(text, contentType) {
  const t = text.trim();
  if (contentType.includes('application/json') || t.startsWith('{')) {
    try { return JSON.parse(t); } catch { /* fall through */ }
  }
  // SSE: take the last non-empty data: line and JSON-parse it
  const dataLines = t.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim());
  for (let i = dataLines.length - 1; i >= 0; i--) {
    try { return JSON.parse(dataLines[i]); } catch { /* keep looking */ }
  }
  try { return JSON.parse(t); } catch { return null; }
}
