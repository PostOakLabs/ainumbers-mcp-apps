# Advisory: fail-open verdicts on missing inputs

Dated observation, 2026-10-15, against worker `origin/master` at sha `94f4e64dd92efab6d74cf0c6a46f6573e2ba386c`. This document records where a node can return an affirmative or passing verdict when its ratio inputs are absent or zero, and how a client can detect that condition from a response alone. It is an observation, not a promise: the nodes described here are unchanged by this document.

## 1. Verdicts that can be fail-open

Each row names the node, the verdict field, the exact branch that runs when the denominator input is zero or absent (quoted from the vendored kernel under `kernels/`), what the output looks like in that case, and which flag, if any, is raised. In every case below the empty-input behavior was reproduced by running the kernel through the worker's own embed path (`kernels/index.mjs` `getKernel` and `buildArtifact`, hashed by `embed/lib/_hash.mjs`); the quoted outputs in section 2 are from those real runs, not invented.

| Node | Verdict field | Fail-open branch (quoted) | Output on no data | Flag raised |
|---|---|---|---|---|
| art-364-compute-lcr-nsfr-leverage | `lcr.lcr_compliant` | `kernels/art-364-compute-lcr-nsfr-leverage.kernel.mjs:73` `const lcrRatio = nco > 0 ? hqlaTotal / nco : null;` then line 83 `lcr_compliant: lcrRatio === null ? true : lcrRatio >= 1,` | `lcr_pct: null`, `lcr_compliant: true` when `net_cash_outflows_musd` is 0 | `ALL_THREE_RATIOS_COMPLIANT` |
| art-364-compute-lcr-nsfr-leverage | `nsfr.nsfr_compliant` | same file, line 103 `const nsfrRatio = totalRsf > 0 ? totalAsf / totalRsf : null;` then line 109 `nsfr_compliant: nsfrRatio === null ? true : nsfrRatio >= 1,` | `nsfr_pct: null`, `nsfr_compliant: true` when `total_rsf_musd` is 0 | `ALL_THREE_RATIOS_COMPLIANT` |
| art-364-compute-lcr-nsfr-leverage | `leverage.leverage_ratio_compliant` | same file, line 128 `const lr = totalExp > 0 ? (tier1 / totalExp) * 100 : null;` then line 135 `leverage_ratio_compliant: lr === null ? true : lr >= minLrPct,` | `leverage_ratio_pct: null`, `leverage_ratio_compliant: true` when `total_exposure_musd` is 0 | `ALL_THREE_RATIOS_COMPLIANT` |
| art-427-discount-window-capacity | `capacity_compliant` | `kernels/art-427-discount-window-capacity.kernel.mjs:57` `const coveragePct = runnableTotal > 0 ? (lendableValue / runnableTotal) * 100 : null;` then line 58 `const capacityCompliant = coveragePct === null ? true : coveragePct >= coverageTargetPct;` | `coverage_pct: null`, `capacity_compliant: true` when `runnable_liabilities_musd` is 0 | `DW_CAPACITY_COVERAGE_ADEQUATE` (line 62, the `else` arm: `compliance_flags.push('DW_CAPACITY_COVERAGE_ADEQUATE');`) |
| art-378-quarterly-test-evidence-composer | `chain_intact` | `kernels/art-378-quarterly-test-evidence-composer.kernel.mjs:103` `const chain_intact = prior_quarter === null ? true : declared_prior_pack_digest === prior_quarter.pack_digest;` | `chain_intact: true`, `tamper_detected: false` when `prior_quarter` is absent | none for absence; only `AU2_TEST_EVIDENCE_ASSEMBLED`. Note `pack_claim_strength` is honestly `"insufficient"` when `total === 0` (line 113), which is the tell |

The pattern is uniform: a zero-denominator ratio is reported as `null` (the kernels' own finite gate, e.g. art-364 line 23: "a zero-denominator ratio is reported as null (finite gate: never NaN/Infinity)"), and the companion compliance boolean treats `null` as passing.

### Reviewed, no fail-open branch found: art-444-collateral-haircut-engine

A manual read of the compute path in `kernels/art-444-collateral-haircut-engine.kernel.mjs` (lines 109 to 164) found no verdict field that flips to a passing value on missing inputs. Specifically:

- Line 128 `if (heTable === null) { heTable = exposureIsCash ? 0 : 100; exposureUnclassified = !exposureIsCash; }` and line 67 `if (hcTable === null) { hcTable = 100; unclassified = true; unclassifiedCount += 1; }` fall back to a conservative 100% haircut, and line 141 flags it with `CRE22_UNCLASSIFIED_ASSET_CLASS`. That is fail-closed, not fail-open.
- Line 142 `if (netExposure > 0) compliance_flags.push('CRE22_NET_EXPOSURE_UNCOLLATERALIZED');` surfaces residual exposure rather than hiding it.
- With completely empty inputs the kernel raises `CRE22_HAIRCUT_APPLIED` (line 140, the `else` arm of the override-reason check, fires because `override_missing_reason_count` is 0). That flag is a processing-confirmation, not an adequacy verdict: it does not assert compliance or adequacy, so it is not listed as fail-open.

## 2. Client-side detection recipe

Treat a verdict as unreliable when ALL of the following hold. The recipe is runnable by an agent from the response alone.

- (a) The artifact's top-level `compute_proof_ready` is `"deferred"`, or the field is absent (art-378's artifact omits it entirely). This is a top-level artifact field, not inside `compliance_flags`.
- (b) The ratio inputs listed for that node below are zero or absent in the request that was sent.
- (c) The adequacy or compliant verdict flag is `true`, or the numeric result is a clean pass (`null` ratio with a `true` boolean, `ALL_THREE_RATIOS_COMPLIANT`, `DW_CAPACITY_COVERAGE_ADEQUATE`, `chain_intact: true`).

Input fields per node, named from the kernel's reads:

- art-364, LCR verdict: `lcr.hqla_positions`, `lcr.outflows`, `lcr.inflows` (absent arrays become empty via `arr()`; `net_cash_outflows_musd` must be 0 to trigger the branch).
- art-364, NSFR verdict: `nsfr.asf_items`, `nsfr.rsf_items` (`total_rsf_musd` must be 0).
- art-364, leverage verdict: `leverage.cet1_musd`, `leverage.at1_musd`, `leverage.onbs_exposure_musd`, `leverage.derivative_exposure_musd`, `leverage.sft_exposure_musd`, `leverage.offbs_exposure_musd`, `leverage.other_exposure_musd` (`total_exposure_musd` must be 0).
- art-427: `collateral_positions`, `runnable_liabilities` (`runnable_liabilities_musd` must be 0).
- art-378: `prior_quarter` must be absent to trigger the `chain_intact` branch; `tests` absent or empty gives `total: 0` and `pass_rate: null`.

### Worked examples (real runs, empty requests)

Each example below is the actual artifact from calling `buildArtifact({})` through the worker's embed path at the sha named above. Note the same fail-open shape appears with all-zero numeric inputs, not only with absent ones.

art-364, request `{}`:

```json
{
  "compute_proof_ready": "deferred",
  "compliance_flags": ["ALL_THREE_RATIOS_COMPLIANT"],
  "output_payload": {
    "lcr": { "net_cash_outflows_musd": 0, "lcr_pct": null, "lcr_compliant": true },
    "nsfr": { "total_rsf_musd": 0, "nsfr_pct": null, "nsfr_compliant": true },
    "leverage": { "total_exposure_musd": 0, "leverage_ratio_pct": null, "leverage_ratio_compliant": true }
  }
}
```

art-427, request `{}`:

```json
{
  "compute_proof_ready": "deferred",
  "compliance_flags": ["DW_CAPACITY_COVERAGE_ADEQUATE"],
  "output_payload": {
    "runnable_liabilities_musd": 0,
    "coverage_pct": null,
    "capacity_compliant": true
  }
}
```

art-378, request `{}`:

```json
{
  "compute_proof_ready": "absent (field not emitted by this artifact)",
  "compliance_flags": ["AU2_TEST_EVIDENCE_ASSEMBLED"],
  "output_payload": {
    "total": 0,
    "pass_rate": null,
    "chain_intact": true,
    "tamper_detected": false,
    "pack_claim_strength": "insufficient"
  }
}
```

art-444, request `{}` (for contrast: no adequacy verdict exists, and the flags are either processing-confirmations or conservative):

```json
{
  "compute_proof_ready": "deferred",
  "compliance_flags": ["CRE22_HAIRCUT_APPLIED"],
  "output_payload": { "item_count": 0, "collateral_adjusted_total": 0, "net_exposure": 0 }
}
```

## 3. What this is not

- This is advisory documentation only. No node, hash, verdict, manifest, fixture or `server.json` byte is changed by it; the diff is exactly one new markdown file.
- The nodes themselves are not fixed here. Remediation of the fail-open branches is planned as separate site and worker row pairs later.
- This document is a dated observation (2026-10-15, worker `origin/master` at `94f4e64dd92efab6d74cf0c6a46f6573e2ba386c`), not a promise about current or future behavior. Kernel lines quoted above can change; re-verify before relying on any row.
