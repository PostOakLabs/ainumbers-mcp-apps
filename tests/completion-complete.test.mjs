#!/usr/bin/env node
// completion-complete.test.mjs — PROMPTS-WORKER-CONTEXT-1 P3 done-criteria.
//
// The live endpoint answered -32601 to every completion/complete call, so a host that offers
// argument completion (VS Code Copilot does today) had nothing to offer. This test pins the
// replacement on BOTH paths that can answer it:
//
//   Leg A — the HTTP worker fast path: the real worker.mjs default export against an ASSETS stub
//           backed by the committed ./data (same harness as scripts/test-mcp-pagination-keyset.mjs).
//           This is the path a live client hits, and the one that must answer WITHOUT a buildServer
//           spin-up.
//   Leg B — the SDK-registered completer (completable prompt arguments + the tool:// template
//           callback) over InMemoryTransport, which is what a direct-transport host sees and what
//           makes the server advertise capabilities.completions.
//
// Expectations are recomputed from data/mcp/completion-index.json — the SOURCE — never read back
// from the surface under test.
//
// Usage: node tests/completion-complete.test.mjs   (also runs under `node --test`)

import { readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import worker, { buildServer, widgetGlue, stripCspMeta } from '../worker.mjs';
import { PILOT } from '../pilot.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = resolve(ROOT, 'data');

let passed = 0;
const fails = [];
function check(name, ok, detail) {
  if (ok) { passed++; console.log('  ok ' + name); }
  else { fails.push(name + (detail ? ' — ' + detail : '')); console.error('  FAIL ' + name + (detail ? ' — ' + detail : '')); }
}

const index = JSON.parse(readFileSync(resolve(DATA, 'mcp', 'completion-index.json'), 'utf8'));
const CAP = 100; // MCP 2025-06-18: completion/complete returns at most 100 values

// ── ASSETS stub over the committed data/ dir ─────────────────────────────────────────────────
function makeEnv() {
  const assetsFetch = (url) => {
    const u = new URL(typeof url === 'string' ? url : url.url);
    const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '');
    try { return new Response(readFileSync(join(DATA, rel)), { status: 200 }); }
    catch { return new Response('Not Found', { status: 404 }); }
  };
  return { ASSETS: { fetch: assetsFetch } };
}
const CTX = { waitUntil: () => {}, passThroughOnException: () => {} };
let nextId = 1;
async function complete(env, params) {
  const req = new Request('https://mcp.ainumbers.co/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'mcp-protocol-version': '2025-06-18' },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method: 'completion/complete', params }),
  });
  const res = await worker.fetch(req, env, CTX);
  const text = await res.text();
  // The worker frames results as SSE when the client accepts it; JSON-only Accept yields the bare
  // body. Parse whichever arrived.
  const payload = text.startsWith('event:') ? text.slice(text.indexOf('data: ') + 6).trim() : text;
  let json = null;
  try { json = JSON.parse(payload); } catch { /* asserted by the caller */ }
  return { status: res.status, text, json };
}

// Pick real subjects out of the index instead of hard-coding ids that a future SSOT edit renames.
function firstPromptArgWithDomain(domain) {
  for (const [promptId, args] of Object.entries(index.prompt_args ?? {})) {
    for (const [argName, d] of Object.entries(args)) if (d === domain) return { promptId, argName };
  }
  return null;
}
function firstPromptWithFreeTextArg() {
  const showcase = JSON.parse(readFileSync(resolve(DATA, 'mcp', 'showcase-prompts.json'), 'utf8')).prompts ?? [];
  for (const p of showcase) {
    for (const a of (p.arguments ?? [])) {
      if (!index.prompt_args?.[p.id]?.[a.name]) return { promptId: p.id, argName: a.name };
    }
  }
  return null;
}

async function legA() {
  console.log('\nLeg A — HTTP worker fast path (real worker.mjs + ASSETS stub over data/)');
  const env = makeEnv();

  // (1) -32601 IS GONE. The pre-row behaviour: every completion/complete answered "Method not
  //     found" from the unknown-method short-circuit.
  const nodePageArg = firstPromptArgWithDomain('node_page');
  check('index maps at least one prompt argument to the node_page domain', Boolean(nodePageArg),
    JSON.stringify(index.prompt_args ?? {}).slice(0, 120));
  if (!nodePageArg) return;
  const bare = await complete(env, {
    ref: { type: 'ref/prompt', name: nodePageArg.promptId },
    argument: { name: nodePageArg.argName, value: '' },
  });
  check('completion/complete is no longer -32601', bare.json?.error?.code !== -32601,
    JSON.stringify(bare.json?.error ?? {}));
  check('completion/complete returns a CompleteResult', Array.isArray(bare.json?.result?.completion?.values),
    JSON.stringify(bare.json ?? bare.text).slice(0, 200));

  // (2) Cap + total/hasMore, recomputed from the index.
  const allPages = index.domains?.node_page ?? [];
  check('unprefixed node_page completion reports the true total',
    bare.json?.result?.completion?.total === allPages.length,
    `total=${bare.json?.result?.completion?.total} vs index ${allPages.length}`);
  check('unprefixed node_page completion is capped at 100 values with hasMore set accordingly',
    bare.json?.result?.completion?.values?.length === Math.min(CAP, allPages.length)
      && bare.json?.result?.completion?.hasMore === (allPages.length > CAP),
    `values=${bare.json?.result?.completion?.values?.length}, hasMore=${bare.json?.result?.completion?.hasMore}`);

  // (3) PREFIX MATCH. Take a prefix off a real page URL and recompute the expected match set.
  const sample = allPages[0] ?? '';
  const prefix = sample.slice(0, Math.min(sample.length, 45));
  const expected = allPages.filter((u) => u.startsWith(prefix));
  const pref = await complete(env, {
    ref: { type: 'ref/prompt', name: nodePageArg.promptId },
    argument: { name: nodePageArg.argName, value: prefix },
  });
  const prefValues = pref.json?.result?.completion?.values ?? [];
  check('prefix match returns exactly the index entries with that prefix',
    pref.json?.result?.completion?.total === expected.length
      && prefValues.every((v) => v.startsWith(prefix)),
    `total=${pref.json?.result?.completion?.total} vs ${expected.length}`);
  check('prefix match is NARROWER than the unprefixed set (the prefix did something)',
    expected.length < allPages.length || allPages.length <= 1,
    `${expected.length} vs ${allPages.length}`);

  // (4) chain_id NARROWING via context.arguments.
  const chainEntry = Object.entries(index.node_page_by_chain ?? {})[0];
  check('index carries at least one chain → node-page narrowing', Boolean(chainEntry));
  if (chainEntry) {
    const [chainId, idxs] = chainEntry;
    const expectedNarrow = idxs.map((i) => allPages[i]).filter(Boolean);
    const narrowed = await complete(env, {
      ref: { type: 'ref/prompt', name: nodePageArg.promptId },
      argument: { name: nodePageArg.argName, value: '' },
      context: { arguments: { chain_id: chainId } },
    });
    const got = narrowed.json?.result?.completion?.values ?? [];
    check(`context.arguments.chain_id="${chainId}" narrows node_page to that chain's pages`,
      narrowed.json?.result?.completion?.total === expectedNarrow.length
        && got.length === Math.min(CAP, expectedNarrow.length)
        && got.every((u) => expectedNarrow.includes(u)),
      `total=${narrowed.json?.result?.completion?.total} vs ${expectedNarrow.length}`);
    check('the narrowed set is strictly smaller than the whole estate',
      expectedNarrow.length < allPages.length, `${expectedNarrow.length} vs ${allPages.length}`);
    // An UNKNOWN chain narrows to nothing rather than falling back to the full estate.
    const unknown = await complete(env, {
      ref: { type: 'ref/prompt', name: nodePageArg.promptId },
      argument: { name: nodePageArg.argName, value: '' },
      context: { arguments: { chain_id: 'no-such-chain-xyz' } },
    });
    check('an unknown chain_id narrows to an EMPTY set (never a silent full-estate fallback)',
      unknown.json?.result?.completion?.values?.length === 0 && unknown.json?.result?.completion?.total === 0,
      JSON.stringify(unknown.json?.result?.completion ?? {}).slice(0, 120));
  }

  // (5) NO DERIVABLE DOMAIN → { values: [] }. Never an invented value set, never an error.
  const freeText = firstPromptWithFreeTextArg();
  check('showcase set has at least one free-text (non-derivable) argument', Boolean(freeText));
  if (freeText) {
    const empty = await complete(env, {
      ref: { type: 'ref/prompt', name: freeText.promptId },
      argument: { name: freeText.argName, value: 'h' },
    });
    check(`free-text argument "${freeText.argName}" completes to values: []`,
      Array.isArray(empty.json?.result?.completion?.values)
        && empty.json.result.completion.values.length === 0
        && empty.json.result.completion.total === 0
        && empty.json.result.completion.hasMore === false,
      JSON.stringify(empty.json?.result?.completion ?? empty.json?.error ?? {}).slice(0, 160));
  }

  // (6) An unknown prompt name is an empty completion, not a crash.
  const unknownPrompt = await complete(env, {
    ref: { type: 'ref/prompt', name: 'definitely-not-a-prompt-xyz' },
    argument: { name: 'node_page', value: '' },
  });
  check('unknown prompt ref → empty completion, no error',
    unknownPrompt.json?.result?.completion?.values?.length === 0 && !unknownPrompt.json?.error,
    JSON.stringify(unknownPrompt.json ?? {}).slice(0, 160));

  // (7) ref/resource tool://{mcp_name} completes from the served tool names.
  const toolNames = index.domains?.tool_name ?? [];
  const tPrefix = (toolNames[0] ?? '').slice(0, 5);
  const expectedTools = toolNames.filter((n) => n.startsWith(tPrefix));
  const resComp = await complete(env, {
    ref: { type: 'ref/resource', uri: 'tool://{mcp_name}' },
    argument: { name: 'mcp_name', value: tPrefix },
  });
  check('ref/resource tool://{mcp_name} completes tool names by prefix',
    resComp.json?.result?.completion?.total === expectedTools.length
      && (resComp.json?.result?.completion?.values ?? []).every((n) => n.startsWith(tPrefix)),
    `total=${resComp.json?.result?.completion?.total} vs ${expectedTools.length}`);
}

// ── Leg B: the SDK-registered completer over an in-memory transport ──────────────────────────
function loadDataFromDisk() {
  const get = (p) => readFileSync(resolve(DATA, p), 'utf8');
  const glue = widgetGlue(get('ext-apps-inline.js'));
  const manifests = {}, widgets = {};
  for (const slug of PILOT) {
    manifests[slug] = JSON.parse(get('manifests/' + slug + '.manifest.json'));
    widgets[slug] = stripCspMeta(get('tools/' + slug + '.html')) + glue;
  }
  const tolerant = (p) => { try { return JSON.parse(get(p)); } catch { return null; } };
  return {
    manifests, widgets,
    catalog: JSON.parse(get('mcp/catalog.json')),
    chaingraph: JSON.parse(get('chaingraph/chaingraph.json')),
    searchIndex: JSON.parse(get('search-index.json')),
    chainFixtures: tolerant('chain-fixtures.json'),
    recipes: tolerant('mcp/recipes.json'),
    showcasePrompts: tolerant('mcp/showcase-prompts.json'),
    promptContext: tolerant('mcp/prompt-context.json'),
    completionIndex: tolerant('mcp/completion-index.json'),
    lifecycle: tolerant('mcp/lifecycle.json') ?? { default: 'Active', overrides: {} },
  };
}

async function legB() {
  console.log('\nLeg B — SDK-registered completer (InMemoryTransport)');
  const server = buildServer(loadDataFromDisk());
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  await clientT.start();
  const pending = new Map();
  clientT.onmessage = (msg) => {
    if (msg && msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  };
  let id = 0;
  const rpc = (method, params) => new Promise((res) => {
    const mid = id++;
    pending.set(mid, res);
    clientT.send({ jsonrpc: '2.0', id: mid, method, params });
  });
  try {
    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'completion-test', version: '1' } });
    await clientT.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    check('the built server advertises capabilities.completions',
      Boolean(init.result?.capabilities?.completions), JSON.stringify(init.result?.capabilities ?? {}));

    const nodePageArg = firstPromptArgWithDomain('node_page');
    if (nodePageArg) {
      const pages = index.domains?.node_page ?? [];
      const prefix = (pages[0] ?? '').slice(0, 45);
      const expected = pages.filter((u) => u.startsWith(prefix));
      const msg = await rpc('completion/complete', {
        ref: { type: 'ref/prompt', name: nodePageArg.promptId },
        argument: { name: nodePageArg.argName, value: prefix },
      });
      const values = msg.result?.completion?.values ?? [];
      check('SDK path: prompt-argument completion prefix-matches the same index',
        msg.error?.code !== -32601 && values.length === Math.min(CAP, expected.length)
          && values.every((v) => v.startsWith(prefix)),
        JSON.stringify(msg.error ?? { got: values.length, want: Math.min(CAP, expected.length) }));
    }
    const toolNames = index.domains?.tool_name ?? [];
    const tPrefix = (toolNames[0] ?? '').slice(0, 5);
    const expectedTools = toolNames.filter((n) => n.startsWith(tPrefix));
    const resMsg = await rpc('completion/complete', {
      ref: { type: 'ref/resource', uri: 'tool://{mcp_name}' },
      argument: { name: 'mcp_name', value: tPrefix },
    });
    check('SDK path: tool:// template completion prefix-matches the served tool names',
      (resMsg.result?.completion?.values ?? []).length === Math.min(CAP, expectedTools.length),
      JSON.stringify(resMsg.error ?? { got: (resMsg.result?.completion?.values ?? []).length, want: Math.min(CAP, expectedTools.length) }));
  } finally {
    await clientT.close().catch(() => {});
  }

  // The generated artifact a live client actually reads must carry the capability too — the card
  // and initialize both serve these bytes.
  const staticInit = JSON.parse(readFileSync(resolve(DATA, 'mcp', 'static', 'initialize.json'), 'utf8'));
  check('data/mcp/static/initialize.json advertises capabilities.completions',
    Boolean(staticInit.capabilities?.completions), JSON.stringify(staticInit.capabilities ?? {}));
}

await legA();
await legB();

console.log('');
if (fails.length) {
  console.error(`✗ completion/complete: ${fails.length} assertion(s) FAILED (${passed} passed)`);
  for (const f of fails) console.error('  · ' + f);
  process.exit(1);
}
console.log(`✅ completion/complete: ${passed} assertion(s) passed (fast path + SDK completer, prefix match, chain_id narrowing, empty domain, no -32601)`);
