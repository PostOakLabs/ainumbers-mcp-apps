// verify-wave11.mjs — confirm the Wave-11 tools (+ export_artifact) are live in tools/list.
//   node scripts/verify-wave11.mjs [url]
// Stateless streamable-HTTP: stream each response, resolve on the matching id, hard timeout.

const URL = process.argv[2] || process.env.MCP_SMOKE_URL || 'https://mcp.ainumbers.co/mcp';
const PROTO = '2025-06-18', ACCEPT = 'application/json, text/event-stream', TIMEOUT = 15000;
const WANT = [
  'run_treasury_clearing_fit', 'model_clearing_access_economics',
  'estimate_ficc_margin_netting', 'estimate_cross_margin_benefit', 'export_artifact',
];

async function call(method, params, id) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(new Error('timeout')), TIMEOUT);
  const res = await fetch(URL, { method: 'POST', signal: ctl.signal,
    headers: { 'content-type': 'application/json', accept: ACCEPT, 'mcp-protocol-version': PROTO },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) }).catch((e) => { clearTimeout(t); throw new Error(`fetch ${method}: ${e.message}`); });
  if (res.status !== 200) { clearTimeout(t); throw new Error(`HTTP ${res.status} on ${method}`); }
  const find = (buf) => { const w = buf.trim(); if (w.startsWith('{')) { try { const o = JSON.parse(w); if (o.id === id) return o; } catch {} } for (const l of buf.split('\n')) if (l.startsWith('data:')) { try { const o = JSON.parse(l.slice(5).trim()); if (o.id === id) return o; } catch {} } return null; };
  const r = res.body.getReader(), dec = new TextDecoder(); let buf = '';
  try { for (;;) { const { value, done } = await r.read(); if (value) buf += dec.decode(value, { stream: true }); const h = find(buf); if (h) { ctl.abort(); clearTimeout(t); return h.result; } if (done) break; } } catch { const h = find(buf); if (h) { clearTimeout(t); return h.result; } }
  clearTimeout(t); throw new Error(`no response for ${method}`);
}

(async () => {
  await call('initialize', { protocolVersion: PROTO, capabilities: {}, clientInfo: { name: 'verify', version: '1' } }, 1);
  const list = await call('tools/list', {}, 2);
  const names = new Set((list?.tools ?? []).map((t) => t.name));
  console.log(`Live tools: ${names.size}\n`);
  let missing = 0;
  for (const w of WANT) { const ok = names.has(w); if (!ok) missing++; console.log(`  ${ok ? '✓' : '✗ MISSING'}  ${w}`); }
  console.log(missing ? `\n✗ ${missing} expected tool(s) missing — deploy incomplete.` : '\n✓ All Wave-11 tools + export_artifact are live.');
  process.exit(missing ? 1 : 0);
})().catch((e) => { console.error('verify failed:', e.message); process.exit(1); });
