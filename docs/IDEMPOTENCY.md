# Idempotency semantics of the AINumbers MCP endpoint (mcp-apps-poc)

**Row:** RUN-1-1 (build/doc) · **staged:** 2026-09-21 · **landed:** 2026-09-22 · **spec:** `IMPL-PLAN-P0P1-UNILATERAL-2026-09-21.md` §4 C3
**Attribution:** Idempotency-Key semantics inspired by GREP AI (Parcha Labs — https://grep.ai), re-authored here for a deterministic, receipt-anchored surface.
**Companion selftest:** `scripts/test-run-chain-dedupe-echo.mjs` (wired into `scripts/preflight.mjs`).

## 1. The one-paragraph contract

Every `/mcp` tool call is deterministic pure compute: same canonical inputs → same `execution_hash`, forever, per deployed vendor bytes. There is no receipt store to consult and none is needed — **a safe retry is simply a re-run, and it returns a byte-identical artifact** (the wall-clock fields `generated_at` / `opened_at` differ; the hashes do not). Idempotency here is *derived from determinism*, not from a de-duplication store. **De-duplication is a cache concern, not a correctness concern**: a client that skips a re-run it has already seen is optimizing transport, never changing what the answer would have been. Nothing on this endpoint consumes, mutates, or forfeits state on first call, so there is no "double-application" hazard to defend against — the classical reason APIs need explicit Idempotency-Key validation serverside does not exist here.

## 2. What makes retry safe (the deterministic surface)

- Per-request stateless tool calls: each `tools/call` computes from the vendored `data/` + `kernels/` committed at deploy; no session, no per-call writes.
- `execution_hash` (OCG §4) is a canonical (RFC 8785/JCS-aligned, `kernels/_hash.mjs`) digest over `policy_parameters` + `output_payload` only — wall-clock, callers' key order, and hash-excluded adjacent metadata (§20 anchors, §23 attestations, §22.8 escalation records, compliance-flag roll-ups) never move it.
- `run_chain` threads step hashes into `parent_hashes` and anchors the run with a `composite_execution_hash` whose preimage is equally clock-free (§21.4/§22.5 members are conditional-presence, so a no-gate/no-mandate run's composite hash is frozen at its baseline).

### 2a. The `dedupe` echo (RUN-1-1, IDEMPOTENCY-ECHO-1)

Server-mode `run_chain` responses carry a stable field for client-side dedupe:

```jsonc
"dedupe": {
  "input_hash": "80afdae6…",            // JCS-SHA-256 (§PPH-1 policyParametersHash) over the effective run inputs
  "composite_execution_hash": "e51f3c23…" // exactly the response's top-level composite_execution_hash
}
```

- `input_hash` preimage: `{ chain, compute: 'server', steps: [{ tool_id, policy_parameters }…], mandate_hash? }`, where each step's `policy_parameters` resolves with the **same caller → fixture → `{}` `??` chain the kernel dispatch uses** (so "omitted" and "explicitly fixture-equal" hash identically) and `mandate_hash` is conditional-presence exactly like the composite policy's (a no-mandate run's `input_hash` is frozen). `escalation_transport` is **excluded** — it selects the §22.8 response transport, never the artifacts. Non-I-JSON input has no canonical form: `input_hash` stays `null` with `input_hash_note` instead of an unstable digest (same §6 posture as the execution hash).
- The echo rides on the response object only — never inside `composite_policy`/`composite_output` — so no preimage byte moved (re-measured at landing: all four probe chains' composite hashes byte-identical before/after the change; 244/244 corpus chains deterministic and schema-valid).
- A run where **no** step ran (all steps `status:"input_required"`) has `composite_execution_hash: null` but still echoes a valid `input_hash` — the input identity exists even when there is no output to anchor.
- `compute:"browser"` is zero-egress delegation: nothing ran server-side, so no echo is offered.
- Client recipe: keep `{ dedupe.input_hash → dedupe.composite_execution_hash }` per endpoint; on a planned retry, if the previous call completed, reuse its response; if it failed mid-transport, re-run and (optionally) confirm the fresh echo matches before acting on it. This mirrors the advertised `cacheHint: { ttlMs: 86400000, cacheKey: 'input_hash' }` contract already on all 720 `tools/list` entries (§M1.5, gated by `scripts/test-ttl-cache-key.mjs`).

## 3. Carve-outs — the parts that are NOT stateless (explicit)

The worker is per-request stateless for tool calls but **not blanket-stateless**. A client reasoning about retries must know these five (plus the drift class in §3.6):

### 3.1 RenewalWatchWorkflow (`workflows/renewal-watch-workflow.mjs`, binding `RENEWAL_WATCH_WORKFLOW`)

A durable Cloudflare Workflow: multi-week `step.sleep` renewal checks with checkpointed signed resumption artifacts. It is receipt-adjacent infrastructure (it re-verifies an existing artifact's anchor bindings) — it never computes or re-hashes tool output — but it is durable state with resumption, not a stateless call.

### 3.2 `scheduled()` (cron, Mon 06:00 UTC)

A weekly tick that emits a CloudEvents envelope and runs the Reserve Watch check. It produces *new* signed receipts per tick and enqueues events. Retrying "the cron" is not a tool-call retry: each tick is its own event with its own envelope id.

### 3.3 `queue()` consumer

Drains `ainumbers-events`; a `co.ainumbers.anchor.renewal_check` envelope hands its artifact to RenewalWatchWorkflow (or the inline fallback). The consumer `ack()`s every message; a redelivered queue message re-runs the check (detect-and-report only — it mints no new timestamp), so the *observable* effect is idempotent, but the execution is not deduplicated.

### 3.4 MRTR_STATE_KEY retries (SEP-2322 `requestState`)

The input_required escalation transport seals protected state (HMAC) carrying the §22.8.3 `record_hash`, principal, request binding, and a **15-minute expiry**. Two retry-visible consequences:

- With `MRTR_STATE_KEY` configured, sealed state verifies across isolates/deploys. Without it, state is sealed with a per-isolate ephemeral key: a retry served by a **different isolate** fails verification and is answered with a **fresh InputRequiredResult** — by design (spec Error Handling), never an error.
- Sealed state is time-limited: a retry after expiry gets a fresh InputRequiredResult too. What stays stable is the underlying `record_hash` (its preimage is `{ mandate_hash?, decision, halted_steps }` — clock-excluded), so a late retry still targets the same open record.

Single-use redemption is deliberately NOT enforced: resolving an escalation re-verifies a closure against a deterministic hash and redeems nothing, so replaying the closure leg is safe.

### 3.5 The `input_required` flow

Two distinct shapes, both retry-safe but neither "returns the final artifact":

1. **Per-step `input_required`**: a step whose kernel needs inputs the caller omitted is *reported per-step* (`status:"input_required"`, with the exact hint), never failed silently. Retrying after supplying `inputs[tool_id]` runs the whole chain again; previously-satisfied steps recompute deterministically to the same hashes.
2. **SEP-2322 multi-round-trip escalation** (`escalation_transport:"input_required"`, opt-in): the call answers with an InputRequiredResult carrying sealed `requestState`; the retry echoes it (plus the §22.8.4 closure). See §3.4 for the retry semantics of that sealed state.

### 3.6 The null-strip drift class (MR-R4-NULL-NORMALIZE-WORKER-1, worker.mjs:3258 region at base 290cf71)

Before compute AND before the hash preimage, the Mode-4 dispatch strips **null-valued members** from `policy_parameters` (null *array elements* are positional and preserved; a manifest `x_null_distinct` declaration is exempt — no manifest declares one today). Consequences, measured (LIVESMOKE-ART589-EXECUTIONHASH-DRIFT-1, ORCH-187 verdict):

- **Live-vs-golden drift only**: a live call whose fixture carries explicit `null` members returns an artifact whose echoed `policy_parameters` and `execution_hash` match the *normalized* input, which can differ from a golden recorded over the raw null-carrying fixture bytes. This is a *recording* divergence between live and golden, not nondeterminism — 26 of 666 fixture vectors carry explicit nulls and are primed for the same false-DRIFT on rotation.
- **Retry determinism is intact**: the same input (nulls present or absent) normalizes identically on every call — same stripped `policy_parameters`, same `execution_hash`, byte-identical on retry. The strip is a pure function of the input.

Until Tim picks the cure (manifest `x_null_distinct` vs fixture re-encoding vs amending the strip), clients should treat explicit-`null` members as absent when forming expectations about hashes.

## 4. Shared-cache hints (advertised, client-side, still stateless)

The server holds **no server-side response cache**. What exists is advertised *metadata* for conservative clients:

- `tools/list` entries carry `cacheHint: { ttlMs: 86400000, cacheKey: 'input_hash', note: 'cache by the JCS-canonical policy_parameters hash only; never by wall-clock or session' }` (§M1.5; baked by `scripts/precompute-discovery.mjs`, contract gated by `scripts/test-ttl-cache-key.mjs`).
- `resources/list`/`resources/read` descriptors carry `_meta: { ttlMs, cacheScope: 'shared' }` (tool descriptors, chain receipts) — HTTP-cache-modeled: a shared cache may serve them within TTL because their content for a given key is deterministic.

These make client/CDN caching *safe*, and they are exactly why dedupe is a cache concern: the cached object and the recomputed object are byte-identical within a deployment.

## 5. Scope of the guarantee (read before relying on it)

- **Per deployed vendor bytes.** Determinism binds inputs to hashes *for the currently deployed kernel/data vendor*. A vendor refresh that lands new kernel bytes can legitimately move `execution_hash` for the same inputs; the receipt layer (§4 preimage, `verify_execution_hash`) exists precisely so that change is detectable, not silent. Cross-deploy "same hash" is not promised.
- **Mandate-bound runs**: a §22 mandate folds `mandate_hash` into every step and the composite; a no-mandate run stays byte-identical to the pre-binding baseline (linear-hash-freeze invariant).
- **Rate limits** (`MCP_RATE_LIMITER`, `MCP_GLOBAL_RATE_LIMITER`) can 429 a retry; a 429 never consumed anything — retry with backoff is always safe.

## 6. D2 (KV/Cache receipt cache) — deliberately deferred

No KV, Cache, R2, or D1 receipt store exists on this worker today (bindings: `ASSETS`, `ANALYTICS`, `EVENTS_QUEUE`, `RENEWAL_WATCH_WORKFLOW`, two ratelimiter namespaces, the `MRTR_STATE_KEY` secret). A receipt cache would make "seen before → return stored receipt" a *served* idempotency, but it adds a new binding and a second source of truth beside the recompute-and-match hash check (§HASHRES-1). **D2 stays deferred: only with Tim's approval of a new binding — it is not part of RUN-1-1.**
