// Vendors the data the server needs (pilot widget tool HTMLs + manifests + catalog)
// from ../repo into ./data so the server deploys standalone (Render web service AND
// Cloudflare Workers static assets both read ./data).
// Re-run after any AINumbers deploy that touches the pilot tools:  node generate.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
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

// Vendor the ext-apps browser SDK as an export-free inlinable script for the widget glue.
// Claude's widget sandbox (and the tools' own CSP meta) block third-party CDN imports, so the
// SDK must be inlined into the widget HTML rather than imported from esm.sh at runtime.
const sdkSrc = readFileSync(resolve(ROOT,'node_modules','@modelcontextprotocol','ext-apps','dist','src','app-with-deps.js'),'utf8');
const sdkInline = sdkSrc.replace(/export\{([\s\S]*?)\};?\s*$/, (_, names) => {
  const props = names.split(',').map(s => s.trim()).filter(Boolean).map(s => {
    const m = s.split(/\s+as\s+/);
    return m.length === 2 ? `${m[1]}:${m[0]}` : `${s}:${s}`;
  }).join(',');
  return `globalThis.__EXT_APPS__={${props}};`;
});
if (!sdkInline.includes('__EXT_APPS__')) throw new Error('ext-apps SDK export transform failed — check app-with-deps.js export shape');
writeFileSync(resolve(DATA,'ext-apps-inline.js'), sdkInline);
const cgNodes = JSON.parse(readFileSync(resolve(REPO,'chaingraph','chaingraph.json'),'utf8')).nodes ?? [];
console.log('vendored', PILOT.length, 'pilot tools + manifests + catalog + chaingraph.json (' + cgNodes.length + ' nodes) + ext-apps-inline.js into ./data');
