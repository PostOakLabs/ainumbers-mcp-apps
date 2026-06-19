// Vendors the data the server needs (pilot widget tool HTMLs + manifests + catalog)
// from ../repo into ./data so the server deploys standalone (Render web service AND
// Cloudflare Workers static assets both read ./data).
// Re-run after any AINumbers deploy that touches the pilot tools:  node generate.mjs
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PILOT } from './pilot.mjs';

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
// Only kernel files are vendored (*.kernel.mjs, _hash.mjs, index.mjs).
// Test/lint/fix scripts are excluded from both targets.
// ---------------------------------------------------------------------------
const KERNELS_SRC  = resolve(REPO, 'chaingraph', 'kernels');
const KERNELS_DATA = resolve(DATA, 'kernels');
const KERNELS_BUNDLE = resolve(ROOT, 'kernels'); // alongside worker.mjs → bundled by wrangler
mkdirSync(KERNELS_DATA,   { recursive: true });
mkdirSync(KERNELS_BUNDLE, { recursive: true });

const KERNEL_FILE_RE = /^((_hash|index)\.mjs|[a-z0-9-]+\.kernel\.mjs)$/;
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
const EXPORTER_FILE_RE = /^(?!.*\.test\.mjs$)[a-z0-9_-]+\.mjs$/;
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
// Count MCP tool registrations: ChainGraph nodes + pilot tools + utility tools (list/build/verify/emit/receipt=6)
const UTIL_TOOL_COUNT = 7; // list_ainumbers_tools, build_workflow_links, verify_execution_hash, build_chaingraph, emit_chaingraph_artifact, build_session_receipt, export_artifact
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
console.log('vendored', PILOT.length, 'pilot tools + manifests + catalog + chaingraph.json (' + liveNodes + '/' + cgNodes.length + ' live nodes, ' + cgChains.length + ' chains) + kernels + counts.json + ext-apps-inline.js into ./data');
