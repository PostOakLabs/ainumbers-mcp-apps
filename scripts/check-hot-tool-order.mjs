// MCP-REACH-DISPATCH-1 D2 gate — the 13 hot tools MUST occupy page-1 positions 1-13 of the served
// tools/list, `initialize` MUST carry instructions within the 600-char bound, and the DEFAULT list
// MUST carry no `defaultConfig.defer_loading` (D4).
//
// WHY A GATE AND NOT A COMMENT: before this row the hot set sat at page-1 positions 17-34 purely by
// registration order, and the only thing guarding any of it was one `names.includes('find_tool')`
// assertion in the post-deploy smoke (scripts/smoke-mcp.mjs). tools/list is 13 pages / 724 tools and
// six measured hosts read ONLY page 1, so a tool that drifts off the head of page 1 is a tool those
// hosts cannot see — and `call_tool` drifting off the head takes every OTHER page with it. Any edit
// that reorders registrations, adds a hot tool, or re-lands the defer_loading injection reds here.
//
// SO #34 (independent derivation): the EXPECTED head is recomputed from worker.mjs's own HOT_TOOLS
// export — the source of truth the runtime path uses — and compared against the PRECOMPUTED SERVE
// BYTES (data/mcp/static/*), which are the artifact under test. The gate never reads the head out of
// the artifact it is validating, and never asks the artifact what its own hot set is.
//
// SO #34's security rider: no `require`/`eval`/dynamic import of anything under data/. The static
// tools-list is parsed out of its SSE frame with JSON.parse on a text slice, exactly as a client
// would; nothing in data/ is ever executed.
//
// Run: node scripts/check-hot-tool-order.mjs   (wired into scripts/preflight.mjs + CI)

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOT_TOOLS, CALL_TOOL_NAME } from '../worker.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STATIC = resolve(ROOT, 'data', 'mcp', 'static');
const INSTRUCTIONS_MAX = 600;

const fail = [];
const note = [];

// ── the served default tools/list, read as a client reads it ────────────────────────────────────
const sse = readFileSync(resolve(STATIC, 'tools-list.sse.txt'), 'utf8');
const dataLine = sse.split('\n').find((l) => l.startsWith('data: '));
if (!dataLine) {
  console.error('check-hot-tool-order: FAIL — data/mcp/static/tools-list.sse.txt carries no SSE data line');
  process.exit(1);
}
// The frame holds `"id":__OCG_ID__`, which is not valid JSON until the worker splices a real id in.
const envelope = JSON.parse(dataLine.slice(6).replace('__OCG_ID__', 'null'));
const tools = envelope?.result?.tools;
if (!Array.isArray(tools) || tools.length === 0) {
  console.error('check-hot-tool-order: FAIL — served tools/list carries no tools array');
  process.exit(1);
}

// ── (1) hot tools at positions 1-13 ─────────────────────────────────────────────────────────────
// EXPECTED is derived from worker.mjs, never from the file under test.
const expected = [...HOT_TOOLS];
const window = expected.length;            // 13 today; the rule is "the head is exactly the hot set"
const head = tools.slice(0, window).map((t) => t.name);
for (const name of expected) {
  const idx = tools.findIndex((t) => t.name === name);
  if (idx < 0) fail.push('hot tool "' + name + '" is not in the served tools/list at all');
  else if (idx >= window) fail.push('hot tool "' + name + '" is at page-1 position ' + (idx + 1) + ', outside the 1-' + window + ' window');
}
const strays = head.filter((n) => !HOT_TOOLS.has(n));
if (strays.length) fail.push('positions 1-' + window + ' carry ' + strays.length + ' non-hot tool(s): ' + strays.join(', '));
if (!HOT_TOOLS.has(CALL_TOOL_NAME)) fail.push(CALL_TOOL_NAME + ' is not in HOT_TOOLS — the dispatcher MUST be listed on page 1 or pages 2+ are unreachable');

// ── (2) initialize.instructions present and bounded ─────────────────────────────────────────────
const init = JSON.parse(readFileSync(resolve(STATIC, 'initialize.json'), 'utf8'));
if (typeof init.instructions !== 'string' || init.instructions.length === 0) {
  fail.push('initialize.json carries no `instructions` string (MCP-REACH-DISPATCH-1 D2)');
} else if (init.instructions.length > INSTRUCTIONS_MAX) {
  fail.push('initialize.instructions is ' + init.instructions.length + ' chars, over the ' + INSTRUCTIONS_MAX + '-char bound');
} else {
  note.push('initialize.instructions: ' + init.instructions.length + '/' + INSTRUCTIONS_MAX + ' chars');
  if (!init.instructions.includes(CALL_TOOL_NAME)) fail.push('initialize.instructions never names ' + CALL_TOOL_NAME + ' — a page-1-only host is told nothing about the route to pages 2+');
}

// ── (3) no defer_loading on the DEFAULT list (D4) ───────────────────────────────────────────────
// The five named-toolset profile files (tools-list.<profile>.sse.txt) are deliberately NOT checked:
// they still carry defaultConfig by design and spec §T rules on their fate.
const deferred = tools.filter((t) => t?.defaultConfig?.defer_loading !== undefined).length;
if (deferred > 0) fail.push(deferred + ' default-list entries still carry defaultConfig.defer_loading — no host reads it (D4)');

if (fail.length) {
  console.error('check-hot-tool-order: FAIL');
  for (const f of fail) console.error('  - ' + f);
  process.exit(1);
}
console.log('✓ hot-tool order: ' + window + '/' + window + ' hot tools at page-1 positions 1-' + window
  + ' (' + tools.length + ' tools served, 0 defer_loading); ' + note.join('; '));
