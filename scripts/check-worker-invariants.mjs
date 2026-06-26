// check-worker-invariants.mjs — deterministic guard against the EXACT /mcp worker regressions
// that caused outages on 2026-06-26. Runs in CI (Validate MCP server) + locally — no live worker.
//
// wrangler dev does NOT enforce the Cloudflare Free 10ms CPU / subrequest limits, so the CPU-class
// regressions can't be reproduced pre-deploy. Instead, each check below blocks the SPECIFIC code
// pattern that caused each outage, so a future change that reintroduces it fails BEFORE deploy
// rather than being relearned through an outage. Background: memory project-ainumbers-mcp-server-no-cache.

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const worker = readFileSync(resolve(ROOT, 'worker.mjs'), 'utf8');
const fails = [];
const ok = [];

// 1) Never cache + reuse the McpServer across requests. The SDK binds server<->transport 1:1;
//    caching it and reconnecting per request throws "Already connected to a transport" and 500s
//    the whole /mcp handshake (full outage, commits #17/#18, reverted). Fresh server per request.
if (/\b(serverCache|cachedServer|cachedMcpServer)\b/.test(worker))
  fails.push('caches the McpServer (serverCache/cachedServer) — SDK is 1:1 server<->transport; caching+reconnecting => "Already connected to a transport" => /mcp 500. Build a FRESH server per request.');
else ok.push('no cached-and-reused McpServer');

// 2) The big discovery lists must be served as pre-framed TEXT, never JSON.parsed. Re-parsing the
//    330KB tools-list.json on a cold isolate burned the Free 10ms CPU budget (1102).
if (/mcp\/static\/(tools|resources|prompts)-list\.json/.test(worker))
  fails.push('reads a parsed *-list.json discovery asset — the large lists must be served as pre-framed .sse.txt TEXT (getStaticListTemplate + .text()), never JSON.parsed on the hot path.');
else ok.push('discovery lists not re-parsed from *-list.json');

// 3) The old eager getStaticDiscovery (loaded all 4 assets = 4 subrequests + 330KB parse on every
//    discovery call, and was pulled into tools/call => "too many subrequests"/1102) must not return.
if (/function getStaticDiscovery\b/.test(worker))
  fails.push('reintroduces getStaticDiscovery (eager 4-asset loader). Use per-method loaders (getStaticInitialize / getStaticListTemplate).');
else ok.push('no eager getStaticDiscovery loader');

// 4) tools/call must derive known-names from already-loaded data, not by fetching static discovery
//    (that added 4 subrequests + a 330KB parse to every cold tools/call => 1102 / too-many-subrequests).
if (!/data\.__toolNames/.test(worker))
  fails.push('no longer derives tools/call known-names from loadData (data.__toolNames) — re-adding a static-discovery fetch to tools/call re-triggers the cold-isolate subrequest/CPU spike.');
else ok.push('tools/call known-names derived from loadData');

// 5) Static-discovery artifacts are well-formed: exactly one id placeholder, valid JSON-RPC after splice.
const STATIC = resolve(ROOT, 'data', 'mcp', 'static');
for (const f of ['tools-list.sse.txt', 'resources-list.sse.txt', 'prompts-list.sse.txt']) {
  const p = resolve(STATIC, f);
  if (!existsSync(p)) { fails.push('missing static discovery artifact data/mcp/static/' + f + ' — run generate.mjs.'); continue; }
  const txt = readFileSync(p, 'utf8');
  const ph = txt.split('__OCG_ID__').length - 1;
  if (ph !== 1) { fails.push(f + ': id placeholder appears ' + ph + 'x (must be exactly 1) — collision/malformed frame.'); continue; }
  try {
    const dataLine = txt.replace('__OCG_ID__', '12345').split('\n').find((l) => l.startsWith('data:')).slice(5).trim();
    const o = JSON.parse(dataLine);
    if (o.jsonrpc !== '2.0' || o.id !== 12345 || !o.result) throw new Error('bad JSON-RPC envelope');
    ok.push(f + ': valid JSON-RPC after id splice');
  } catch (e) { fails.push(f + ': not valid JSON-RPC after id splice — ' + e.message); }
}
const initP = resolve(STATIC, 'initialize.json');
if (!existsSync(initP)) fails.push('missing data/mcp/static/initialize.json — run generate.mjs.');
else {
  const i = JSON.parse(readFileSync(initP, 'utf8'));
  if (!i.capabilities || !i.serverInfo) fails.push('initialize.json missing capabilities/serverInfo.');
  else ok.push('initialize.json well-formed');
}

// 6) GET/HEAD on /mcp must short-circuit to 405. The stateless worker can't serve the GET
//    server->client SSE channel; routing GET into the transport opens a stream that never closes,
//    so the runtime kills the "hung" request at ~30s and 500s (recurring "Worker hung", fixed by
//    the 405 short-circuit — memory project-ainumbers-mcp-get-405). Guard against its removal.
if (!/request\.method === 'GET'/.test(worker) || !/status: 405/.test(worker))
  fails.push("the GET/HEAD -> 405 short-circuit for /mcp appears removed — a stateless worker can't serve the GET SSE channel; routing GET into the transport hangs + 500s (\"Worker hung\"). Keep the `request.method === 'GET'` => 405 guard.");
else ok.push('GET/HEAD -> 405 short-circuit present');

if (fails.length) {
  console.error('✗ worker-invariants FAILED (' + fails.length + '):');
  for (const f of fails) console.error('  • ' + f);
  console.error('\nThese guard the 2026-06-26 /mcp outage classes (memory project-ainumbers-mcp-server-no-cache).');
  process.exit(1);
}
console.log('✓ worker-invariants clean (' + ok.length + ' checks): ' + ok.join('; '));
