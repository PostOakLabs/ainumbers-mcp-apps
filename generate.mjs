// Vendors the data the server needs (pilot widget tool HTMLs + manifests + catalog)
// from ../repo into ./data so the server deploys standalone (Render web service AND
// Cloudflare Workers static assets both read ./data).
// Re-run after any AINumbers deploy that touches the pilot tools:  node generate.mjs
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PILOT } from './pilot.mjs';
import { precomputeDiscovery } from './scripts/precompute-discovery.mjs';
import { UTILITY_TOOL_COUNT, UTILITY_TOOL_NAMES } from './utility-tools.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
// REPO must NOT be derived from this script's own location (import.meta.url/ROOT) — that
// silently resolves to the wrong checkout when generate.mjs is run from an isolated worktree
// (MCPCOUNTS-FIX-1, MCPCOUNTS-DRIFT-CAUSE-2026-07-25.md: the site-repo write went into a stray
// worktree and was discarded 5x). Resolve against an explicit --repo=<path> flag, then
// AINUMBERS_REPO, then the invoking shell's cwd — all of which reflect where the session
// actually intends the site checkout to be.
function resolveRepoPath() {
  const flag = process.argv.find(a => a.startsWith('--repo='));
  if (flag) return { path: resolve(flag.slice('--repo='.length)), via: '--repo= flag' };
  if (process.env.AINUMBERS_REPO) return { path: resolve(process.env.AINUMBERS_REPO), via: 'AINUMBERS_REPO env' };
  return { path: resolve(process.cwd(), '..', 'repo'), via: 'cwd/../repo fallback (default)' };
}

// PREFLIGHT-STALE-REFUSE-1: REPO above is never generate.mjs's OWN checkout —
// generate.mjs lives in mcp-apps-poc and only READS from the site repo it
// resolves here, under all three tiers of resolveRepoPath() alike. Vendoring
// from a dirty or stale site checkout is exactly the "617-stale-nodes vendor"
// incident (P13, board/done/PREFLIGHT-STALE-REFUSE-1.md), so this check is
// unconditional (no "own worktree" exemption the way preflight.mjs's default
// mode has one) — refuse (exit 1, plain diagnosis), never silently vendor a
// dirty or non-descendant checkout. Always prints the resolved path + how it
// was reached, and why it was accepted when it is.
function assertRepoFresh(repoPath, via) {
  console.log(`[repo-resolve] site-repo: ${repoPath} (via ${via})`);
  const fixMsg = '   Fix: pass --repo=<path> WITH THE EQUALS (--repo=<path>, not --repo <path>) at a clean, up-to-date checkout, or run from a clean worktree (git fetch + branch off current origin/main).';
  let isGitRepo = true;
  try {
    execSync('git rev-parse --is-inside-work-tree', { cwd: repoPath, stdio: ['ignore', 'ignore', 'ignore'] });
  } catch { isGitRepo = false; }
  if (!isGitRepo) {
    console.error(`❌ REFUSING: ${repoPath} is not a git repository (or does not exist).`);
    console.error(fixMsg);
    process.exit(1);
  }
  let porcelain = '';
  try {
    porcelain = execSync('git status --porcelain', { cwd: repoPath, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch { porcelain = ''; }
  if (porcelain) {
    const lines = porcelain.split('\n');
    console.error(`❌ REFUSING: ${repoPath} is dirty (${lines.length} changed path(s)) — resolved via ${via}, and never this script's own checkout, so it cannot be trusted as a clean vendor source.`);
    for (const l of lines.slice(0, 10)) console.error(`     ${l}`);
    if (lines.length > 10) console.error(`     … and ${lines.length - 10} more`);
    console.error(fixMsg);
    process.exit(1);
  }
  let isDescendant = true;
  try {
    execSync('git rev-parse --verify origin/main', { cwd: repoPath, stdio: 'ignore' });
    execSync('git merge-base --is-ancestor origin/main HEAD', { cwd: repoPath, stdio: 'ignore' });
  } catch { isDescendant = false; }
  if (!isDescendant) {
    console.error(`❌ REFUSING: HEAD in ${repoPath} is not a descendant of origin/main (git merge-base --is-ancestor) — stale checkout.`);
    console.error(fixMsg);
    process.exit(1);
  }
  console.log('[repo-resolve] accepted: clean and descends from origin/main.');
}

const { path: REPO, via: REPO_VIA } = resolveRepoPath();
assertRepoFresh(REPO, REPO_VIA);
const DATA = resolve(ROOT, 'data');

mkdirSync(resolve(DATA,'tools'),{recursive:true});
mkdirSync(resolve(DATA,'manifests'),{recursive:true});
mkdirSync(resolve(DATA,'mcp'),{recursive:true});
mkdirSync(resolve(DATA,'chaingraph'),{recursive:true});
mkdirSync(resolve(DATA,'fv-status'),{recursive:true});
for (const slug of PILOT) {
  writeFileSync(resolve(DATA,'tools',slug+'.html'), readFileSync(resolve(REPO,'tools',slug+'.html')));
  writeFileSync(resolve(DATA,'manifests',slug+'.manifest.json'), readFileSync(resolve(REPO,'manifests',slug+'.manifest.json')));
}
writeFileSync(resolve(DATA,'mcp','catalog.json'), readFileSync(resolve(REPO,'mcp','catalog.json')));
writeFileSync(resolve(DATA,'chaingraph','chaingraph.json'), readFileSync(resolve(REPO,'chaingraph','chaingraph.json')));

// ---------------------------------------------------------------------------
// WORKER-NULLPARITY-LIVE-FEED-1 — the per-tool x_null_distinct exemption registry.
// data/mcp/null-exemptions.json: { [tool_id]: <projected input_schema skeleton> } for EVERY site
// manifest that declares x_null_distinct: true inside its input_schema. The skeleton carries ONLY
// the declared paths (the x_null_distinct marker plus the properties/items structure
// _null_normalize.mjs's recursive walk needs), so the worker consumes the exact exemption
// semantics of the full site schema in a few KB via ONE eager cold-start fetch — zero per-call
// subrequests on the tools/call hot path. A declared node is projected as { x_null_distinct: true }
// and NOT descended (the normalizer preserves that null and never walks into it). The eager-load
// ban (2026-07-09 poisoned-isolate outage) applies to PER-TOOL assets; this is the ONE-asset
// registry shape the row mandates instead.
// ---------------------------------------------------------------------------
const MANIFESTS_SRC = resolve(REPO, 'manifests');
function buildNullExemptions() {
  const project = (schema) => {
    if (!schema || typeof schema !== 'object') return null;
    let out = null;
    if (schema.properties) {
      for (const [k, sub] of Object.entries(schema.properties)) {
        const projected = (sub && sub.x_null_distinct === true) ? { x_null_distinct: true } : project(sub);
        if (projected) {
          out ??= {};
          (out.properties ??= {})[k] = projected;
        }
      }
    } else if (schema.items) {
      const inner = project(schema.items);
      if (inner) out = { items: inner };
    }
    return out;
  };
  const countDeclared = (skeleton) => {
    if (!skeleton || typeof skeleton !== 'object') return 0;
    let n = 0;
    if (skeleton.properties) for (const sub of Object.values(skeleton.properties)) n += (sub?.x_null_distinct === true ? 1 : 0) + countDeclared(sub);
    else if (skeleton.items) n += countDeclared(skeleton.items);
    return n;
  };
  const registry = {};
  let paths = 0;
  for (const f of readdirSync(MANIFESTS_SRC).filter((f) => f.endsWith('.manifest.json')).sort()) {
    let m = null;
    try { m = JSON.parse(readFileSync(resolve(MANIFESTS_SRC, f), 'utf8')); } catch { continue; }
    const skeleton = project(m?.input_schema);
    if (skeleton) { registry[f.slice(0, -'.manifest.json'.length)] = skeleton; paths += countDeclared(skeleton); }
  }
  return { registry, paths };
}
const { registry: nullExemptions, paths: nullExemptionPathCount } = buildNullExemptions();
writeFileSync(resolve(DATA,'mcp','null-exemptions.json'), JSON.stringify(nullExemptions, null, 2) + '\n');
console.log(`null-exemptions registry: ${Object.keys(nullExemptions).length} tool(s) / ${nullExemptionPathCount} declared path(s) -> data/mcp/null-exemptions.json`);
// COMPOSER-PLAN-AND-ROOT-WEBMCP-1: vendor the two derived data sets the worker's
// chain-plan / session-root parity tests assert against (same committed bytes as
// the site repo's data/ — one fixture truth, both runtimes).
writeFileSync(resolve(DATA,'chain-plan-hashes.json'), readFileSync(resolve(REPO,'data','chain-plan-hashes.json')));
writeFileSync(resolve(DATA,'session-root-fixtures.json'), readFileSync(resolve(REPO,'data','session-root-fixtures.json')));

// ---------------------------------------------------------------------------
// fv-status/*.json (FV-AGENTSURFACE-BUILD-1) — one generator-emitted artifact
// per spec_digest, produced by ../repo/scripts/gen-fv-status.mjs. Vendored
// byte-for-byte (not regenerated here — this repo never runs the site's
// generators, only copies their output, same as chaingraph.json above), plus
// a small index worker.mjs reads to build the MCP tool-description pointer.
// ---------------------------------------------------------------------------
const FV_STATUS_SRC = resolve(REPO, 'fv-status');
const fvStatusEntries = [];
if (existsSync(FV_STATUS_SRC)) {
  for (const f of readdirSync(FV_STATUS_SRC).filter((f) => f.endsWith('.json'))) {
    const bytes = readFileSync(resolve(FV_STATUS_SRC, f));
    writeFileSync(resolve(DATA, 'fv-status', f), bytes);
    const parsed = JSON.parse(bytes.toString('utf8'));
    fvStatusEntries.push({ spec_digest: parsed.spec_digest, url: '/fv-status/' + f });
  }
}
writeFileSync(resolve(DATA, 'mcp', 'fv-status-index.json'), JSON.stringify({
  note: 'one entry per spec_digest present under fv-status/ — today every live ChainGraph node shares one spec_digest (one chaingraph/standard/SPEC.md); worker.mjs degrades to "no pointer" if this list is empty or ambiguous, never fabricates one',
  entries: fvStatusEntries,
}, null, 2) + '\n');
console.log('vendored', fvStatusEntries.length, 'fv-status artifact(s) into ./data/fv-status');

// ---------------------------------------------------------------------------
// Node Views (MCP-APPS-NODE-VIEWS-1) — vendor every REGISTERED ChainGraph node's
// self-contained page (repo/chaingraph/<tool_id>.html) VERBATIM into
// data/chaingraph/pages/ and emit data/mcp/node-views.json, the generated SSOT
// worker.mjs reads to (a) attach `_meta: { ui: { resourceUri, visibility } }` to
// each node tool and (b) register the `ui://ainumbers/node/<tool_id>` MCP Apps
// resources (mimeType text/html;profile=mcp-app). The per-view sha256 is the
// SENTINEL tying the served bytes to the site file at THIS vendored commit —
// pages are copied as-is (never rewritten, never stripped), and
// tests/node-views.test.mjs recomputes the sentinel against the committed bytes.
//
// Candidate set mirrors buildServer's node registration filter exactly: non-
// deprecated chaingraph node with an mcp_name, minus the PILOT-widget and
// utility-tool names (worker.mjs `_registeredMcpNames` seed — a node sharing a
// name with a PILOT widget registers as the widget, never as its own tool). A
// node whose page lives OUTSIDE chaingraph/ (tools/*.html, mcp.html) gets no
// view — those surfaces are not chaingraph node pages.
//
// SIZE GUARD: hosts render ui:// resources in a sandboxed iframe; NODE_VIEW_MAX_BYTES
// is the practical ceiling we vendor past. Measured at the vendored commit: the
// LARGEST node page is quoted in the run log below; pages over the guard are
// skipped (listed in `skipped[]` with bytes + reason, never vendored, never
// pointed at). ⛔ `resource_domains` is the ONLY egress the pages need (Google
// Fonts, CONTRACT §0); `connectDomains` is emitted EMPTY and this row must
// never widen it.
// ---------------------------------------------------------------------------
const NODE_VIEW_MAX_BYTES = 1048576; // 1 MiB — measured max node page: 298,239 B (art-594) at the 2026-09-29 vendor; ~3.5x headroom.
const NODE_VIEW_RESOURCE_DOMAINS = ['fonts.googleapis.com', 'fonts.gstatic.com'];
// The name set a node's mcp_name must AVOID for the node itself to be registered as its own
// tool (worker.mjs `_registeredMcpNames` seed: PILOT-widget tool names + the utility tools).
// Shared by the vendor loop below AND the closure self-check after precomputeDiscovery().
const NODE_VIEW_SEED_NAMES = new Set([
  ...PILOT.map((s) => {
    try { return JSON.parse(readFileSync(resolve(DATA, 'manifests', s + '.manifest.json'), 'utf8'))?.mcp_tool_definition?.name ?? s.replace(/-/g, '_'); }
    catch { return s.replace(/-/g, '_'); }
  }),
  ...UTILITY_TOOL_NAMES,
]);
{
  mkdirSync(resolve(DATA, 'chaingraph', 'pages'), { recursive: true });
  // Read from the JUST-VENDORED copy (same bytes as the site file — the counts block below
  // parses the same file; parsed here locally so this section stays order-independent).
  const cgAllNodes = JSON.parse(readFileSync(resolve(DATA, 'chaingraph', 'chaingraph.json'), 'utf8')).nodes ?? [];
  const views = [], skipped = [];
  let largest = { bytes: 0, tool_id: null };
  let vendoredBytes = 0;
  for (const n of cgAllNodes) {
    if (n.status === 'deprecated' || !n.mcp_name || !n.tool_id) continue;
    if (NODE_VIEW_SEED_NAMES.has(n.mcp_name)) continue;
    const pagePath = resolve(REPO, 'chaingraph', n.tool_id + '.html');
    if (!existsSync(pagePath)) continue; // node page lives outside chaingraph/ (tools/*.html, mcp.html) — not a chaingraph node page
    const bytes = readFileSync(pagePath);
    if (bytes.length > largest.bytes) largest = { bytes: bytes.length, tool_id: n.tool_id };
    if (bytes.length > NODE_VIEW_MAX_BYTES) {
      skipped.push({ tool_id: n.tool_id, mcp_name: n.mcp_name, bytes: bytes.length, reason: 'page exceeds NODE_VIEW_MAX_BYTES (' + NODE_VIEW_MAX_BYTES + ' B) — not vendored, not pointed at' });
      continue;
    }
    writeFileSync(resolve(DATA, 'chaingraph', 'pages', n.tool_id + '.html'), bytes);
    vendoredBytes += bytes.length;
    views.push({
      tool_id: n.tool_id,
      mcp_name: n.mcp_name,
      display_name: n.display_name ?? n.tool_id,
      uri: 'ui://ainumbers/node/' + n.tool_id,
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
  }
  if (!views.length) { console.error('SELF-CHECK FAIL: node-views — zero views emitted (chaingraph node pages missing from the site repo?)'); process.exit(1); }
  writeFileSync(resolve(DATA, 'mcp', 'node-views.json'), JSON.stringify({
    note: 'Generated by generate.mjs (MCP-APPS-NODE-VIEWS-1). One entry per registered ChainGraph node tool whose chaingraph/<tool_id>.html page is vendored verbatim under data/chaingraph/pages/ at THIS vendor commit; sha256 is the sentinel tying the served ui:// bytes to those page bytes. Do not hand-edit — re-run node generate.mjs.',
    connect_domains_note: 'always empty — the worker pages make zero network calls (CONTRACT); this row must never widen it',
    max_page_bytes: NODE_VIEW_MAX_BYTES,
    resource_domains: NODE_VIEW_RESOURCE_DOMAINS,
    views,
    skipped,
  }, null, 2) + '\n');
  console.log('node-views: ' + views.length + ' ui://ainumbers/node/ view(s) vendored (' + vendoredBytes + ' B total); largest page ' + largest.bytes + ' B (' + largest.tool_id + '); guard ' + NODE_VIEW_MAX_BYTES + ' B; skipped ' + skipped.length + (skipped.length ? ': ' + skipped.map((s) => s.tool_id + '(' + s.bytes + ' B)').join(', ') : ''));
}

// ---------------------------------------------------------------------------
// Vendor OCG kernel modules in two places:
//   1. data/kernels/  — ASSETS binding (served to browsers via HTTP)
//   2. kernels/       — bundled into the Worker by wrangler/esbuild (static import)
// Only kernel files are vendored (*.kernel.mjs, _hash.mjs, _proof.mjs, _gateval.mjs, _rfc3161.mjs,
// _anchor-testutil.mjs, index.mjs). Test/lint/fix scripts are excluded from both targets.
// ---------------------------------------------------------------------------
const KERNELS_SRC  = resolve(REPO, 'chaingraph', 'kernels');
const KERNELS_DATA = resolve(DATA, 'kernels');
const KERNELS_BUNDLE = resolve(ROOT, 'kernels'); // alongside worker.mjs → bundled by wrangler
mkdirSync(KERNELS_DATA,   { recursive: true });
mkdirSync(KERNELS_BUNDLE, { recursive: true });

// _rfc3161.mjs (§20/§23 shared rfc3161-tst verifier) depends on _anchor-testutil.mjs's DER helpers —
// both must vendor so validate_input_attestations can import verifyRfc3161 at runtime.
// _csv_injection.mjs (WB-5, #508) is workbook.mjs's shared CSV-injection helper — must vendor too.
// _hagate.mjs/_haevidence.mjs (HA-RETRO-1, §27) back the ha_record_validate/ha_gate_status/
// ha_bundle_export worker MCP tools — must vendor too.
const KERNEL_FILE_RE = /^((_hash|_proof|_gateval|_rfc3161|_anchor-testutil|_csv_injection|_hagate|_haevidence|index)\.mjs|[a-z0-9-]+\.kernel\.mjs)$/;
for (const f of readdirSync(KERNELS_SRC).filter(f => KERNEL_FILE_RE.test(f))) {
  const src = readFileSync(resolve(KERNELS_SRC, f));
  writeFileSync(resolve(KERNELS_DATA, f), src);
  writeFileSync(resolve(KERNELS_BUNDLE, f), src);
}

// ---------------------------------------------------------------------------
// Vendor OCG exporter modules (chaingraph_export, OCG §13) — same two targets
// as kernels: data/exporters/ (assets) + ./exporters/ (bundled into the Worker
// via the static import in worker.mjs). All *.mjs except *.test.mjs.
// ---------------------------------------------------------------------------
const EXPORTERS_SRC    = resolve(REPO, 'chaingraph', 'exporters');
const EXPORTERS_DATA   = resolve(DATA, 'exporters');
const EXPORTERS_BUNDLE = resolve(ROOT, 'exporters');
mkdirSync(EXPORTERS_DATA,   { recursive: true });
mkdirSync(EXPORTERS_BUNDLE, { recursive: true });
// *.bundle.mjs = vendored third-party single-file bundles an exporter imports
// (e.g. sdjwt.mjs -> _sdjwt-core.bundle.mjs, OCG §13.12) — they must travel with it.
const EXPORTER_FILE_RE = /^(?!.*\.test\.mjs$)[a-z0-9_-]+(\.bundle)?\.mjs$/;
for (const f of readdirSync(EXPORTERS_SRC).filter(f => EXPORTER_FILE_RE.test(f))) {
  const src = readFileSync(resolve(EXPORTERS_SRC, f));
  writeFileSync(resolve(EXPORTERS_DATA, f), src);
  writeFileSync(resolve(EXPORTERS_BUNDLE, f), src);
}

// ---------------------------------------------------------------------------
// Vendor the WB-1 headless workbook core (WORKBOOK-1-BUILD-SPEC.md §WB-4) verbatim —
// same two targets as kernels/exporters. workbook.mjs imports '../kernels/_hash.mjs'
// relative to its own dir, so it's vendored into a sibling `workbook/` dir alongside
// the already-vendored `kernels/` in both data/ (ASSETS) and ROOT (Worker bundle),
// preserving that relative path unmodified — the whole point of "verbatim".
// ---------------------------------------------------------------------------
const WORKBOOK_SRC = resolve(REPO, 'chaingraph', 'workbook', 'workbook.mjs');
const WORKBOOK_DATA_DIR = resolve(DATA, 'workbook');
const WORKBOOK_BUNDLE_DIR = resolve(ROOT, 'workbook');
mkdirSync(WORKBOOK_DATA_DIR, { recursive: true });
mkdirSync(WORKBOOK_BUNDLE_DIR, { recursive: true });
{
  const src = readFileSync(WORKBOOK_SRC);
  writeFileSync(resolve(WORKBOOK_DATA_DIR, 'workbook.mjs'), src);
  writeFileSync(resolve(WORKBOOK_BUNDLE_DIR, 'workbook.mjs'), src);
}

// XLR-4: vendor the XLR-2 comparator (roundtrip-verify.mjs) verbatim into the SAME
// workbook/ dir as workbook.mjs above — it imports './workbook.mjs' and
// '../kernels/_csv_injection.mjs' relative to its own location, both already
// satisfied by the workbook.mjs vendor step and the kernel vendor step above.
// Same two targets (data/ ASSETS + ROOT Worker bundle), same verbatim discipline.
{
  const ROUNDTRIP_SRC = resolve(REPO, 'chaingraph', 'workbook', 'roundtrip-verify.mjs');
  const src = readFileSync(ROUNDTRIP_SRC);
  writeFileSync(resolve(WORKBOOK_DATA_DIR, 'roundtrip-verify.mjs'), src);
  writeFileSync(resolve(WORKBOOK_BUNDLE_DIR, 'roundtrip-verify.mjs'), src);
}

// ---------------------------------------------------------------------------
// Emit data/counts.json — single source of truth for all numeric stats used
// in mcp.html, chaingraph-hub.html, JSON-LD, og:description, i18n strings.
// build_workflow_links chain names are read from chaingraph.json.chains (after F).
// ---------------------------------------------------------------------------
const cgJson   = JSON.parse(readFileSync(resolve(DATA,'chaingraph','chaingraph.json'),'utf8'));
const catJson  = JSON.parse(readFileSync(resolve(DATA,'mcp','catalog.json'),'utf8'));
const cgNodes  = cgJson.nodes ?? [];
const cgChains = cgJson.chains ?? [];
const liveNodes = cgNodes.filter(n => n.status === 'live').length;
const gpuFalseNodes = cgNodes.filter(n => n.status === 'live' && n.gpu === false).length;
// Count MCP tool registrations: ChainGraph nodes + pilot tools + utility tools.
// Utility count is derived from the single source of truth (utility-tools.mjs) — never hardcode it.
// ART653-LIVE-SERVE-FIX-1: the served node leg mirrors buildServer's registration filter in
// worker.mjs (every mcp_name EXCEPT chaingraph-`deprecated`) — NOT `live`-only, which
// under-counted served registered+vendored non-live nodes (compute_pta_verifier, status
// "planned"): build-mcp-parity's count-drift gate caught 718 vs 719 registered.
const UTIL_TOOL_COUNT = UTILITY_TOOL_COUNT;
const servedNodeTools = cgNodes.filter(n => n.mcp_name && n.status !== 'deprecated').length;
const mcpToolsTotal = servedNodeTools + PILOT.length + UTIL_TOOL_COUNT;
const counts = {
  chaingraph_nodes_live: liveNodes,
  chaingraph_nodes_gpu_false: gpuFalseNodes,
  pilot_widgets: PILOT.length,
  catalog_tools: (catJson.tools ?? []).length,
  named_chains: cgChains.length,
  mcp_tools_total: mcpToolsTotal,
};
writeFileSync(resolve(DATA,'counts.json'), JSON.stringify(counts, null, 2) + '\n');

// Also write repo/data/mcp-counts.json so the SITE repo's counts.mjs can derive
// mcp.live in CI (where mcp-apps-poc/ is not checked out).
const siteMcpCounts = {
  pilot_widgets: PILOT.length,
  utility_tools: UTIL_TOOL_COUNT,
  _note: 'Updated by mcp-apps-poc/generate.mjs — run after changing pilot.mjs and commit both files. Utility count includes find_chain + find_tool (discovery layer).',
};
try {
  writeFileSync(resolve(REPO, 'data', 'mcp-counts.json'), JSON.stringify(siteMcpCounts, null, 2) + '\n');
} catch (e) {
  console.warn('Could not write repo/data/mcp-counts.json:', e.message);
}

// Vendor the ext-apps browser SDK as an export-free inlinable script for the widget glue.
// Claude's widget sandbox (and the tools' own CSP meta) block third-party CDN imports, so the
// SDK must be inlined into the widget HTML rather than imported from esm.sh at runtime.
const sdkSrc = readFileSync(resolve(ROOT,'node_modules','@modelcontextprotocol','ext-apps','dist','src','app-with-deps.js'),'utf8');
const sdkInline = sdkSrc.replace(/export\{([^}]*)\};?\s*$/, (_, names) => {
  const props = names.split(',').map(s => s.trim()).filter(Boolean).map(s => {
    const m = s.split(/\s+as\s+/);
    return m.length === 2 ? `${m[1]}:${m[0]}` : `${s}:${s}`;
  }).join(',');
  return `globalThis.__EXT_APPS__={${props}};`;
});
if (!sdkInline.includes('__EXT_APPS__')) throw new Error('ext-apps SDK export transform failed — check app-with-deps.js export shape');
writeFileSync(resolve(DATA,'ext-apps-inline.js'), sdkInline);

// ---------------------------------------------------------------------------
// Build BM25 search index for find_chain and find_tool tools (discovery layer).
// Precomputed at vendor time so Workers runtime only does lightweight scoring.
// ---------------------------------------------------------------------------
function tokenizeForIndex(text) {
  return (text ?? '').toLowerCase()
    .replace(/[^a-z0-9_-]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 1);
}

function buildBM25(docs, getTextField) {
  const N = docs.length;
  if (!N) return { tfs: [], docLengths: [], avgDocLength: 1, idf: {} };
  const tfs = docs.map(doc => {
    const counts = {};
    for (const t of tokenizeForIndex(getTextField(doc))) counts[t] = (counts[t] || 0) + 1;
    return counts;
  });
  const docLengths = tfs.map(tf => Object.values(tf).reduce((s, c) => s + c, 0));
  const avgDocLength = docLengths.reduce((s, c) => s + c, 0) / N || 1;
  const df = {};
  for (const tf of tfs) for (const t of Object.keys(tf)) df[t] = (df[t] || 0) + 1;
  const idf = {};
  for (const [t, f] of Object.entries(df)) idf[t] = Math.log((N - f + 0.5) / (f + 0.5) + 1);
  return { tfs, docLengths, avgDocLength, idf };
}

// Build node lookup for step resolution
const nodeByToolId = {};
for (const n of cgNodes) if (n.tool_id) nodeByToolId[n.tool_id] = n;

// Browser-tool page lookup: chain steps that are HTML tools (not MCP compute nodes)
// have no mcp_name, but they DO have a tool page. Resolve a real URL (no fabricated
// dead links — only emit a URL when the file exists) so find_chain steps are always actionable.
const TOOL_FILES = new Set(
  readdirSync(resolve(REPO, 'tools')).filter(f => f.endsWith('.html')).map(f => f.slice(0, -5))
);
const toolPageUrl = (toolId) =>
  TOOL_FILES.has(toolId) ? 'https://ainumbers.co/tools/' + toolId + '.html' : null;

// Live-node filter for the chain projection (WORKER-CHAIN-LIVE-FILTER-1).
// Node tools are projected `status === 'live'` ONLY — nodeDocs below,
// outputSchemas, knownToolNames and the counts all carry that predicate. chains[] was the
// one projection that did not, so find_chain advertised a recipe whose step is a departed
// tool: `mica-transitional` was returned with entry_mcp_name "route_mica_transitional_deadline"
// and callable:true while that mcp_name is registered NOWHERE on /mcp (art-99 is
// status:"deprecated", so the node-tool filters had already dropped it). An external agent
// was being told it could call something that is gone. Same predicate, same file, now
// symmetric.
//
// A step whose tool_id resolves to NO ChainGraph node is a browser-only HTML tool
// (no mcp_name, opened via tool_url — 397 such steps across 102 chains today). Those are
// NOT dead steps and their chains stay: the predicate fires only on a step that resolves to
// a node whose status is not "live".
//
// Scope: this is the DISCOVERY surface (find_chain / data/search-index.json). run_chain and
// build_workflow_links resolve chains from the vendored chaingraph.json directly in
// worker.mjs, which is a byte-identical copy of the site SSOT and is not narrowed here.
const chainDeadSteps = (c) =>
  (c.steps ?? [])
    .map((s, i) => ({ pos: i + 1, tool_id: s.tool_id, node: nodeByToolId[s.tool_id] }))
    .filter((x) => x.node && x.node.status !== 'live');
const advertisableChains = cgChains.filter((c) => chainDeadSteps(c).length === 0);
for (const c of cgChains) {
  const dead = chainDeadSteps(c);
  if (dead.length) {
    console.log(
      'chain "' + c.name + '" withheld from find_chain — non-live step(s): ' +
      dead.map((d) => 'step' + d.pos + ' ' + d.tool_id + ' (status:' + d.node.status + ')').join(', '),
    );
  }
}

// Chain docs — one per ADVERTISABLE chain; includes full recipe for find_chain return payload
const chainDocs = advertisableChains.map(c => {
  const steps = (c.steps ?? []).map((s, i) => {
    const node = nodeByToolId[s.tool_id];
    return {
      step: i + 1,
      tool_id: s.tool_id,
      mcp_name: node?.mcp_name ?? null,
      // callable = invocable via /mcp (a compute node); else it's a browser tool → open tool_url
      callable: !!node?.mcp_name,
      display_name: node?.display_name ?? s.tool_id,
      tool_url: node?.url ?? toolPageUrl(s.tool_id),
      handoff: s.handoff ?? null,
    };
  });
  return {
    chain_name: c.name,
    title: c.title ?? c.name,
    description: c.description ?? '',
    composer_url: c.composer_url ?? null,
    steps,
    // first MCP-callable node, not just steps[0] (which may be a browser tool with no mcp_name)
    entry_mcp_name: steps.find(st => st.mcp_name)?.mcp_name ?? null,
    _text: [c.name, c.title, c.description, (c.steps ?? []).map(s => s.tool_id + ' ' + (s.handoff ?? '')).join(' ')].join(' '),
  };
});

// Node docs — live nodes only; includes info needed for find_tool return payload
const nodeDocs = cgNodes
  .filter(n => n.status === 'live')
  .map(n => ({
    tool_id: n.tool_id,
    mcp_name: n.mcp_name ?? '',
    display_name: n.display_name ?? '',
    url: n.url ?? '',
    wave: n.wave ?? null,
    mandate_type: n.mandate_type ?? '',
    gpu: !!n.gpu,
    // Include n.description so find_tool matches regulatory keywords in the node prose
    // (e.g. "TRID tolerance", "camt.053", "HOEPA") — chains index their description, nodes did not.
    _text: [n.mcp_name, n.display_name, n.mandate_type, n.tool_id, n.description ?? '', (n.consumes ?? []).join(' '), (n.feeds ?? []).join(' ')].join(' '),
  }));

const chainIndex = buildBM25(chainDocs, d => d._text);
const nodeIndex  = buildBM25(nodeDocs,  d => d._text);

// Strip internal _text field before writing
const chainDocsClean = chainDocs.map(({ _text, ...d }) => d);
const nodeDocsClean  = nodeDocs.map(({ _text, ...d }) => d);

writeFileSync(resolve(DATA, 'search-index.json'), JSON.stringify({
  chains: { docs: chainDocsClean, ...chainIndex },
  nodes:  { docs: nodeDocsClean,  ...nodeIndex  },
}, null, 2) + '\n');

// ---------------------------------------------------------------------------
// Workflow recipes (MCP-SUITE-RECIPES-1) — data/mcp/recipes.json, the single
// generated source feeding BOTH the suite_howto tool and the per-recipe MCP
// prompts. SSOT discipline (row design 4): recipes derive from the SAME source
// mcp.html renders — the #workflows table (the exact source scripts/counts.mjs
// derives the published `workflows.recipes` sentinel count from) — enriched
// with the matching chaingraph.json chain (title/domain/description/steps/
// composer_url). ZERO hand-written recipe text: an edit to the mcp.html table
// or a chain lands here on the next `node generate.mjs`, one place.
// ---------------------------------------------------------------------------
function decodeEntities(s) {
  return (s ?? '')
    .replace(/&rarr;/g, '->').replace(/&larr;/g, '<-').replace(/&harr;/g, '<->')
    .replace(/&nbsp;/g, ' ').replace(/&middot;/g, '·')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'");
}
function cellText(s) {
  return decodeEntities(String(s ?? '').replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ').trim();
}
{
  const mcpHtml = readFileSync(resolve(REPO, 'mcp.html'), 'utf8');
  const wfStart = mcpHtml.indexOf('id="workflows"');
  const wfEnd   = mcpHtml.indexOf('</table>', wfStart);
  if (wfStart === -1 || wfEnd === -1) {
    console.error('SELF-CHECK FAIL: mcp.html #workflows table not found — recipes SSOT moved?');
    process.exit(1);
  }
  const wfSection = mcpHtml.slice(wfStart, wfEnd);

  // Parse the table. Group rows (<tr class="tool-group">) carry the surface
  // label ("Orchestrated composers ..." / chain-viewer group); data rows are
  // the <tr><td>NAME</td><td>WHAT</td><td>COMPOSER</td></tr> shape counts.mjs
  // counts for the workflows.recipes sentinel.
  const chainByName = new Map(cgChains.map((c) => [c.name, c]));
  const rawRowCount = (wfSection.match(/<tr><td>/g) || []).length;
  const recipes = [];
  const rowRe = /<tr><td>([^<]*)<\/td><td>([\s\S]*?)<\/td><td>([\s\S]*?)<\/td><\/tr>/g;
  let m;
  while ((m = rowRe.exec(wfSection)) !== null) {
    const id = cellText(m[1]);
    const whatItRuns = cellText(m[2]);
    const composerCell = m[3];
    const composerHref = (composerCell.match(/href="([^"]+)"/) || [])[1] ?? null;
    if (!id) continue;
    const chain = chainByName.get(id) ?? null;
    const title = chain?.title ?? id;
    const domain = chain?.domain ?? null;
    const use_when = chain
      ? ('Use when the task is in "' + domain + '" and needs the "' + title + '" workflow')
      : ('Use when you need the "' + id + '" workflow: ' + whatItRuns);
    recipes.push({
      id,
      title,
      domain,
      use_when: use_when.length > 220 ? use_when.slice(0, 217) + '...' : use_when,
      what_it_runs: whatItRuns,
      description: chain?.description ?? null,
      composer_url: chain?.composer_url ?? composerHref,
      entry_mcp_name: null,
      steps: [],
      _matched_chain: !!chain,
    });
  }

  if (recipes.length !== rawRowCount) {
    console.error('SELF-CHECK FAIL: parsed ' + recipes.length + ' recipe rows but the #workflows table carries ' + rawRowCount + ' <tr><td> rows (counts.mjs sentinel basis) — parser drift.');
    process.exit(1);
  }
  if (!recipes.length) {
    console.error('SELF-CHECK FAIL: zero workflow recipes parsed from mcp.html #workflows — refusing to emit an empty index.');
    process.exit(1);
  }

  // Enrich matched recipes with ordered steps (same live-node resolution shape
  // as chainDocs above: mcp_name when the node is callable, else its tool page).
  for (const r of recipes) {
    const chain = chainByName.get(r.id);
    if (!chain) continue;
    r.steps = (chain.steps ?? []).map((s, i) => {
      const node = nodeByToolId[s.tool_id];
      return {
        step: i + 1,
        tool_id: s.tool_id,
        mcp_name: node?.mcp_name ?? null,
        callable: !!node?.mcp_name,
        display_name: node?.display_name ?? s.tool_id,
        tool_url: node?.url ?? toolPageUrl(s.tool_id),
        handoff: s.handoff ?? null,
      };
    });
    r.entry_mcp_name = r.steps.find((st) => st.mcp_name)?.mcp_name ?? null;
  }

  const unmatched = recipes.filter((r) => !r._matched_chain).map((r) => r.id);
  if (unmatched.length) {
    console.log('recipes: ' + unmatched.length + ' row(s) had no chaingraph.json chain match (table-text only): ' + unmatched.join(', '));
  }
  const cleaned = recipes.map(({ _matched_chain, ...r }) => r);
  writeFileSync(resolve(DATA, 'mcp', 'recipes.json'), JSON.stringify({
    note: 'Generated by generate.mjs from the mcp.html #workflows table (the workflows.recipes sentinel SSOT) enriched with chaingraph.json chains. Do not hand-edit — edit the source table/chain and re-run node generate.mjs.',
    count: cleaned.length,
    recipes: cleaned,
  }, null, 2) + '\n');
  console.log('recipes: ' + cleaned.length + ' workflow recipe(s) -> data/mcp/recipes.json (' + cleaned.filter((r) => r.entry_mcp_name).length + ' with an MCP-callable entry step)');
}

// ---------------------------------------------------------------------------
// Showcase prompts (MCP-SHOWCASE-PROMPTS-1) — data/mcp/showcase-prompts.json, a verbatim
// projection of the site repo's mcp/showcase-prompts.json (AGENT-REACH-BUILD-SPEC §3.3 SSOT,
// bodies from research/WEBMCP-AGENT-SHOWCASE-PROMPTS-2026-09-05.md §1–§5). Parallel to the
// recipes source above (mcp.html #workflows), not a replacement: recipes stay the chain SSOT;
// this file is the non-chain, end-to-end estate demos. Zero hand-written prompt text here —
// edit the site SSOT and re-run node generate.mjs.
// ---------------------------------------------------------------------------
{
  const spPath = resolve(REPO, 'mcp', 'showcase-prompts.json');
  if (!existsSync(spPath)) {
    console.error('SELF-CHECK FAIL: site SSOT mcp/showcase-prompts.json not found in the resolved site repo — run against a checkout that carries it.');
    process.exit(1);
  }
  const ssot = JSON.parse(readFileSync(spPath, 'utf8'));
  // Spec §3.3 shape: the SSOT is a bare ARRAY of prompt objects.
  const items = Array.isArray(ssot) ? ssot : null;
  const requiredFields = ['id', 'title', 'one_line', 'doorways', 'arguments', 'body', 'verify_surface'];
  const bad = (items ?? []).filter((p) => requiredFields.some((f) => p[f] === undefined) || !Array.isArray(p.arguments) || p.arguments.some((a) => !a.name || !a.description));
  // EXAMPLE-PROMPTS-JSON-1: the site SSOT grew 5 -> 46; the count is the SSOT's business
  // (ratcheted down-only by the site gate scripts/check-showcase-prompts.mjs), so the
  // projection accepts whatever non-empty bare array the SSOT carries.
  if (!Array.isArray(items) || items.length < 1 || bad.length) {
    console.error('SELF-CHECK FAIL: mcp/showcase-prompts.json malformed — items=' + (items ? items.length : 'not-an-array') + ' (expected a non-empty bare array per AGENT-REACH-BUILD-SPEC §3.3), malformed: ' + bad.map((p) => p.id).join(', '));
    process.exit(1);
  }
  const dupes = items.map((p) => p.id).filter((id, i, a) => a.indexOf(id) !== i);
  if (dupes.length) {
    console.error('SELF-CHECK FAIL: duplicate showcase prompt id(s): ' + dupes.join(', '));
    process.exit(1);
  }
  writeFileSync(resolve(DATA, 'mcp', 'showcase-prompts.json'), JSON.stringify({
    note: 'Generated by generate.mjs from the site repo mcp/showcase-prompts.json (the showcase-prompt SSOT, AGENT-REACH-BUILD-SPEC §3.3). Do not hand-edit — edit the site file and re-run node generate.mjs.',
    count: items.length,
    prompts: items,
  }, null, 2) + '\n');
  console.log('showcase-prompts: ' + items.length + ' prompt(s) -> data/mcp/showcase-prompts.json (' + items.map((p) => p.id).join(', ') + ')');
}

// ---------------------------------------------------------------------------
// outputSchema projection (MCP-500-1 §M1.4) — READ-ONLY from repo/manifests/*.manifest.json
// (never chaingraph.json; see the §M1.4 K-adjacent rider). Keyed by mcp_name so worker.mjs can
// attach `outputSchema` to a tool's registration without re-deriving it at request time. Omitted
// entirely for a tool_id with no manifest or no declared output_schema (never fabricated).
// ---------------------------------------------------------------------------
const outputSchemas = {};
for (const n of cgNodes) {
  if (n.status !== 'live' || !n.mcp_name || !n.tool_id) continue;
  try {
    const manifestPath = resolve(REPO, 'manifests', n.tool_id + '.manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (manifest.output_schema) outputSchemas[n.mcp_name] = manifest.output_schema;
  } catch { /* no manifest for this tool_id — omit, don't fabricate */ }
}
for (const slug of PILOT) {
  try {
    const manifest = JSON.parse(readFileSync(resolve(DATA, 'manifests', slug + '.manifest.json'), 'utf8'));
    const name = manifest?.mcp_tool_definition?.name;
    if (name && manifest.output_schema) outputSchemas[name] = manifest.output_schema;
  } catch { /* ignore */ }
}
writeFileSync(resolve(DATA, 'mcp', 'output-schemas.json'), JSON.stringify(outputSchemas, null, 2) + '\n');
console.log('outputSchema projected for', Object.keys(outputSchemas).length, 'tools (read-only from repo/manifests/*)');

console.log('vendored', PILOT.length, 'pilot tools + manifests + catalog + chaingraph.json (' + liveNodes + '/' + cgNodes.length + ' live nodes, ' + cgChains.length + ' chains, ' + chainDocs.length + ' advertisable in find_chain) + kernels + counts.json + ext-apps-inline.js + search-index.json into ./data');

// ---------------------------------------------------------------------------
// Tool deprecation lifecycle (MCP-500-2 §M2.2). Source of truth is the WORKER-repo-local
// lifecycle-overrides.json (NOT chaingraph.json — that would be a site-repo single-writer K
// edit; the §M2.2 rider is satisfied here without touching the frozen v0.4 schema or the
// SITE's chaingraph.json at all). Every registered mcp_name defaults to "Active" when absent.
// Vendored into data/mcp/lifecycle.json; worker.mjs reads it at request time.
// ---------------------------------------------------------------------------
const lifecycleSrc = JSON.parse(readFileSync(resolve(ROOT, 'lifecycle-overrides.json'), 'utf8'));
const LIFECYCLE_STATES = new Set(['Active', 'Deprecated', 'Removed']);
const knownToolNames = new Set([
  ...PILOT.map((s) => {
    try { return JSON.parse(readFileSync(resolve(DATA, 'manifests', s + '.manifest.json'), 'utf8'))?.mcp_tool_definition?.name ?? s.replace(/-/g, '_'); }
    catch { return s.replace(/-/g, '_'); }
  }),
  ...UTILITY_TOOL_NAMES,
  ...cgNodes.filter((n) => n.status === 'live' && n.mcp_name).map((n) => n.mcp_name),
]);
let lifecycleFails = 0;
for (const [name, status] of Object.entries(lifecycleSrc.overrides || {})) {
  if (!LIFECYCLE_STATES.has(status)) { console.error('SELF-CHECK FAIL: lifecycle-overrides.json "' + name + '" has invalid status "' + status + '" (must be Active|Deprecated|Removed)'); lifecycleFails++; }
  if (!knownToolNames.has(name)) { console.error('SELF-CHECK FAIL: lifecycle-overrides.json "' + name + '" is not a registered mcp_name (typo?)'); lifecycleFails++; }
}
if (lifecycleFails) { console.error(`generate.mjs SELF-CHECK FAILED (${lifecycleFails} lifecycle-overrides mismatch(es))`); process.exit(1); }
writeFileSync(resolve(DATA, 'mcp', 'lifecycle.json'), JSON.stringify({ default: 'Active', overrides: lifecycleSrc.overrides || {} }, null, 2) + '\n');
const lifecycleCounts = { Active: knownToolNames.size, Deprecated: 0, Removed: 0 };
for (const status of Object.values(lifecycleSrc.overrides || {})) { if (status !== 'Active') { lifecycleCounts[status]++; lifecycleCounts.Active--; } }
console.log('lifecycle:', lifecycleCounts);

// Precompute the static MCP discovery responses (initialize/tools-list/resources-list/prompts-list)
// from the REAL buildServer so the Worker never rebuilds ~186 tools per request on the Free-plan
// CPU budget. Must run AFTER all data/ files above are written (it reads them). See
// scripts/precompute-discovery.mjs + the O(1) fast path in worker.mjs.
const disc = await precomputeDiscovery();
console.log('precomputed discovery static responses:', disc, '→ data/mcp/static/');

// ---------------------------------------------------------------------------
// Node-views closure self-check (MCP-APPS-NODE-VIEWS-1) — runs AFTER precomputeDiscovery()
// because it reads the JUST-regenerated static discovery bytes. Proves the loop is closed in
// BOTH directions against the REAL buildServer output (not generate.mjs's own seed math):
//   (a) every view's node tool is served and carries the exact `_meta.ui` pointer;
//   (b) every view is listed with the MCP Apps mime type and the generated CSP metadata;
//   (c) every SERVED node tool whose page is vendored has a view — if worker.mjs's
//       registration filter ever diverges from the seed set above, THIS is where it fails.
// ---------------------------------------------------------------------------
{
  const nv = JSON.parse(readFileSync(resolve(DATA, 'mcp', 'node-views.json'), 'utf8'));
  const sseResult = (file) => {
    const txt = readFileSync(resolve(DATA, 'mcp', 'static', file), 'utf8').replace('__OCG_ID__', '12345');
    return JSON.parse(txt.split('\n').find((l) => l.startsWith('data:')).slice(5).trim()).result;
  };
  const toolsByName = new Map(sseResult('tools-list.sse.txt').tools.map((t) => [t.name, t]));
  const resourcesByUri = new Map(sseResult('resources-list.sse.txt').resources.map((r) => [r.uri, r]));
  const pageSet = new Set(readdirSync(resolve(DATA, 'chaingraph', 'pages')));
  const skippedIds = new Set((nv.skipped ?? []).map((s) => s.tool_id));
  let nf = 0;
  for (const v of nv.views) {
    const t = toolsByName.get(v.mcp_name);
    if (!t) { console.error('SELF-CHECK FAIL: node-views — view ' + v.tool_id + ' mcp_name ' + v.mcp_name + ' is not a served tool'); nf++; continue; }
    if (JSON.stringify(t._meta?.ui) !== JSON.stringify({ resourceUri: v.uri, visibility: ['model', 'app'] })) {
      console.error('SELF-CHECK FAIL: node-views — tool ' + v.mcp_name + ' _meta.ui is ' + JSON.stringify(t._meta?.ui) + ' (expected resourceUri + visibility [model, app])'); nf++;
    }
    const r = resourcesByUri.get(v.uri);
    if (!r) { console.error('SELF-CHECK FAIL: node-views — resources-list missing ' + v.uri); nf++; continue; }
    if (r.mimeType !== 'text/html;profile=mcp-app' || JSON.stringify(r._meta?.ui) !== JSON.stringify({ resourceDomains: nv.resource_domains, connectDomains: [] })) {
      console.error('SELF-CHECK FAIL: node-views — resource ' + v.uri + ' metadata drift: ' + JSON.stringify({ mimeType: r.mimeType, ui: r._meta?.ui })); nf++;
    }
    if (!pageSet.has(v.tool_id + '.html')) { console.error('SELF-CHECK FAIL: node-views — view ' + v.tool_id + ' has no vendored page'); nf++; }
  }
  for (const t of sseResult('tools-list.sse.txt').tools) {
    const node = (cgNodes.find((n) => n.mcp_name === t.name)) ?? null;
    if (!node || !node.tool_id) continue; // PILOT / utility tool
    if (NODE_VIEW_SEED_NAMES.has(t.name)) continue; // registers as the PILOT/utility tool, never as its own node tool
    const v = nv.views.find((x) => x.mcp_name === t.name);
    if (v) continue;
    // No view for a SERVED node tool is legal ONLY when the node has no chaingraph page at
    // all, or the page was size-skipped. Anything else is seed drift vs worker.mjs's filter.
    const pageOnSite = existsSync(resolve(REPO, 'chaingraph', node.tool_id + '.html'));
    if (pageOnSite && !skippedIds.has(node.tool_id)) {
      console.error('SELF-CHECK FAIL: node-views — served node tool ' + t.name + ' (' + node.tool_id + ') has a page but no view — seed drift vs worker.mjs registration filter'); nf++;
    }
  }
  const extraNodeResources = [...resourcesByUri.keys()].filter((u) => u.startsWith('ui://ainumbers/node/') && !nv.views.some((v) => v.uri === u));
  if (extraNodeResources.length) { console.error('SELF-CHECK FAIL: node-views — resources-list carries node uris outside the view set: ' + extraNodeResources.join(', ')); nf++; }
  if (nf) { console.error(`generate.mjs SELF-CHECK FAILED (${nf} node-views mismatch(es)) — do NOT commit this output.`); process.exit(1); }
  console.log('node-views closure: ' + nv.views.length + ' view(s) ↔ tools-list pointers ↔ resources-list entries all consistent ✓');
}

// ---------------------------------------------------------------------------
// PROMPTS-WORKER-CONTEXT-1 P1/P3 — two generated indexes, both derived from files written
// ABOVE (they read the describe map precompute just emitted, so this block must stay AFTER
// precomputeDiscovery()):
//
//   data/mcp/prompt-context.json   per showcase prompt, the descriptor + inputSchema of each
//                                  worker-resident tool the prompt names, which worker.mjs ships
//                                  as extra `resource` messages on prompts/get.
//   data/mcp/completion-index.json the derivable value domains completion/complete answers from,
//                                  served on an O(1) worker fast path (no buildServer spin-up).
//
// Zero hand-written values in either file: tool names come from the showcase SSOT's `tools`
// field, definitions from data/mcp/static/tool-describe.json (the same bytes describe_tool
// serves), page URLs / chain ids / tool names from the vendored graph. `helmd:*` names belong to
// a DIFFERENT server and any name this worker does not serve is SKIPPED, never fabricated.
// ---------------------------------------------------------------------------
{
  const MAX_CONTEXT_TOOLS = 8;          // per prompt — a walkthrough's tool list, not a catalog
  const PROMPT_CONTEXT_CAP_BYTES = 40960; // 40 KB of embedded descriptors per prompt
  const describeMap = JSON.parse(readFileSync(resolve(DATA, 'mcp', 'static', 'tool-describe.json'), 'utf8'));
  const projection = JSON.parse(readFileSync(resolve(DATA, 'mcp', 'showcase-prompts.json'), 'utf8'));
  const showcaseItems = projection.prompts ?? [];

  // ── prompt-context.json ─────────────────────────────────────────────────────
  // Overflow discipline: once the embedded-descriptor budget is spent, the remaining tools ship
  // as resource_link entries (uri + name, no body) — the host can still fetch tool://<name>
  // through resources/read. A prompt is never silently truncated to fit.
  const promptContext = {};
  let embedded = 0, linked = 0, skipped = 0;
  for (const p of showcaseItems) {
    const declared = Array.isArray(p.tools) ? p.tools : [];
    const resident = declared.filter((n) => typeof n === 'string' && !n.startsWith('helmd:')
      && Object.prototype.hasOwnProperty.call(describeMap, n));
    skipped += declared.length - resident.length;
    const entries = [];
    let used = 0;
    for (const name of resident.slice(0, MAX_CONTEXT_TOOLS)) {
      const def = describeMap[name];
      const text = JSON.stringify({ name: def.name, description: def.description, inputSchema: def.inputSchema }, null, 2);
      const bytes = Buffer.byteLength(text, 'utf8');
      if (used + bytes > PROMPT_CONTEXT_CAP_BYTES) { entries.push({ uri: 'tool://' + name, name }); linked++; continue; }
      used += bytes;
      entries.push({ uri: 'tool://' + name, text });
      embedded++;
    }
    if (entries.length) promptContext[p.id] = entries;
  }
  writeFileSync(resolve(DATA, 'mcp', 'prompt-context.json'), JSON.stringify({
    note: 'Generated by generate.mjs (PROMPTS-WORKER-CONTEXT-1) from data/mcp/showcase-prompts.json `tools` + data/mcp/static/tool-describe.json. Do not hand-edit — edit the site SSOT / a tool definition and re-run node generate.mjs.',
    max_tools_per_prompt: MAX_CONTEXT_TOOLS,
    cap_bytes_per_prompt: PROMPT_CONTEXT_CAP_BYTES,
    prompts: promptContext,
  }, null, 2) + '\n');
  console.log('prompt-context: ' + Object.keys(promptContext).length + '/' + showcaseItems.length
    + ' showcase prompt(s) carry tool context (' + embedded + ' embedded descriptor(s), ' + linked
    + ' resource_link overflow, ' + skipped + ' non-resident/helmd name(s) skipped) -> data/mcp/prompt-context.json');

  // ── completion-index.json ───────────────────────────────────────────────────
  // THREE derivable domains only. A prompt argument whose name is not in ARG_DOMAIN has no
  // derivable domain and completion/complete answers `{ values: [] }` for it — we never invent a
  // value set for a free-text argument (a dollar cap, a sample URL, an endpoint of the caller's
  // own choosing). Narrowing: `context.arguments.chain_id` restricts node_page to the pages of
  // that chain's steps, stored as INDEXES into the node_page array so the per-chain map stays
  // small instead of repeating every URL once per chain.
  const ARG_DOMAIN = { node_page: 'node_page', chain_id: 'chain_id', tool_name: 'tool_name' };
  const nodePages = [];
  const pageIndexByToolId = new Map();
  for (const n of cgNodes) {
    if (!n.mcp_name || n.status === 'deprecated') continue;
    if (typeof n.url !== 'string' || !n.url.startsWith('http')) continue;
    let at = nodePages.indexOf(n.url);
    if (at < 0) { at = nodePages.length; nodePages.push(n.url); }
    if (n.tool_id) pageIndexByToolId.set(n.tool_id, at);
  }
  const nodePageByChain = {};
  for (const c of cgChains) {
    if (!c.name) continue;
    const idx = [...new Set((c.steps ?? []).map((s) => pageIndexByToolId.get(s.tool_id)).filter((i) => i !== undefined))];
    if (idx.length) nodePageByChain[c.name] = idx;
  }
  writeFileSync(resolve(DATA, 'mcp', 'completion-index.json'), JSON.stringify({
    note: 'Generated by generate.mjs (PROMPTS-WORKER-CONTEXT-1) from chaingraph.json (node page URLs, chain ids), data/mcp/static/tool-describe.json (served tool names) and the showcase-prompt argument names. Do not hand-edit. Served by the completion/complete fast path in worker.mjs.',
    rule: 'prompt_args/resource_args map an argument name to one of the three derivable domains; every other argument completes to an empty value list. node_page_by_chain holds INDEXES into domains.node_page.',
    domains: {
      node_page: nodePages,
      chain_id: cgChains.map((c) => c.name).filter(Boolean),
      tool_name: Object.keys(describeMap),
    },
    node_page_by_chain: nodePageByChain,
    prompt_args: Object.fromEntries(showcaseItems
      .map((p) => [p.id, Object.fromEntries((p.arguments ?? [])
        .filter((a) => ARG_DOMAIN[a.name])
        .map((a) => [a.name, ARG_DOMAIN[a.name]]))])
      .filter(([, mapped]) => Object.keys(mapped).length)),
    resource_args: { 'tool://{mcp_name}': { mcp_name: 'tool_name' } },
  }, null, 2) + '\n');
  console.log('completion-index: ' + nodePages.length + ' node page(s), ' + cgChains.length + ' chain id(s), '
    + Object.keys(describeMap).length + ' tool name(s), ' + Object.keys(nodePageByChain).length
    + ' chain narrowing(s) -> data/mcp/completion-index.json');
}

// ---------------------------------------------------------------------------
// Self-verification: confirm every output byte matches its source.
// Catches stash/pop corruption, wrong-cwd ghosts, and any other mismatch
// before it reaches git. Exits 1 loudly so the commit never happens.
// ---------------------------------------------------------------------------
const normText = s => s.replace(/\r\n/g, '\n');
let selfFails = 0;

// chaingraph.json — semantic equality (JSON round-trip strips formatting noise)
{
  const vend = JSON.parse(readFileSync(resolve(DATA, 'chaingraph', 'chaingraph.json'), 'utf8'));
  const src  = JSON.parse(readFileSync(resolve(REPO, 'chaingraph', 'chaingraph.json'), 'utf8'));
  if (JSON.stringify(vend) !== JSON.stringify(src)) {
    console.error('SELF-CHECK FAIL: data/chaingraph/chaingraph.json does not match site source'); selfFails++;
  }
}

// fv-status/*.json — byte equality (straight copy, not a regenerate)
if (existsSync(FV_STATUS_SRC)) {
  for (const f of readdirSync(FV_STATUS_SRC).filter((f) => f.endsWith('.json'))) {
    const src  = readFileSync(resolve(FV_STATUS_SRC, f));
    const vend = readFileSync(resolve(DATA, 'fv-status', f));
    if (!src.equals(vend)) { console.error(`SELF-CHECK FAIL: data/fv-status/${f} does not match site source`); selfFails++; }
  }
}

// kernels (bundle copy) — byte equality after CRLF normalisation
for (const f of readdirSync(KERNELS_SRC).filter(f => KERNEL_FILE_RE.test(f))) {
  const src    = normText(readFileSync(resolve(KERNELS_SRC, f), 'utf8'));
  const bundle = normText(readFileSync(resolve(KERNELS_BUNDLE, f), 'utf8'));
  if (src !== bundle) { console.error(`SELF-CHECK FAIL: kernels/${f} does not match site source`); selfFails++; }
}

// Registry completeness — every *.kernel.mjs file MUST be registered in index.mjs.
// The dual-registry trap (2026-07-10, art-275): a kernel file gets vendored into kernels/ +
// data/kernels/ but its import/entry is forgotten in kernels/index.mjs, so the KERNELS map
// never references it. kernel-coverage --strict only surfaces this INDIRECTLY (the node lands
// as UNPORTED gpu:false) and only in worker CI. Assert it here so the miss fails at generate
// time, naming the exact file — before the push, before the indirect coverage failure.
{
  const idxText = normText(readFileSync(resolve(KERNELS_SRC, 'index.mjs'), 'utf8'));
  const registered = new Set(
    [...idxText.matchAll(/['"]([a-z0-9][a-z0-9-]+)['"]\s*:/g)].map((m) => m[1]),
  );
  for (const f of readdirSync(KERNELS_SRC).filter(f => f.endsWith('.kernel.mjs'))) {
    const id = f.slice(0, -'.kernel.mjs'.length);
    if (!registered.has(id)) {
      console.error(`SELF-CHECK FAIL: kernels/${f} is NOT registered in kernels/index.mjs (add import + KERNELS['${id}'] entry — dual-registry trap, CONTRACT §A4)`);
      selfFails++;
    }
  }
}

// null-exemptions registry — regenerate + byte-compare (WORKER-NULLPARITY-LIVE-FEED-1)
{
  const { registry: regen } = buildNullExemptions();
  const written = readFileSync(resolve(DATA, 'mcp', 'null-exemptions.json'), 'utf8');
  if (written !== JSON.stringify(regen, null, 2) + '\n') {
    console.error('SELF-CHECK FAIL: data/mcp/null-exemptions.json does not match the site manifests projection'); selfFails++;
  }
}

if (selfFails) {
  console.error(`\ngenerate.mjs SELF-CHECK FAILED (${selfFails} mismatch(es)) — do NOT commit this output.`);
  process.exit(1);
}
console.log('Self-check: all outputs match site source ✓');

// Chain-fixtures (OCGR Phase A) are part of the SAME vendor bundle. This used to be a
// second, separate manual step (`node scripts/gen-chain-fixtures.mjs`) with its own worker
// CI gate ("Chain-fixtures freshness"), and forgetting it produced a half-vendor (kernels +
// data fresh, data/chain-fixtures.json stale) that only failed on worker CI. Folding it here
// makes `node generate.mjs` emit a COMPLETE bundle so a half-vendor is structurally impossible.
// gen-chain-fixtures.mjs reads the site's committed HEAD via SITE_REPO (== REPO here).
console.log('Regenerating data/chain-fixtures.json (OCGR Phase A) ...');
execSync('node scripts/gen-chain-fixtures.mjs', {
  cwd: ROOT,
  stdio: 'inherit',
  env: { ...process.env, SITE_REPO: REPO },
});
console.log('Vendor bundle complete (data/ + kernels/ + data/chain-fixtures.json) ✓');
