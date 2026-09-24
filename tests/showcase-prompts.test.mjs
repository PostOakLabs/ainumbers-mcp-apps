#!/usr/bin/env node
// showcase-prompts.test.mjs — PROMPTS-GET-SPEC-FIX-1 done-criteria.
//
// Drives the REAL buildServer via InMemoryTransport (same harness as tests/build-evidence-pack.test.mjs)
// and asserts, for EVERY prompt `prompts/list` advertises (showcase + recipe + flagship):
//   - the prompts/get result passes the official SDK's GetPromptResultSchema.safeParse
//     (the SDK already in node_modules — no new dependency). This is the exact validation
//     every official-SDK client performs; the live defect this gate pins: ONE message whose
//     `content` was an ARRAY ([text, resource_link × N]) parsed FALSE and made every such
//     showcase prompt unfetchable by SDK clients (MCP 2025-06-18: PromptMessage.content is
//     ONE content block).
//   - every returned message carries EXACTLY ONE content block (content is a block OBJECT,
//     never an array — the array-tolerant branch this test used to carry is deliberately
//     DELETED so the illegal shape can never pass again).
//   - showcase prompts: message 0's text is the SSOT `body` VERBATIM plus, when verify_surface
//     is non-empty, the "\n\nVerify at:\n" + "- <url>" appendix (the spec-legal replacement
//     for the old resource_link array), and prompts/list carries every SSOT id + title.
//
// Usage: node tests/showcase-prompts.test.mjs   (also runs under `node --test`)

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { GetPromptResultSchema } from '@modelcontextprotocol/sdk/types.js';
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

// The spec-legal showcase message-0 text (PROMPTS-GET-SPEC-FIX-1 step 1): the SSOT body
// verbatim, then — only when verify_surface is non-empty — the "Verify at:" appendix, one
// "- <url>" line per URL. W1 may append further text AFTER this contract still holds.
function expectedShowcaseText(p) {
  const vs = p.verify_surface ?? [];
  return vs.length ? p.body + '\n\nVerify at:\n' + vs.map((u) => '- ' + u).join('\n') : p.body;
}

let failed = 0;
function fail(name, detail = '') {
  console.log('  ✗ FAIL ' + name + (detail ? ' — ' + detail : ''));
  failed++;
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
  const byId = new Map(items.map((p) => [p.id, p]));
  // EXAMPLE-PROMPTS-JSON-1: count follows the SSOT (site gate ratchets it down-only).
  if (items.length < 1) fail('SSOT projection is a non-empty showcase prompt set', String(items.length));

  await withServer(data, async (rpc) => {
    const listMsg = await rpc('prompts/list', {});
    const prompts = listMsg.result?.prompts ?? [];
    if (!prompts.length) fail('prompts/list is non-empty');
    // Delta discipline: prompts/list carries every SSOT id, and titles match.
    for (const p of items) {
      const entry = prompts.find((e) => e.name === p.id);
      if (!entry) { fail(`prompts/list carries "${p.id}"`, 'absent from prompts/list'); continue; }
      if (entry.title !== p.title) fail(`"${p.id}" title matches SSOT`, entry.title);
    }

    // Every advertised prompt (all of them, not only showcase) must be fetchable AND
    // GetPromptResultSchema-valid with exactly one content block per message.
    let valid = 0;
    for (const entry of prompts) {
      const ssotPrompt = byId.get(entry.name);
      const declared = entry.arguments ?? ssotPrompt?.arguments ?? [];
      const args = {};
      for (const a of declared) if (a.required) args[a.name] = 'test-' + a.name;
      const getMsg = await rpc('prompts/get', { name: entry.name, arguments: args });
      if (getMsg.error) {
        fail(`prompts/get "${entry.name}"`, `JSON-RPC ${getMsg.error.code}: ${getMsg.error.message}`);
        continue;
      }
      const result = getMsg.result;
      const parsed = GetPromptResultSchema.safeParse(result);
      if (!parsed.success) {
        const issues = (parsed.error?.issues ?? []).slice(0, 3)
          .map((i) => (i.path ?? []).join('.') + ': ' + i.message).join(' | ');
        fail(`prompts/get "${entry.name}" is GetPromptResultSchema-valid`, issues);
        continue; // the per-message checks below are consequences of the schema failure
      }
      // Exactly ONE content block per message: content is a single block object, never an array.
      const msgs = parsed.data.messages ?? [];
      const arrayContent = msgs.filter((m) => Array.isArray(m.content)).length;
      const noContent = msgs.filter((m) => !m.content || typeof m.content !== 'object').length;
      if (arrayContent || noContent) {
        fail(`prompts/get "${entry.name}" carries exactly one content block per message`,
          arrayContent ? `${arrayContent} message(s) with array content` : `${noContent} message(s) without a content block`);
        continue;
      }
      let promptOk = true;
      if (ssotPrompt) {
        const m0 = msgs[0];
        const expected = expectedShowcaseText(ssotPrompt);
        if (msgs.length !== 1 || m0?.role !== 'user') {
          fail(`prompts/get "${entry.name}" returns one user message`, `msgs=${msgs.length}, role=${m0?.role}`);
          promptOk = false;
        } else if (m0.content?.type !== 'text' || m0.content?.text !== expected) {
          fail(`prompts/get "${entry.name}" message 0 is the SSOT body verbatim (+ Verify at: appendix)`,
            m0.content?.type !== 'text' ? 'message 0 is not a text block'
              : `text diverges from body+appendix (len ${m0.content?.text} vs ${expected.length})`);
          promptOk = false;
        }
      }
      if (promptOk) valid++;
    }
    console.log(`  · ${valid}/${prompts.length} prompts SDK-valid (schema + one content block per message)`);
    if (valid !== prompts.length) fail('prompt validity tally', `${valid}/${prompts.length}`);
  });

  if (failed) {
    console.error(`\n✗ ${failed} assertion(s) FAILED`);
    process.exit(1);
  }
  console.log(`\n✅ ${items.length} showcase + full prompts/list set: every prompts/get result is GetPromptResultSchema-valid, one content block per message, showcase bodies verbatim (+ Verify at: appendix)`);
}

main().catch((err) => {
  console.error('✗ showcase-prompts test ERROR:', err);
  process.exit(1);
});
