# Attribution Protocol

This document describes the current attribution protocol implemented by
`bun run src/cli.ts attribute`.

The protocol starts from a saved `track: "utility"` artifact and estimates the
marginal contribution of the most-loaded AKM assets by masking them one at a
time.

## What This Protocol Measures

Attribution answers two questions:

- which assets were loaded during the base utility run
- how much the base `akm` pass rate changes when one top-loaded asset is masked

The masking strategy in the current codebase is always leave-one-out.

## Inputs

Install dependencies once:

```sh
bun install
```

Generate or choose a saved utility report first.

Example utility run:

```sh
bun run src/cli.ts config/reference-suite-v1.json --results-dir ./results/reference/v1
```

Then run attribution against that saved artifact:

```sh
bun run src/cli.ts attribute --base ./results/reference/<utility-report>.json --top 5
```

Checked-in example from `docs/reference-workflow.md`:

```sh
bun run src/cli.ts attribute --base ./results/bench-report-utility-main-6229e9a-2026-05-05T23-29-38.867Z-shredder-qwen-qwen3.5-9b.json --top 5
```

Required input:

- `--base <path>`: path to a saved utility report

Optional input:

- `--top <N>`: number of top-loaded assets to mask; default `5`

The base report must contain a non-empty top-level `perAsset.rows` block.

## What The Protocol Reuses From The Base Report

The `attribute` command reads these values from the base utility artifact:

- `corpus.slice`
- `corpus.seedsPerArm`
- `agent.model`
- `aggregate.akm`
- `perAsset`
- `runs[]` when present

It then lists tasks from the current fixtures root for the same slice and
re-runs both arms:

- `noakm`
- `akm`

for each masked asset.

The projected rerun count reported on `stderr` is:

```text
masked assets × tasks × 2 arms × seedsPerArm
```

## Masking Behavior

For each selected asset ref:

1. Copy each source fixture stash into a fresh temporary directory.
2. Remove matching entries from `.stash.json` files in that temporary stash.
3. Delete the corresponding asset files from the temporary stash when present.
4. Re-run the selected corpus against the masked temporary stashes.

The committed fixture stashes under `fixtures/stashes/` are not modified.

If an asset ref is not present in a given fixture stash, that task is still
rerun against an effectively unchanged copy of the stash.

## Standard Outputs

Every successful attribution run produces:

- JSON on `stdout`
- a markdown summary on `stderr`, unless `--json` is passed

The JSON contract is:

- `schemaVersion: 1`
- `track: "attribute"`

Top-level fields are:

- `base.path`
- `base.model`
- `attribution.maskingStrategy`
- `attribution.maskedRefs`
- `maskingStrategy`
- `runsPerformed`
- `perAsset`
- `attributions[]`

`perAsset` uses the same public shape documented in `docs/attribution-schema.md`.

Each `attributions[]` row contains:

- `asset_ref`
- `base_pass_rate`
- `masked_pass_rate`
- `marginal_contribution`

## How To Interpret The Results

For each masked asset:

- `marginal_contribution > 0`: masking reduced pass rate, so the asset helped
- `marginal_contribution = 0`: masking produced no measured change
- `marginal_contribution < 0`: masking improved pass rate, so the asset may be
  harmful or noisy

`runsPerformed` is the number of masked reruns actually executed. It equals the
clamped top-N count, not the total underlying `(task, arm, seed)` executions.

`attribution.maskedRefs` is ordered and matches `attributions[]` row order.

## Failure And Validation Conditions

The command exits with an input error when:

- `--base` is missing
- the base file does not exist
- the base file is not valid JSON
- the base report has no `perAsset.rows`

The command exits with a run failure when a masked-corpus rerun throws or fails
before the report is emitted.

## Current Implementation Notes

- Attribution currently depends on the current fixtures root for task metadata
  and stash contents during reruns.
- `attribute --opencode-config <path>` is parsed and validated for parity with
  other commands, but the loaded provider config is not currently forwarded into
  masked reruns.
- The base utility report is the source of truth for the initial per-asset load
  ranking.
