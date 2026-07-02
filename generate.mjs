// Vendors the data the server needs (pilot widget tool HTMLs + manifests + catalog)
// from ../repo into ./data so the server deploys standalone (Render web service AND
// Cloudflare Workers static assets both read ./data).
// Re-run after any AINumbers deploy that touches the pilot tools:  node generate.mjs
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PILOT } from './pilot.mjs';
import { precomputeDiscovery } from './scripts/precompute-discovery.mjs';
import { UTILITY_TOOL_COUNT } from './utility-tools.mjs';

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
// Only kernel files are vendored (*.kernel.mjs, _hash.mjs, _proof.mjs, index.mjs).
// Test/lint/fix scripts are excluded from both targets.
// ---------------------------------------------------------------------------
const KERNELS_SRC  = resolve(REPO, 'chaingraph', 'kernels');
const KERNELS_DATA = resolve(DATA, 'kernels');
const KERNELS_BUNDLE = resolve(ROOT, 'kernels'); // alongside worker.mjs → bundled by wrangler
mkdirSync(KERNELS_DATA,   { recursive: true });
mkdirSync(KERNELS_BUNDLE, { recursive: true });

const KERNEL_FILE_RE = /^((_hash|_proof|index)\.mjs|[a-z0-9-]+\.kernel\.mjs)$/;
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
  generated_at: new Date().toISOString(),
};
writeFileSync(resolve(DATA,'counts.json'), JSON.stringify(counts, null, 2) + '\n');

// Also write repo/data/mcp-counts.json so the SITE repo's counts.mjs can derive
// mcp.live in CI (where mcp-apps-poc/ is not checked out).
const siteMcpCounts = {
  pilot_widgets: PILOT.length,
  utility_tools: UTIL_TOOL_COUNT,
  _note: 'Updated by mcp-apps-poc/generate.mjs — run after changing pilot.mjs and commit both files. Utility count includes find_chain + find_tool (discovery layer).',
  generated_at: counts.generated_at,
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
    _text: [n.mcp_name, n.display_name, n.mandate_type, n.tool_id, (n.consumes ?? []).join(' '), (n.feeds ?? []).join(' ')].join(' '),
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

console.log('vendored', PILOT.length, 'pilot tools + manifests + catalog + chaingraph.json (' + liveNodes + '/' + cgNodes.length + ' live nodes, ' + cgChains.length + ' chains) + kernels + counts.json + ext-apps-inline.js + search-index.json into ./data');

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

if (selfFails) {
  console.error(`\ngenerate.mjs SELF-CHECK FAILED (${selfFails} mismatch(es)) — do NOT commit this output.`);
  process.exit(1);
}
console.log('Self-check: all outputs match site source ✓');
