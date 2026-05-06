# Attribution Schema

This document describes the current public output contract for per-asset
attribution in `akm-bench`.

There are two places where the contract appears today:

- the top-level `perAsset` block in a `track: "utility"` report
- the top-level `perAsset` block in a `track: "attribute"` report

The `attribute` report also adds a leave-one-out `attributions[]` block, but
the shared per-asset table keeps the same shape.

## `perAsset` Block

JSON shape:

```json
{
  "perAsset": {
    "total_akm_runs": 15,
    "rows": [
      {
        "asset_ref": "skill:drillbit",
        "load_count": 6,
        "load_count_passing": 6,
        "load_count_failing": 0,
        "load_pass_rate": 1
      }
    ]
  }
}
```

Field meanings:

- `total_akm_runs`: total number of `akm`-arm runs aggregated into the table
- `rows`: one row per unique loaded asset reference
- `rows[].asset_ref`: the AKM asset ref, for example `skill:drillbit`
- `rows[].load_count`: number of `akm`-arm runs that loaded the asset
- `rows[].load_count_passing`: number of those runs whose outcome was `pass`
- `rows[].load_count_failing`: number of those runs whose outcome was not
  `pass`; this includes normal failures and other non-pass outcomes that the
  attribution aggregator treats as failing
- `rows[].load_pass_rate`: `load_count_passing / load_count`, or `null` when
  `load_count` is zero

Sort order is deterministic:

1. `load_count` descending
2. `load_pass_rate` descending
3. `asset_ref` ascending

## Source of Truth

The current implementation computes per-asset attribution from `akm`-arm runs
only.

- The aggregator walks `report.akmRuns` in memory.
- Each run contributes the contents of `assetsLoaded`.
- `noakm` runs are never included.

When a report is written to disk, the public contract is the snake_case JSON
form shown above.

## Utility Report Contract

In a `track: "utility"` report, `perAsset` is an additive top-level block. It
is present only when the runner populated attribution data.

The surrounding utility envelope also includes:

- `schemaVersion`
- `track`
- `branch`
- `commit`
- `timestamp`
- `agent`
- `corpus`
- `aggregate`
- `tasks`
- optional `runs[]`
- optional diagnostics such as `searchBridge`, `workflow`, and `akm_overhead`

`perAsset` is the public per-asset summary for that run. Consumers should not
recompute it from markdown output.

## `attribute` Report Contract

An `attribute` run preserves the same `perAsset` block and adds a marginal
contribution block:

```json
{
  "schemaVersion": 1,
  "track": "attribute",
  "base": {
    "path": "./results/reference/utility.json",
    "model": "shredder/qwen/qwen3.5-9b"
  },
  "attribution": {
    "maskingStrategy": "leave-one-out",
    "maskedRefs": ["skill:drillbit"]
  },
  "maskingStrategy": "leave-one-out",
  "runsPerformed": 1,
  "perAsset": {
    "total_akm_runs": 15,
    "rows": []
  },
  "attributions": [
    {
      "asset_ref": "skill:drillbit",
      "base_pass_rate": 1,
      "masked_pass_rate": 0.67,
      "marginal_contribution": 0.33
    }
  ]
}
```

Additional field meanings:

- `attribution.maskingStrategy`: currently always `leave-one-out`
- `attribution.maskedRefs`: ordered list of masked refs, matching
  `attributions[]`
- `runsPerformed`: number of masked reruns actually executed
- `attributions[].asset_ref`: masked asset ref
- `attributions[].base_pass_rate`: pass rate from the unmasked base report
- `attributions[].masked_pass_rate`: pass rate after masking that one asset
- `attributions[].marginal_contribution`: `base_pass_rate - masked_pass_rate`

Interpretation:

- positive `marginal_contribution`: masking the asset hurt performance, so the
  asset likely helped
- zero `marginal_contribution`: no measured change under this masking run
- negative `marginal_contribution`: masking improved performance, so the asset
  may be harmful or noisy

## Example from a Checked-in Artifact

One checked-in utility artifact currently contains:

```json
{
  "perAsset": {
    "total_akm_runs": 15,
    "rows": [
      {
        "asset_ref": "skill:drillbit",
        "load_count": 6,
        "load_count_passing": 6,
        "load_count_failing": 0,
        "load_pass_rate": 1
      },
      {
        "asset_ref": "skill:inkwell",
        "load_count": 6,
        "load_count_passing": 5,
        "load_count_failing": 1,
        "load_pass_rate": 0.8333333333333334
      },
      {
        "asset_ref": "skill:opencode",
        "load_count": 3,
        "load_count_passing": 3,
        "load_count_failing": 0,
        "load_pass_rate": 1
      }
    ]
  }
}
```

That example comes directly from a checked-in utility report in `results/` and
matches the renderer and metrics code in `src/report/utility-track.ts`,
`src/report/evolve-track.ts`, `src/report/attribution.ts`, and
`src/metrics/attribution.ts`.
