# @postoaklabs/ocgr-embed — OpenChainGraph Runtime, embedded channel

Run AINumbers' verified compliance logic **inside your own environment**, and verify any
OpenChainGraph `execution_hash` **offline** against the public OCG standard, without calling us.

This is the embedded delivery channel for the OpenChainGraph Runtime (OCGR). It packages the
same deterministic kernels, the same canonical execution hash, the same §16 signer/verifier and
the same §18 compute-proof verifier that run on `mcp.ainumbers.co`, so a regulated firm behind a
strict allowlist can:

- run the **same deterministic kernels** and get the **same `execution_hash`** entirely within
  its own walls (zero egress, no PII, no API, no server), and
- **verify any OCG artifact offline** (recompute the hash, check the signature, check the proof).

It reaches the audience that allowlist-blocks both `ainumbers.co` and `mcp.ainumbers.co`.

## Guarantees

- **Zero telemetry, zero network.** No `fetch`, no sockets, no beacons anywhere in the bundle.
  The self-test greps the source to enforce this.
- **Byte-identical results.** The embedded `runChain` reproduces the live Worker's composite
  `execution_hash` exactly. The pinned conformance vectors (see `fixtures/conformance.json`)
  include `agent-commerce-conformance` =
  `e51f3c239b0e4395f5baa5d1f1088eca22852be4521b198089ea3a4356428bb6`.
- **No forked math.** The primitives in `lib/` are byte-identical copies of the canonical
  sources (`kernels/_hash.mjs`, `kernels/_proof.mjs`, and the site repo's `_computeproof.mjs` +
  `_noble-bn254.bundle.mjs`). `node vendor.mjs --check` fails on any drift.
- **License: CC BY 4.0.**

## Layout

| File | Purpose | Self-contained? |
|---|---|---|
| `verify.mjs` + `lib/` | Offline verifiers: §4 `verifyExecutionHash`, §16 `verifySignature`, §18 `verifyComputeProof`. | **Yes** — drop these alone to verify any OCG artifact. |
| `runChain.mjs` | Execute a whole chain locally into one composite artifact. | Needs the kernel + catalog tree (see Packaging). |
| `index.mjs` | Public entry point (barrel). | — |
| `fixtures/conformance.json` | Pinned canonical composite hashes for the self-test. | Yes |
| `selftest.mjs` | Proves hash match + verifier accept/reject + zero-network. | Yes |
| `vendor.mjs` | Re-copies `lib/` from canonical sources; `--check` = drift gate. | — |

## Use it (Node, ESM)

```js
import { runChain, verifyExecutionHash, verifySignature, verifyComputeProof } from '@postoaklabs/ocgr-embed';

// Run a whole chain locally -> ONE composite artifact whose execution_hash anchors every step.
const result = await runChain('agent-commerce-conformance');
console.log(result.composite_execution_hash);
// e51f3c239b0e4395f5baa5d1f1088eca22852be4521b198089ea3a4356428bb6

// Supply your own per-step inputs (synthetic / anonymised only — no PII):
await runChain('agent-commerce-conformance', {
  'art-01-ap2-mandate-chain-validator': { /* policy_parameters */ },
});

// Verify ANY OCG artifact offline, without calling AINumbers:
await verifyExecutionHash(artifact);   // §4  -> { valid, computed_hash, claimed_hash }
await verifySignature(artifact);       // §16 -> boolean (did:key resolved from the proof)
verifyComputeProof(artifact);          // §18 -> boolean (Groth16-BN254 seal)
```

Verifying is fully dependency-free:

```js
import { verifyExecutionHash } from '@postoaklabs/ocgr-embed/verify';
```

## Use it (vanilla browser)

`crypto.subtle` (used for §4/§16) is available in every modern browser, and the §18 verifier is
pure JS. Bundle to a single browser file with one esbuild command (esbuild is the only build-time
dependency; the output has none):

```bash
npx esbuild embed/index.mjs --bundle --format=esm --outfile=ocgr-embed.browser.js
```

Then, in a page (no network calls after load):

```html
<script type="module">
  import { verifyExecutionHash } from './ocgr-embed.browser.js';
  const res = await verifyExecutionHash(artifact);
</script>
```

> `runChain` in the browser needs the kernel tree bundled in as well (see Packaging). The offline
> **verifiers** bundle cleanly on their own from `embed/verify.mjs`.

## Verify the bundle itself

```bash
node embed/selftest.mjs        # hash match + verifier accept/reject + zero-network grep
node embed/vendor.mjs --check  # lib/ is byte-identical to the canonical sources
```

## Packaging a standalone distributable

`verify.mjs` + `lib/` are already self-contained. `runChain` additionally loads the deterministic
kernels and the chain catalog from the sibling worker-repo tree:

- `mcp-apps-poc/kernels/` — the kernel registry (`index.mjs`) + `*.kernel.mjs`.
- `mcp-apps-poc/data/chaingraph/chaingraph.json` — the node/chain catalog.
- `mcp-apps-poc/data/chain-fixtures.json` — representative per-step default inputs.

To ship `runChain` to a firm, vendor those three alongside `embed/` (or pass them in via the
`deps` argument: `runChain(chain, inputs, { getKernel, chaingraph, fixtures })`). The kernels are
already portable, deterministic ESM with no external dependencies.

## Provenance and drift

`lib/` is copied, never forked. `vendor.mjs` re-copies from the single canonical sources and
`--check` is the drift gate. If a copy ever diverges, the check fails loud rather than letting two
implementations drift apart.

---

Post Oak Labs. OpenChainGraph standard: https://ainumbers.co/chaingraph/ . License: CC BY 4.0.
