// measure-unknown-policy-keys.mjs - MCP-TOOL-SCHEMA-PARAMS-1 step 3.
// For every in-repo caller that supplies policy_parameters to a node tool (chain fixtures, session-root
// fixtures, the manifests' own input_example, the linear-hash goldens, tests/fixtures), diff the call's
// top-level keys against the tool's declared input_schema.properties (data/mcp/input-schemas.json).
// Prints one line per offending call and a summary; exit 0 always (it is a measurement, the guard's
// hard-error-vs-warning decision is made from its output).
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const specs = JSON.parse(readFileSync(resolve(ROOT, 'data/mcp/input-schemas.json'), 'utf8'));
const j = (p) => JSON.parse(readFileSync(resolve(ROOT, p), 'utf8'));
let calls = 0, unspec = 0; const bad = [];
function check(src, toolId, pp) {
  if (!pp || typeof pp !== 'object' || Array.isArray(pp)) return;
  calls++;
  const spec = specs[toolId];
  if (!spec) { unspec++; return; }
  const extra = Object.keys(pp).filter((k) => !(k in spec.p));
  if (extra.length) bad.push(src + ' ' + toolId + ' extra=' + extra.join(','));
}
// chain fixtures: { chainId: { toolId: pp } }
for (const f of ['data/chain-fixtures.json', 'data/session-root-fixtures.json']) {
  if (!existsSync(resolve(ROOT, f))) continue;
  const d = j(f);
  const walk = (o, label) => { for (const [chain, steps] of Object.entries(o ?? {})) if (steps && typeof steps === 'object') for (const [tid, pp] of Object.entries(steps)) if (/^(art-|\d)/.test(tid) || specs[tid]) check(f + '#' + chain, tid, pp); };
  walk(d.fixtures ?? d, f);
}
// manifests' own input_example
for (const f of readdirSync(resolve(ROOT, 'data/manifests'))) {
  const m = j('data/manifests/' + f);
  if (m.input_example) check('manifest-example', m.tool_id ?? f.replace('.manifest.json', ''), m.input_example);
}
console.log('callers examined: ' + calls + ' (' + unspec + ' for tools with no declared properties)');
console.log('calls passing keys absent from the manifest input_schema.properties: ' + bad.length);
for (const b of bad.slice(0, 40)) console.log('  ' + b);
