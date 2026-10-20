#!/usr/bin/env node
// check-tool-schema-params.mjs - MCP-TOOL-SCHEMA-PARAMS-1.
// Offline gate (real worker.mjs against the committed ./data tree) that the node tool schema names the
// manifest input fields and that a misspelt policy_parameters key is reported, not silently defaulted.
//   A. tools/list-shaped definition for compute_annuity (art-327) carries
//      policy_parameters.properties.rate_pct and a description with the manifest summary + Outputs.
//   B. call with `rate` (Solar idx6 miss): still executes, structuredContent.warnings[0].code ===
//      UNKNOWN_POLICY_PARAMETER and did_you_mean.rate === rate_pct (warning mode, see PR body).
//   C. call with `rate_pct`: pv 2211.05, no warnings.
//   D. didYouMean / unknownPolicyKeys unit cases.
//   E. find_tool rows carry `summary`.
// Usage: node scripts/check-tool-schema-params.mjs
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = join(ROOT, 'data');
const { buildServer, loadData, didYouMean, unknownPolicyKeys } = await import('../worker.mjs');
const env = { ASSETS: { fetch: async (url) => {
  const u = new URL(typeof url === 'string' ? url : url.url);
  const fp = join(DATA_DIR, decodeURIComponent(u.pathname).replace(/^\/+/, ''));
  return existsSync(fp) ? new Response(readFileSync(fp), { status: 200 }) : new Response('Not Found', { status: 404 });
} } };
const failures = [];
const check = (ok, label, detail) => { if (ok) console.log('  \u2713 ' + label); else { console.log('  \u2717 ' + label + (detail ? ' - ' + detail : '')); failures.push(label); } };
const data = await loadData(env);
await data.loadSearchIndex(); // search-index.json is lazy (MCP-WORKER-1102-LIMITS-1); a full build needs it, as in the /mcp handler
const NAME = 'compute_annuity';
async function withClient(fn, args = {}, only = NAME) {
  const server = buildServer(data, { ...(only ? { onlyTool: only } : {}), mrtr: { env, args, requestState: null, inputResponses: null, clientCaps: null, principal: 'schema-params-gate' } });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'schema-params-gate', version: '1.0.0' });
  await Promise.all([client.connect(ct), server.connect(st)]);
  try { return await fn(client); } finally { await client.close(); }
}
const solar = { nper: 24, pmt: -100, fv: 0, pv: 0, due: false, solve_for: 'pv' };

console.log('\nA. schema');
const list = await withClient((c) => c.listTools());
const def = list.tools.find((t) => t.name === NAME);
const props = def?.inputSchema?.properties?.policy_parameters?.properties;
check(!!props?.rate_pct, 'policy_parameters.properties.rate_pct published', JSON.stringify(Object.keys(props ?? {})));
check(def?.description.includes('Summary: ') && def.description.includes('Outputs: '), 'description carries Summary + Outputs');
check(def?.description.length < 3000, 'description size sane (' + def?.description.length + ' chars)');

console.log('\nB. misspelt key `rate`');
const argsB = { policy_parameters: { rate: 0.6666666666666667, ...solar } };
const b = await withClient((c) => c.callTool({ name: NAME, arguments: argsB }), argsB);
const w = b.structuredContent?.warnings?.[0];
check(!b.isError, 'call still executes (warning mode)');
check(w?.code === 'UNKNOWN_POLICY_PARAMETER' && w.did_you_mean?.rate === 'rate_pct', 'warning names rate -> rate_pct', JSON.stringify(w));
check(b.content.some((x) => /did you mean "rate_pct"/.test(x.text)), 'text content carries the did-you-mean');

console.log('\nC. correct key `rate_pct`');
const argsC = { policy_parameters: { rate_pct: 0.6666666666666667, ...solar } };
const c = await withClient((cl) => cl.callTool({ name: NAME, arguments: argsC }), argsC);
const pv = c.structuredContent?.artifact?.output_payload?.pv;
check(Math.abs(Math.abs(pv) - 2211.05) < 0.005, 'pv = 2211.05 (abs)', 'pv=' + pv);
check(!c.structuredContent?.warnings, 'no warnings');

console.log('\nD. helpers');
check(didYouMean('rate', ['rate_pct', 'nper', 'pv']) === 'rate_pct', 'prefix match rate -> rate_pct');
check(didYouMean('nperr', ['rate_pct', 'nper', 'pv']) === 'nper', 'edit distance nperr -> nper');
check(didYouMean('zzzzzzzz', ['rate_pct', 'nper']) === null, 'no near match -> null');
check(unknownPolicyKeys({ p: { a: {} } }, { a: 1, b: 2 }).join() === 'b', 'unknownPolicyKeys');
check(unknownPolicyKeys(null, { a: 1 }).length === 0, 'no spec -> no unknowns');

console.log('\nE. find_tool summary');
const ft = await withClient(async (cl) => cl.callTool({ name: 'find_tool', arguments: { query: 'annuity present value', top_n: 5 } }), {}, null);
check((ft.structuredContent?.tools ?? []).some((r) => typeof r.summary === 'string' && r.summary.length), 'find_tool rows carry summary', JSON.stringify(ft.structuredContent?.tools?.[0] ?? ft).slice(0, 200));

if (failures.length) { console.error('\ncheck-tool-schema-params FAILED: ' + failures.length); process.exit(1); }
console.log('\n\u2713 check-tool-schema-params: all assertions hold');
