// Vendors the data the server needs (pilot widget tool HTMLs + manifests + catalog)
// from ../repo into ./data so the server deploys standalone (Render web service AND
// Cloudflare Workers static assets both read ./data).
// Re-run after any AINumbers deploy that touches the pilot tools:  node generate.mjs
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PILOT } from './pilot.mjs';
import { precomputeDiscovery } from './scripts/precompute-discovery.mjs';
import { UTILITY_TOOL_COUNT, UTILITY_TOOL_NAMES } from './utility-tools.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(ROOT, '..', 'repo');
const DATA = resolve(ROOT, 'data');

mkdirSync(resolve(DATA,'tools'),{recursive:true});
mkdirSync(resolve(DATA,'manifests'),{recursive:true});
mkdirSync(resolve(DATA,'mcp'),{recursive:true});
mkdirSync(resolve(DATA,'chaingraph'),{recursive:true});
for (const slug of PILOT) {
  writeFileSync(resolve(DATA,'tools',slug+'.html'), readFileSync(resolve(REPO,'tools',slug+'.html')));
  writeFileSync(resolve(DATA,'manifests',slug+'.manifest.json'), readFileSync(resolve(REPO,'manifests',slug+'.manifest.json')));
}
writeFileSync(resolve(DATA,'mcp','catalog.json'), readFileSync(resolve(REPO,'mcp','catalog.json')));
writeFileSync(resolve(DATA,'chaingraph','chaingraph.json'), readFileSync(resolve(REPO,'chaingraph','chaingraph.json')));

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
const KERNEL_FILE_RE = /^((_hash|_proof|_gateval|_rfc3161|_anchor-testutil|index)\.mjs|[a-z0-9-]+\.kernel\.mjs)$/;
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
const UTIL_TOOL_COUNT = UTILITY_TOOL_COUNT;
const mcpToolsTotal = liveNodes + PILOT.length + UTIL_TOOL_COUNT;
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

// Chain docs — one per chain; includes full recipe for find_chain return payload
const chainDocs = cgChains.map(c => {
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
// Named toolsets (MCP-500-1 §M1.2, GitHub-MCP server-card profile pattern) — a NAME LIST
// projection of chaingraph.json onto a handful of domain profiles, generator-emitted only
// (never hand-authored, §A5.3 surface-parity). Membership derives from the existing node
// facet (mcp_name + display_name + description + tool_id text) via a fixed keyword rule
// below — adding a profile or widening one is a generator-rule edit, zero worker logic.
// worker.mjs expands the lean §M1.1 core with a profile's members when a client requests
// ?toolset=<name> on /mcp (server stays stateless: the query param is read per-request,
// no session state held).
// ---------------------------------------------------------------------------
const PROFILE_KEYWORDS = {
  reserve:  ['reserve', 'proof of reserve', 'por ', 'stablecoin', 'merkle-sum'],
  mortgage: ['mortgage', 'trid', 'hoepa', 'hmda', ' qm ', 'llpa', 'heloc', 'fha ', 'va funding', 'conforming loan', 'mismo', 'scra'],
  emir:     ['emir', ' uti ', ' upi ', 'trade report', 'derivatives margin', 'csdr'],
  anchors:  ['anchor', 'timestamp', 'rfc3161', 'sigstore', 'merkle batch', 'ots proof', 'witness'],
  'ai-act': ['ai act', 'fria', 'gpai', 'annex iii', 'high-risk ai', 'conformity', 'nist ai rmf'],
};
const toolsetProfiles = {};
for (const [profile, keywords] of Object.entries(PROFILE_KEYWORDS)) {
  toolsetProfiles[profile] = cgNodes
    .filter((n) => n.status === 'live' && n.mcp_name)
    .filter((n) => {
      const hay = ' ' + [n.mcp_name, n.display_name, n.description, n.tool_id].filter(Boolean).join(' ').toLowerCase() + ' ';
      return keywords.some((kw) => hay.includes(kw));
    })
    .map((n) => n.mcp_name);
}
writeFileSync(resolve(DATA, 'mcp', 'toolsets.json'), JSON.stringify({
  rule: 'substring keyword match of PROFILE_KEYWORDS against lowercased "mcp_name display_name description tool_id" — see generate.mjs',
  profiles: toolsetProfiles,
}, null, 2) + '\n');
console.log('toolset profiles:', Object.fromEntries(Object.entries(toolsetProfiles).map(([k, v]) => [k, v.length])));

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

console.log('vendored', PILOT.length, 'pilot tools + manifests + catalog + chaingraph.json (' + liveNodes + '/' + cgNodes.length + ' live nodes, ' + cgChains.length + ' chains) + kernels + counts.json + ext-apps-inline.js + search-index.json into ./data');

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
