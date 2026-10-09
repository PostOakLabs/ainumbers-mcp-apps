# TOOL-RETRIEVAL-MEASURE-1 — measured retrieval quality (2026-10-09)

- Harness: `node bench/retrieval-measure.mjs` (calls the real `bm25Search` exported from
  `worker.mjs` — the only change to that function is the single `export` keyword; scorer,
  ordering and relevance_score untouched).
- Held-out set: `bench/retrieval-intents.json` — 44 intents (22 find_tool, 22 find_chain),
  written from the user's point of view; no query copies its target's own description text.
- **Threshold, fixed before measurement (row step 1):** pass = top-5 hit rate ≥ 80% on BOTH
  arms separately.

## Result (identical before and after step 5 — the added keys are purely additive)

| arm        | top-1      | top-5      | threshold |
|------------|-----------|------------|-----------|
| find_tool  | 7/22 (31.8%)  | 10/22 (45.5%) | FAIL |
| find_chain | 11/22 (50.0%) | 15/22 (68.2%) | FAIL |

Both arms sat below the 80% bar, so per the row's decision point step 5 ran: `why_matched`
(on every result) and `coverage_gaps` (in the structuredContent of both handlers, empty branch
included) were added OUTSIDE `bm25Search`, gated by `tests/retrieval-explain.test.mjs`
(3/3 pass). Step 7 re-run of the harness quotes the same numbers — before:
find_tool 45.5% / find_chain 68.2% top-5; after: identical, per the hard STOP that the keys
change no score, no order and no relevance_score for any query.

## Where the misses concentrate (from the harness MISS lines, pre-step-5 run)

- find_tool (12 misses): paraphrase gaps — user words ("break even", "electronic invoice",
  "court filings", "deposit insurance premium") never co-occur with the node's indexed
  name/mandate text; the right node often exists but ranks 6+.
- find_chain (7 misses): same shape at chain level; several expected chains rank top-10 but
  outside top-5 (e.g. ccp-margin-monitor, cbam-liability behind cbam-fit).

No index or scorer change was made in this row; these observations are recorded for a future row.
