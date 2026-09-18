// check-worker-invariants.mjs — deterministic guard against the EXACT /mcp worker regressions
// that caused outages on 2026-06-26. Runs in CI (Validate MCP server) + locally — no live worker.
//
// wrangler dev does NOT enforce the Cloudflare Free 10ms CPU / subrequest limits, so the CPU-class
// regressions can't be reproduced pre-deploy. Instead, each check below blocks the SPECIFIC code
// pattern that caused each outage, so a future change that reintroduces it fails BEFORE deploy
// rather than being relearned through an outage. Background: memory project-ainumbers-mcp-server-no-cache.

import { readFileSync, existsSync, readdirSync } from 'node:fs';
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

// ── MCP-TOOLSLIST-TRIM-DESCRIBE-1 (2026-09-18) ────────────────────────────────────────────────
// 7) The tools/list trim + describe_tool contract, asserted against the COMMITTED static bytes:
//    (a) no list entry carries `outputSchema` (it moved behind describe_tool);
//    (b) every entry whose tool HAS an output schema (data/mcp/output-schemas.json) carries the
//        ONE pointer sentence at the end of its description — and no other entry does;
//    (c) describe_tool itself is on PAGE ONE of the default list (the byte-budget page a client
//        gets with no cursor — replicate the worker's greedy page scan on the template bytes);
//    (d) data/mcp/static/tool-describe.json exists, covers exactly the served set, and carries
//        outputSchema exactly for the tools output-schemas.json covers (describe_tool must be
//        able to hand back what the list dropped);
//    (e) initialize.json advertises capabilities.tools.listChanged (row ADDITION A — the client
//        is told the list can change; the SDK auto-declares it, this guard keeps it true).
{
  const sseTools = (file) => {
    const txt = readFileSync(resolve(STATIC, file), 'utf8');
    const dataLine = txt.replace('__OCG_ID__', '12345').split('\n').find((l) => l.startsWith('data:'));
    return JSON.parse(dataLine.slice(5).trim()).result.tools;
  };
  const LIST_PAGE_MAX_BYTES = 150000; // must equal worker.mjs LIST_PAGE_MAX_BYTES
  const listFiles = (() => {
    try { return readdirSync(STATIC).filter((f) => /^tools-list(\..+)?\.sse\.txt$/.test(f)).sort(); }
    catch { return []; }
  })();
  if (!listFiles.length) fails.push('no data/mcp/static/tools-list*.sse.txt artifacts — run generate.mjs.');
  let schemas = {};
  try { schemas = JSON.parse(readFileSync(resolve(ROOT, 'data', 'mcp', 'output-schemas.json'), 'utf8')); } catch { /* none */ }
  let page1Names = null;
  for (const f of listFiles) {
    let tools;
    try { tools = sseTools(f); } catch (e) { fails.push(f + ': not parseable as a tools/list frame — ' + e.message); continue; }
    const withSchema = tools.filter((t) => 'outputSchema' in t);
    if (withSchema.length) {
      fails.push(f + ': ' + withSchema.length + ' tool entries still carry outputSchema (' +
        withSchema.slice(0, 3).map((t) => t.name).join(', ') + (withSchema.length > 3 ? ', …' : '') +
        ') — the trim regressed; re-run generate.mjs.');
    }
    for (const t of tools) {
      const expected = ' Output schema: call describe_tool("' + t.name + '").';
      const has = typeof t.description === 'string' && t.description.endsWith(expected);
      const claims = typeof t.description === 'string' && / Output schema: call describe_tool\("[^"]+"\)\.$/.test(t.description);
      if (schemas[t.name] && !has) fails.push(f + ': "' + t.name + '" lost its outputSchema without gaining the exact pointer sentence — re-run generate.mjs.');
      if (!schemas[t.name] && claims) fails.push(f + ': "' + t.name + '" carries a pointer sentence but has no output schema in output-schemas.json — description drift.');
    }
    if (f === 'tools-list.sse.txt') {
      // (c) greedy first-page scan over the template bytes — same rule as worker.mjs
      // scanListPageBounds/buildListPage: accept elements while the accepted range fits the budget.
      const txt = readFileSync(resolve(STATIC, f), 'utf8');
      const marker = '"tools":[';
      const arr = txt.indexOf(marker);
      if (arr < 0) fails.push('tools-list.sse.txt: no "tools":[ array — generated shape changed.');
      else {
        const from = arr + marker.length;
        const names = [];
        let depth = 0, inStr = false, esc = false, elemStart = -1, end = -1;
        for (let i = from; i < txt.length; i++) {
          const c = txt[i];
          if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
          if (c === '"') { inStr = true; continue; }
          if (c === '{' || c === '[') { if (depth === 0) elemStart = i; depth++; continue; }
          if (c === '}' || c === ']') {
            if (c === ']' && depth === 0) break;
            depth--;
            if (depth === 0 && c === '}') {
              const elemEnd = i + 1;
              if (end >= 0 && elemEnd - from > LIST_PAGE_MAX_BYTES) break;
              end = elemEnd;
              const m = txt.slice(elemStart, elemEnd).match(/"name":"([^"]+)"/);
              if (m) names.push(m[1]);
            }
          }
        }
        page1Names = new Set(names);
      }
    }
  }
  if (page1Names) {
    if (!page1Names.has('describe_tool')) fails.push('describe_tool is NOT on page one of tools-list.sse.txt — it must be listed in the first ~' + LIST_PAGE_MAX_BYTES + ' template bytes (register it before the page boundary).');
    else ok.push('describe_tool present on tools/list page one (' + page1Names.size + ' tools in the no-cursor page)');
  }
  // (d) describe map ↔ served set ↔ output-schemas.json agreement.
  const mapPath = resolve(STATIC, 'tool-describe.json');
  if (!existsSync(mapPath)) fails.push('missing data/mcp/static/tool-describe.json — describe_tool has nothing to serve; run generate.mjs.');
  else {
    const map = JSON.parse(readFileSync(mapPath, 'utf8'));
    const served = sseTools('tools-list.sse.txt');
    const servedNames = new Set(served.map((t) => t.name));
    const missingDef = [...servedNames].filter((n) => !(n in map));
    const extraDef = Object.keys(map).filter((n) => !servedNames.has(n));
    if (missingDef.length) fails.push('tool-describe.json is missing definitions for: ' + missingDef.slice(0, 5).join(', ') + (missingDef.length > 5 ? ' …' : '') + ' — re-run generate.mjs.');
    if (extraDef.length) fails.push('tool-describe.json carries entries the list does not serve: ' + extraDef.slice(0, 5).join(', ') + ' — re-run generate.mjs.');
    const schemaMismatch = Object.keys(map).filter((n) =>
      ('outputSchema' in map[n]) !== (!!schemas[n] || n === 'describe_tool'));
    // (describe_tool's own schema is SDK-declared at registration, not manifest-projected —
    // output-schemas.json is the MANIFEST projection only, so it never lists describe_tool.)
    if (schemaMismatch.length) fails.push('tool-describe.json outputSchema presence diverges from output-schemas.json for: ' + schemaMismatch.slice(0, 5).join(', ') + ' — re-run generate.mjs.');
    if (!missingDef.length && !extraDef.length && !schemaMismatch.length) {
      ok.push('tool-describe.json covers all ' + Object.keys(map).length + ' served tools with outputSchema exactly where output-schemas.json has one');
    }
  }
  // (e) ADDITION A: capabilities.tools.listChanged stays advertised at initialize.
  const initP2 = resolve(STATIC, 'initialize.json');
  if (!existsSync(initP2)) fails.push('missing data/mcp/static/initialize.json — run generate.mjs.');
  else if (JSON.parse(readFileSync(initP2, 'utf8'))?.capabilities?.tools?.listChanged !== true) {
    fails.push('initialize.json capabilities.tools.listChanged is not true — the client must be told the tool list can change (row ADDITION A).');
  } else ok.push('initialize.json advertises capabilities.tools.listChanged: true');
}

if (fails.length) {
  console.error('✗ worker-invariants FAILED (' + fails.length + '):');
  for (const f of fails) console.error('  • ' + f);
  console.error('\nThese guard the 2026-06-26 /mcp outage classes (memory project-ainumbers-mcp-server-no-cache).');
  process.exit(1);
}
console.log('✓ worker-invariants clean (' + ok.length + ' checks): ' + ok.join('; '));
