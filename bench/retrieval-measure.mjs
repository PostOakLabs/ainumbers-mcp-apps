// TOOL-RETRIEVAL-MEASURE-1 — measure find_tool / find_chain retrieval quality on the held-out
// intent set in bench/retrieval-intents.json.
//
// THRESHOLD, FIXED BEFORE MEASUREMENT (row step 1): an intent PASSES at top-5 when its expected
// id (tool_id for find_tool, chain_name for find_chain) appears anywhere in the top 5 results.
// The row's pass bar is a top-5 hit rate >= 80% on EACH arm separately. This number was written
// into this header before the harness was ever run — it is not tuned after the fact.
//
// The harness calls the REAL bm25Search exported from worker.mjs (the only change this row made
// to that function is the single `export` keyword). It never re-implements the scorer. Results
// order and relevance_score are read off bm25Search's own output untouched.
//
// Usage: node bench/retrieval-measure.mjs   (from the repo root; exits 0 when it printed both
// hit rates, 1 on any harness error).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { bm25Search } from '../worker.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const TOP5_THRESHOLD = 0.8; // fixed per step 1; do not adjust after seeing numbers.

const intents = JSON.parse(readFileSync(join(here, 'retrieval-intents.json'), 'utf8'));
const searchIndex = JSON.parse(readFileSync(join(here, '..', 'data', 'search-index.json'), 'utf8'));

const arms = {
  find_tool: { index: searchIndex.nodes, idOf: (d) => d.tool_id },
  find_chain: { index: searchIndex.chains, idOf: (d) => d.chain_name },
};

const summary = {};
for (const [arm, { index, idOf }] of Object.entries(arms)) {
  const rows = intents.intents.filter((i) => i.arm === arm);
  let top1 = 0;
  let top5 = 0;
  const misses = [];
  for (const { id, query, expected } of rows) {
    const results = bm25Search(query, index, { topN: 5 });
    const ids = results.map(idOf);
    const pos = ids.indexOf(expected);
    if (pos === 0) { top1++; top5++; }
    else if (pos > 0) { top5++; }
    else misses.push({ id, query, expected, got: ids });
  }
  summary[arm] = { intents: rows.length, top1, top5, top1_rate: top1 / rows.length, top5_rate: top5 / rows.length, misses };
}

for (const [arm, s] of Object.entries(summary)) {
  const pct = (x) => (100 * x).toFixed(1) + '%';
  console.log(`${arm}: top-1 ${s.top1}/${s.intents} (${pct(s.top1_rate)})  top-5 ${s.top5}/${s.intents} (${pct(s.top5_rate)})`);
  for (const m of s.misses) {
    console.log(`  MISS ${m.id} "${m.query}" -> expected ${m.expected}, got [${m.got.join(', ')}]`);
  }
}

const both = Object.values(summary).every((s) => s.top5_rate >= TOP5_THRESHOLD);
console.log(`threshold: top-5 >= ${TOP5_THRESHOLD * 100}% on BOTH arms -> ${both ? 'PASS' : 'FAIL'}`);
