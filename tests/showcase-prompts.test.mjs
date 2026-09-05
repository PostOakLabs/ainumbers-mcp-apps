#!/usr/bin/env node
// showcase-prompts.test.mjs — MCP-SHOWCASE-PROMPTS-1 done-criteria.
//
// Drives the REAL buildServer via InMemoryTransport (same harness as tests/build-evidence-pack.test.mjs).
// Asserts, for EVERY prompt in data/mcp/showcase-prompts.json:
//   - prompts/list carries an entry named after the SSOT id (exactly 5 new entries).
//   - prompts/get for each id returns a first message whose text contains the SSOT `body` VERBATIM.
//   - the message's remaining content blocks are resource_link blocks for the verify_surface URLs.
//   - prompts/get for each id is registered with its SSOT-declared arguments (list entry title matches).
//
// Usage: node tests/showcase-prompts.test.mjs   (also runs under `node --test`)

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer, widgetGlue, stripCspMeta } from '../worker.mjs';
import { PILOT } from '../pilot.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = resolve(ROOT, 'data');

function loadDataFromDisk() {
  const get = (p) => readFileSync(resolve(DATA, p), 'utf8');
  const glue = widgetGlue(get('ext-apps-inline.js'));
  const manifests = {}, widgets = {};
  for (const slug of PILOT) {
    manifests[slug] = JSON.parse(get('manifests/' + slug + '.manifest.json'));
    widgets[slug] = stripCspMeta(get('tools/' + slug + '.html')) + glue;
  }
  let recipes = null, showcasePrompts = null;
  try { recipes = JSON.parse(get('mcp/recipes.json')); } catch { /* degrade */ }
  try { showcasePrompts = JSON.parse(get('mcp/showcase-prompts.json')); } catch { /* degrade */ }
  return {
    manifests, widgets,
    catalog: JSON.parse(get('mcp/catalog.json')),
    chaingraph: JSON.parse(get('chaingraph/chaingraph.json')),
    searchIndex: JSON.parse(get('search-index.json')),
    chainFixtures: JSON.parse(get('chain-fixtures.json')),
    recipes,
    showcasePrompts,
  };
}

let failed = 0;
function check(name, cond, detail = '') {
  console.log((cond ? '  ok  ' : '  ✗ FAIL ') + name + (cond || !detail ? '' : ' — ' + detail));
  if (!cond) failed++;
}

async function withServer(data, fn) {
  const server = buildServer(data);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  await clientT.start();
  const pending = new Map();
  clientT.onmessage = (msg) => {
    if (msg && msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  };
  let nextId = 2;
  const rpc = (method, params) => new Promise((res) => {
    const id = nextId++;
    pending.set(id, res);
    clientT.send({ jsonrpc: '2.0', id, method, params });
  });
  try { await fn(rpc); } finally { await clientT.close().catch(() => {}); }
}

async function main() {
  const data = loadDataFromDisk();
  const ssot = data.showcasePrompts;
  if (!ssot || !(ssot.prompts ?? []).length) {
    console.error('✗ data/mcp/showcase-prompts.json missing/empty — run node generate.mjs first.');
    process.exit(1);
  }
  const items = ssot.prompts;
  check('SSOT projection carries exactly 5 showcase prompts', items.length === 5, String(items.length));

  await withServer(data, async (rpc) => {
    const listMsg = await rpc('prompts/list', {});
    const prompts = listMsg.result?.prompts ?? [];
    for (const p of items) {
      const entry = prompts.find((e) => e.name === p.id);
      check(`prompts/list carries "${p.id}"`, !!entry, 'absent from prompts/list');
      if (!entry) continue;
      check(`"${p.id}" title matches SSOT`, entry.title === p.title, entry.title);

      const args = {};
      for (const a of (p.arguments ?? [])) if (a.required) args[a.name] = 'test-' + a.name;
      const getMsg = await rpc('prompts/get', { name: p.id, arguments: args });
      const msgs = getMsg.result?.messages ?? [];
      check(`prompts/get "${p.id}" returns one user message`, msgs.length === 1 && msgs[0].role === 'user', JSON.stringify(msgs).slice(0, 120));
      const content = msgs[0]?.content;
      const blocks = Array.isArray(content) ? content : [content];
      const textBlock = blocks.find((b) => b.type === 'text');
      check(`prompts/get "${p.id}" message contains body VERBATIM`, !!textBlock && textBlock.text.includes(p.body),
        textBlock ? 'body text not found verbatim' : 'no text block');
      const links = blocks.filter((b) => b.type === 'resource_link').map((b) => b.uri);
      const expected = p.verify_surface ?? [];
      check(`"${p.id}" resource_link blocks match verify_surface`, expected.every((u) => links.includes(u)),
        'links=' + JSON.stringify(links));
    }
    // Delta discipline: exactly the 5 SSOT ids beyond the pre-existing prompt set.
    const showcaseEntries = prompts.filter((e) => items.some((p) => p.id === e.name));
    check('prompts/list grew by exactly the 5 showcase ids', showcaseEntries.length === 5, String(showcaseEntries.length));
  });

  if (failed) {
    console.error(`\n✗ ${failed} assertion(s) FAILED`);
    process.exit(1);
  }
  console.log('\n✅ all assertions passed — five showcase prompts served with verbatim bodies + verify-surface resource links');
}

main().catch((err) => {
  console.error('✗ showcase-prompts test ERROR:', err);
  process.exit(1);
});
