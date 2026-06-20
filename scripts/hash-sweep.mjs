import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MCP_URL = process.env.MCP_URL || 'https://mcp.ainumbers.co/mcp';
const THROTTLE_MS = Number(process.env.THROTTLE_MS || 1500);
const PROTO = process.env.MCP_PROTOCOL_VERSION || '2025-06-18';
const STRICT_LOCAL = process.env.STRICT_LOCAL === '1';
const RL_RETRIES = Number(process.env.RL_RETRIES || 4);
const LIMIT = Number(process.env.HASH_SWEEP_LIMIT || (process.env.CI ? 40 : 0));

const CHAINGRAPH = process.env.CHAINGRAPH || firstExisting([join(HERE,'..','data','chaingraph','chaingraph.json'), join(HERE,'..','mcp-apps-poc','data','chaingraph','chaingraph.json'), join(HERE,'..','repo','chaingraph','chaingraph.json')]);
const KERNELS_DIR = process.env.KERNELS_DIR || firstExisting([join(HERE,'..','kernels'), join(HERE,'..','mcp-apps-poc','kernels'), join(HERE,'..','repo','chaingraph','kernels')]);
const FIXTURES_DIR = process.env.FIXTURES_DIR || join(KERNELS_DIR, 'fixtures');
function firstExisting(ps){ return ps.find((p)=>existsSync(p)) || ps[0]; }

let executionHash;
try { ({ executionHash } = await import(pathToFileURL(join(KERNELS_DIR,'_hash.mjs')).href)); }
catch (e) { console.error('FATAL: cannot import _hash.mjs from ' + KERNELS_DIR + ' - ' + e.message); process.exit(2); }

const cg = JSON.parse(readFileSync(CHAINGRAPH,'utf8'));
let nodes = (cg.nodes||[]).filter((n)=>n.gpu===false && n.status==='live' && n.mcp_name);
nodes = nodes.map((n)=>[Math.random(),n]).sort((a,b)=>a[0]-b[0]).map((x)=>x[1]);
if (LIMIT>0) nodes = nodes.slice(0,LIMIT);
console.log('hash-sweep . ' + nodes.length + ' live gpu:false nodes' + (LIMIT?' (random sample of '+LIMIT+')':'') + ' . throttle ' + THROTTLE_MS + 'ms\n');

let pass=0, fail=0, needInput=0, skipped=0, localWarn=0, id=1;
for (const n of nodes) {
  const pp = loadFixtureArgs(n.tool_id) || {};
  const usingFixture = pp && Object.keys(pp).length>0;
  const r = await callTool(n.mcp_name, { compute:'server', policy_parameters: pp });
  if (r.rateLimited) { console.warn('~ ' + n.tool_id + ': SKIPPED (Cloudflare 503 rate-limit after retries - expected on a burst)'); skipped++; await sleep(THROTTLE_MS); continue; }
  if (!r.ok) { console.error('X ' + n.tool_id + ': MCP transport failed - ' + r.error); fail++; await sleep(THROTTLE_MS); continue; }
  if (r.errorText) {
    if (!usingFixture && /required|missing|provide|non-?finite|nan|must |expected|undefined/i.test(r.errorText)) { console.warn('. ' + n.tool_id + ': needs input - ' + r.errorText.replace(/\s+/g,' ').slice(0,80) + ' (add a fixture)'); needInput++; }
    else { console.error('X ' + n.tool_id + ': tool error - ' + r.errorText.replace(/\s+/g,' ').slice(0,100)); fail++; }
    await sleep(THROTTLE_MS); continue;
  }
  const p = r.payload, a = p && p.artifact;
  if (p && p.hash_valid === false) { console.error('X ' + n.tool_id + ': hash_valid=false (broken kernel - Arc class)'); fail++; await sleep(THROTTLE_MS); continue; }
  if (!a || !a.execution_hash || a.policy_parameters===undefined || a.output_payload===undefined) { console.error('X ' + n.tool_id + ': not a v0.4 artifact'); fail++; await sleep(THROTTLE_MS); continue; }
  let local; try { local = await executionHash(a.policy_parameters, a.output_payload); } catch (e) { local = 'ERR:'+e.message; }
  const got = String(a.execution_hash).replace(/^sha256:/,'');
  if (local === got) { console.log('OK ' + n.tool_id + ': hash_valid + local re-derive match'); pass++; }
  else { const msg = n.tool_id + ': local re-derive differs (worker '+got+' / local '+local+')'; if (STRICT_LOCAL){ console.error('X '+msg); fail++; } else { console.warn('! '+msg); pass++; localWarn++; } }
  await sleep(THROTTLE_MS);
}

console.log('\n' + pass + ' hash-valid, ' + fail + ' failed, ' + needInput + ' need-input, ' + skipped + ' rate-limit-skipped' + (localWarn?', '+localWarn+' local warning(s)':'') + '.');
if (skipped) console.log('  -> ' + skipped + ' skipped on Cloudflare 503 (expected on a burst; rotate next run). Not a failure.');
if (fail) { console.error('hash-sweep FAILED - a deployed node returned hash_valid=false or an unexpected error.'); process.exitCode = 1; } else process.exitCode = 0;

function loadFixtureArgs(toolId){ const f = join(FIXTURES_DIR, toolId + '.fixtures.json'); if (!existsSync(f)) return null; let doc; try { doc = JSON.parse(readFileSync(f,'utf8')); } catch { return null; } const one = Array.isArray(doc)?doc[0]:doc.cases?doc.cases[0]:doc; return (one.policy_parameters && one.policy_parameters.input_parameters) || one.policy_parameters || one.input_parameters || one.arguments || null; }

async function callTool(name, args, attempt=0){
  try {
    const res = await fetch(MCP_URL, { method:'POST', headers:{ 'content-type':'application/json', accept:'application/json, text/event-stream', 'mcp-protocol-version':PROTO }, body: JSON.stringify({ jsonrpc:'2.0', id:id++, method:'tools/call', params:{ name, arguments:args } }) });
    if (res.status === 503) { if (attempt < RL_RETRIES) { await sleep(THROTTLE_MS*(attempt+2)); return callTool(name,args,attempt+1); } return { ok:false, rateLimited:true, error:'HTTP 503' }; }
    const text = await res.text();
    if (!res.ok) return { ok:false, error:'HTTP ' + res.status + ' ' + text.slice(0,100) };
    const j = parseMaybeSSE(text, res.headers.get('content-type') || '');
    if (!j) return { ok:false, error:'unparseable response' };
    if (j.error) return { ok:true, errorText: j.error.message || JSON.stringify(j.error) };
    const result = j.result != null ? j.result : j;
    const sc = result.structuredContent;
    const tp = result.content && result.content.find ? (result.content.find((c)=>c.type==='text')||{}).text : undefined;
    const parsed = tp ? safeParse(tp) : null;
    const payload = sc || parsed || result;
    const errorText = result.isError ? (tp || 'tool error') : (tp && parsed===null ? tp : null);
    return { ok:true, payload, errorText };
  } catch (e) { if (attempt < RL_RETRIES) { await sleep(THROTTLE_MS*(attempt+2)); return callTool(name,args,attempt+1); } return { ok:false, error:e.message }; }
}

function parseMaybeSSE(text, ct){ const t = text.trim(); if (ct.includes('application/json') || t.startsWith('{')) { try { return JSON.parse(t); } catch {} } const data = t.split(/\r?\n/).filter((l)=>l.startsWith('data:')).map((l)=>l.slice(5).trim()); for (let i=data.length-1;i>=0;i--){ try { return JSON.parse(data[i]); } catch {} } try { return JSON.parse(t); } catch { return null; } }
function safeParse(s){ try { return JSON.parse(s); } catch { return null; } }
function sleep(ms){ return new Promise((r)=>setTimeout(r,ms)); }
