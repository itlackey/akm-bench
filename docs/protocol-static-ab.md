# Static A/B Protocol

This document describes the current static benchmark protocol implemented by the
`utility` track.

It covers two supported entry points:

- config-file mode: `bun run src/cli.ts <config>.json`
- legacy subcommand mode: `bun run src/cli.ts utility ...`

`docs/reference-workflow.md` lists the canonical commands. This document adds
the exact inputs, outputs, and how to read them.

## What This Protocol Measures

The static protocol runs a fixed task set for one or more seeds and compares arm
level outcomes.

- `akm`: the agent runs with a materialized fixture stash
- `noakm`: the control arm without AKM
- `synthetic`: optional self-notes arm without AKM stash

The primary A/B utility metric is:

```text
pass_rate(akm) - pass_rate(noakm)
```

That delta is only meaningful when both `akm` and `noakm` were run.

## Inputs

Install dependencies once:

```sh
bun install
```

Provide an opencode config through one of the supported discovery paths.

Recommended local setup:

```sh
cp ~/.config/opencode.json ./config/opencode.local.json
```

Model resolution differs by entry point:

- config-file mode: model is resolved by `BENCH_OPENCODE_MODEL`, then config
  `model`, then loaded opencode config `model`
- legacy `utility` mode: model is resolved by `BENCH_OPENCODE_MODEL`, then the
  loaded opencode config `model`

The task corpus comes from the default fixtures root unless `--fixtures-dir` or
`BENCH_FIXTURES_DIR` overrides it.

## Commands

Canonical reference-suite run from `docs/reference-workflow.md`:

```sh
bun run src/cli.ts config/reference-suite-v1.json --results-dir ./results/reference/v1
```

Smaller pinned run:

```sh
bun run src/cli.ts config/nano-quick.json --results-dir ./results/reference
```

Broader pinned run:

```sh
bun run src/cli.ts config/full.json --results-dir ./results/reference
```

Legacy two-arm A/B run:

```sh
bun run src/cli.ts utility --tasks all --seeds 5 --results-dir ./results/reference
```

Legacy three-arm run with the synthetic comparison arm:

```sh
bun run src/cli.ts utility --tasks all --seeds 5 --include-synthetic --results-dir ./results/reference
```

AKM-only utility run:

```sh
bun run src/cli.ts utility --tasks all --seeds 5 --no-noakm --results-dir ./results/reference
```

## Inputs Consumed By The Runner

For each selected task, the runner uses:

- task metadata from `fixtures/corpus/tasks/**/task.yaml`
- the task workspace template, when present
- the task verifier (`script`, `pytest`, or `regex`)
- the task fixture stash named by `task.stash` for `akm`
- the configured model and budgets
- `seedsPerArm` runs per `(task, arm)`

Current checked-in config-file examples are AKM-only:

- `config/reference-suite-v1.json`: 26 named tasks, `arms: ["akm"]`, `seeds: 5`
- `config/nano-quick.json`: 5 named tasks, `arms: ["akm"]`, `seeds: 2`
- `config/full.json`: all tasks, `arms: ["akm"]`, `seeds: 5`

To run a true static A/B comparison in config-file mode, the config must include
both arms, for example `"arms": ["noakm", "akm"]`.

## Standard Outputs

Every successful utility run produces:

- JSON on `stdout`
- a markdown summary on `stderr`, unless `--json` is passed
- a persisted JSON artifact under `results/` or `--results-dir`

Artifact naming is:

```text
bench-report-utility-<branch>-<commit>-<timestamp>-<model>.json
```

The top-level JSON contract is `schemaVersion: 1` and `track: "utility"`.

## Utility Report Contents

The persisted report includes these top-level blocks:

- `agent`: harness and model
- `corpus`: domain count, task count, slice, seeds, selected task ids, corpus
  hash, fixture hashes
- `aggregate.noakm`
- `aggregate.akm`
- `aggregate.delta`
- optional `aggregate.synthetic`
- optional `aggregate.akm_over_synthetic_lift`
- `tasks[]`: per-task `noakm`, `akm`, `delta`, and optional `synthetic`
- `trajectory.akm`
- `failure_modes`
- `token_measurement`
- `negative_transfer_count`, `top_regressed_tasks`, `domain_level_deltas`
- `corpus_coverage`
- `workflow`
- optional `searchBridge`
- optional `runs[]`
- optional `baseline_by_task_id`
- `perAsset`
- `akm_overhead`
- `warnings[]`

## How To Interpret The Results

For A/B utility:

- `aggregate.delta.pass_rate > 0`: the `akm` arm passed more often than
  `noakm`
- `aggregate.delta.pass_rate = 0`: no measured pass-rate difference
- `aggregate.delta.pass_rate < 0`: the `akm` arm underperformed the control

For cost and latency:

- `aggregate.<arm>.tokens_per_pass` and `tokens_per_run` are only reliable when
  `token_measurement.reliable` is `true`
- `aggregate.delta.wallclock_ms > 0` means the `akm` arm took longer on average

For the optional synthetic comparison:

- `aggregate.akm_over_synthetic_lift > 0`: AKM beat the self-notes baseline
- `aggregate.akm_over_synthetic_lift <= 0`: AKM did not beat the self-notes
  baseline on that run

For diagnostics:

- `perAsset` summarizes which AKM assets were loaded by `akm` runs
- `failure_modes` explains failed `akm` runs by label and task
- `negative_transfer_count` and `top_regressed_tasks` surface tasks where AKM
  regressed relative to `noakm`

## Current Implementation Notes

- Config-file mode is the recommended path for repeatable static runs.
- The checked-in config files named in `README.md` and
  `docs/reference-workflow.md` currently run only the `akm` arm because that is
  what their `arms` arrays specify.
- The legacy `utility` subcommand is still the simplest checked-in command for a
  paired `noakm` vs `akm` run.
