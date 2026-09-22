# Client fan-out patterns on the AINumbers MCP worker

RUN-2-1 (IMPL-PLAN-P0P1-UNILATERAL-2026-09-21 §4 C2; absorbs COSTPREFLIGHT-1).
Batch semantics (one handle, per-row terminal states, pre-flight estimate) are
inspired by GREP AI (Parcha Labs — https://grep.ai). **Every cap below is ours,
measured on our own deployed endpoint — none are copied defaults.**

## The tier this worker runs on (why fan-out is shaped this way)

The deployed worker (https://mcp.ainumbers.co/mcp) is on Cloudflare's **free
plan**: roughly **10 ms of CPU per invocation** (the in-repo 1102-exhaustion
history), a **25 s hang guard**, and a 128 MB memory bound. The binding fact:

> N chains executed inside ONE invocation share ONE CPU budget, while N
> sequential calls get N budgets. Batching is CPU-adverse; sequential calling
> is the tier's native parallelism.

Local, dev, and corpus measurements are structurally blind to this wall — the
estate's own gates note it. **Only live-endpoint measurement is truthful**, so
the caps below were measured live (method in the next section).

Also: **JSON-RPC-level batching stays refused** (the worker answers a batched
JSON-RPC array with `-32600`, per the id-splice DoS gate). `run_chain_batch` is
ONE `tools/call`, not a batched JSON-RPC array.

## The blessed pattern (default answer): sequential `run_chain` calls

For fan-out over many chains, make **sequential `run_chain` calls** — one per
chain. Each call is a fresh invocation with its own CPU budget, its own 25 s
guard, and its own response bound. Retries are per-row and trivially safe:
every AINumbers chain is **deterministic** — the same inputs reproduce the same
per-step outputs and the same `composite_execution_hash` — so a retry can never
double-apply anything. This is the honest answer to fan-out on this tier, and
it is what the tool descriptions point to beyond the caps.

## `run_chain_batch` — the small-N sync batch (when you have a handful)

`run_chain_batch` runs up to **8 rows** (one named chain per row) in one
round-trip, with:

- **`mode: "estimate"`** (ship-first, the absorbed COSTPREFLIGHT-1): validates
  every row — chain exists, step counts, per-step compute feasibility, inputs
  coverage (`caller`/`fixture`/`none`), and each OCG §21.4 decision gate's
  **static rule shape** — **without executing anything**. No kernel runs, no
  execution_hash is produced. Cheap enough to call before any planned batch.
- **`mode: "run"`** (default): executes every row through the **same engine as
  `run_chain`** (`executeChainRun`, moved verbatim; CI-gated by hash-parity
  against a direct `run_chain` call). All rows' results come back in the ONE
  response, each with a **per-row terminal status**:
  `completed | input_required | escalated | partial | error | unknown_chain | no_steps`.
  One row's failure never fails another.
- Rows carry the row's `composite_execution_hash`, `ledger_url`, and full
  `result`. The per-row base64 OTel span document is trimmed from batch
  responses (call `run_chain` directly for that row if you want the span tree);
  no hashed byte changes.

### The caps, and how they were measured

| Cap | Value | Basis |
|---|---|---|
| `RUN_CHAIN_BATCH_MAX_ROWS` | 8 | single-digit rows; each row returns its full composite artifact (response size / 25 s guard ergonomics) |
| `RUN_CHAIN_BATCH_MAX_TOTAL_STEPS` | 11 | **measured live** (below) — the largest server-kernel-step count observed completing in one invocation |

**Live measurement** (2026-09-22T03:0xZ, `https://mcp.ainumbers.co/mcp`, the
deployed free-plan endpoint; probe kept tiny per the row's back-off rule): an
N-step fixture-backed chain via `run_chain` puts **N kernel builds inside one
invocation sharing one CPU budget** — the same bound an N-row batch of
one-step chains hits. Probes at **1, 2, 3, 4, 5, 6 and 11 steps** all
completed green: HTTP 200, full `composite_execution_hash`, worst case
**416 ms / 138 KB** (the 11-step chain). No probe errored, so the back-off
rule never fired and the probe deliberately stopped at tiny N rather than
hunting the wall — **11 is a bound from evidence, not a claim about where the
wall actually is.** A batch whose rows total more than 11 server-kernel steps
is refused **before any execution** (`batch_step_budget_exceeded`), so the cap
is observable, not advisory.

### Retry = whole-batch re-run (safe because deterministic)

A retry re-runs the **whole batch**. That is safe: determinism reproduces every
per-step output and every `composite_execution_hash` byte-identically (only
wall-clock envelope fields like `generated_at` differ; nothing hashed does).
Fill `inputs` for any `input_required` row before retrying; `escalated` rows
need no retry — the run completed (non-blocking resolve-handle record on the
row). Mandates and `input_required` escalation are **not accepted** on batch
rows, which keeps the synchronous path CPU-bounded.

## Async / Workflows-based batch → WATCH

An async batch (queue a fan-out, poll for results) would remove the shared-CPU
constraint entirely, but it needs either a **paid tier** or a **Workflows
design row** (state, durability, and the idempotency carve-outs it would
interact with). Status: **WATCH** — trigger: paid tier or a Workflows design
row. Do not approximate it client-side with fire-and-forget parallel
`run_chain_batch` calls; sequential `run_chain` is the supported pattern today.

## Where the gates live

- `scripts/test-run-chain-batch.mjs` — estimate executes nothing; per-row
  terminal statuses; hash parity vs direct `run_chain`; whole-batch retry
  determinism; both caps enforced. Wired into worker CI + `preflight.mjs`.
- `scripts/run-chain-corpus.mjs` — the same-engine proof for `run_chain`
  itself (244/244 fixture-backed chains, deterministic + schema-valid).
- `scripts/check-utility-count-parity.mjs` — the worker count vs the site's
  `data/mcp-counts.json` (advisory on PRs, strict on worker master push; the
  SITE PR merging first is what keeps master green).
