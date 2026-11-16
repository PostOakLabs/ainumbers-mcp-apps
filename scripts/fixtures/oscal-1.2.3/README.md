# Vendored NIST OSCAL 1.2.3 assessment-results fixtures (CC0)

Vendored by GRC-PILOT-OSCAL-EXPORT-1 (2026-11-16) so `scripts/oscal-mapping.test.mjs` can
schema-validate the EXPORT-1 OSCAL mappers (`_oscal.mjs`) against the REAL NIST schema and
golden examples with ajv — replacing the original "hand-verified against required members"
pass, which the row measured as a defect.

## Provenance (both sources are public-domain / CC0)

| File | Source |
|---|---|
| `oscal_assessment-results_schema.json` | github.com/usnistgov/OSCAL **release tag v1.2.3**, release asset `oscal_assessment-results_schema.json` (asset id 504571690, 152,214 bytes, `$id` `http://csrc.nist.gov/ns/oscal/1.2.3/oscal-ar-schema.json`, JSON Schema **draft-07**) |
| `ifa_assessment-results-min.json` | github.com/usnistgov/**oscal-content** `examples/ar/json/ifa_assessment-results-min.json` @ commit **f0de6d8d8c059d374f15e0ae07508d82e370fc1d** (main, 2026-10-22) |
| `ifa_assessment-results.json` | same repo/ref, `examples/ar/json/ifa_assessment-results.json` |
| `ifa_assessment-results-example-min.json` | same repo/ref, `examples/ar/json/ifa_assessment-results-example-min.json` |
| `ifa_assessment-results-example.json` | same repo/ref, `examples/ar/json/ifa_assessment-results-example.json` |

License: NIST publishes both the OSCAL tool release and oscal-content examples under a
public-domain-equivalent **CC0 1.0 (Public Domain Dedication)**; no attribution obligation
attaches, this file records provenance only.

## Use

- The four `ifa_*.json` files are GOLDEN EXAMPLES: the test first proves the validator setup
  by validating all four against the vendored schema (they must all pass — a red here means
  the validator wiring is wrong, not the mapper).
- `oscal_assessment-results_schema.json` is then compiled once (ajv 8, draft-07, allErrors,
  ajv-formats) and used to validate the receipt-mapper output and the AIUC-1 pack-mapper
  output (node art-304 fixture vector, `data/chain-fixtures.json` scenario
  `assemble-aiuc1-evidence-pack`).
- Schema notes measured at vendor time: `UUIDDatatype` enforces RFC 4122 **v4-or-v5**
  (`[45]` + variant `[89ABab]`); `finding.target` (`finding-target`) **requires**
  `type` (`statement-id`|`objective-id`), `target-id`, `status` (`state`:
  `satisfied`|`not-satisfied`); `observation.relevant-evidence` items **require**
  `description` (href optional); `observation` **requires** `methods` (plural);
  `result.observations`/`result.findings` have **minItems 1** (empty arrays are invalid —
  omit them); `reviewed-controls.control-selections[]` is **anyOf** `include-all` /
  `include-controls` — an empty selection object `{}` (as the 1.1.3-era mapper emitted) is
  INVALID.
