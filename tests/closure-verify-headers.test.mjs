#!/usr/bin/env node
// closure-verify-headers.test.mjs — MCP-CLOSURE-VERIFY-HEADERS-1.
// verifyClosureViaAnchor must reach anchor-suite through callAnchorSuiteTool so the modern-era
// request carries Mcp-Method/Mcp-Name headers and params-level _meta. fetch is mocked; no live call.
//
// Usage: node tests/closure-verify-headers.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { __test_verifyClosureViaAnchor as verify } from '../worker.mjs';

const REC = { record_hash: 'sha256:abc', opened_at: '2026-01-01T00:00:00Z', halted_steps: [1], mandate_hash: 'sha256:m' };
const CLOSURE = { decision: 'approve', envelope: { x: 1 } };

async function withFetch(impl, fn) {
  const real = globalThis.fetch, calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return impl(url, init); };
  try { await fn(calls); } finally { globalThis.fetch = real; }
}
const ok = (obj) => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify(obj) }] } }), { status: 200 });

test('request carries Mcp-Method/Mcp-Name and params-level _meta', async () => {
  await withFetch(() => ok({ valid: true }), async (calls) => {
    await verify(REC, CLOSURE);
    assert.equal(calls.length, 1);
    const { headers, body } = calls[0].init;
    assert.equal(headers['Mcp-Method'], 'tools/call');
    assert.equal(headers['Mcp-Name'], 'verify_escalation_closure');
    assert.equal(headers['MCP-Protocol-Version'], '2026-07-28');
    const b = JSON.parse(body);
    assert.ok(b.params._meta['io.modelcontextprotocol/protocolVersion']);
    assert.equal('_meta' in b, false);
    assert.equal(b.params.name, 'verify_escalation_closure');
    assert.equal(b.params.arguments.closure.record_hash, 'sha256:abc');
    assert.equal('record_hash' in b.params.arguments.escalation_record, false);
    assert.equal('opened_at' in b.params.arguments.escalation_record, false);
  });
});

test('success reply maps to the verdict verbatim', async () => {
  await withFetch(() => ok({ valid: true, approver_decision: 'approve' }), async () => {
    assert.deepEqual(await verify(REC, CLOSURE), { valid: true, approver_decision: 'approve' });
  });
});

test('HTTP 400 JSON-RPC error maps to valid:false', async () => {
  const err = new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32020, message: 'Mcp-Method header is missing' } }), { status: 400 });
  await withFetch(() => err, async () => {
    const v = await verify(REC, CLOSURE);
    assert.equal(v.valid, false);
    assert.equal(v.reason, 'closure_verifier_error');
  });
});

test('garbage reply and thrown fetch map to valid:false', async () => {
  await withFetch(() => new Response('<html>nope</html>', { status: 502 }), async () => {
    const v = await verify(REC, CLOSURE);
    assert.equal(v.valid, false);
  });
  await withFetch(() => { throw new Error('boom'); }, async () => {
    const v = await verify(REC, CLOSURE);
    assert.equal(v.valid, false);
    assert.equal(v.reason, 'closure_verifier_unreachable');
  });
});
