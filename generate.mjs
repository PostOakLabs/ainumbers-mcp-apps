// Vendors the data the server needs (7 widget tool HTMLs + manifests + catalog)
// from ../repo into ./data so the server deploys standalone (e.g. on Render).
// Re-run after any AINumbers deploy that touches the pilot tools:  node generate.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(ROOT, '..', 'repo');
const DATA = resolve(ROOT, 'data');
const PILOT = ['152-baas-provider-comparator','320-ap2-mcp-policy-validator','285-google-ap2-mandate-builder',
  '288-mcp-developer-readiness-scorecard','rbe-06-agentic-mandate-sandbox','110-customer-risk-rating','131-ap2-aml-mandate-builder'];

mkdirSync(resolve(DATA,'tools'),{recursive:true});
mkdirSync(resolve(DATA,'manifests'),{recursive:true});
mkdirSync(resolve(DATA,'mcp'),{recursive:true});
for (const slug of PILOT) {
  writeFileSync(resolve(DATA,'tools',slug+'.html'), readFileSync(resolve(REPO,'tools',slug+'.html')));
  writeFileSync(resolve(DATA,'manifests',slug+'.manifest.json'), readFileSync(resolve(REPO,'manifests',slug+'.manifest.json')));
}
writeFileSync(resolve(DATA,'mcp','catalog.json'), readFileSync(resolve(REPO,'mcp','catalog.json')));
console.log('vendored', PILOT.length, 'tools + manifests + catalog into ./data');
