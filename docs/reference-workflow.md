# Reference Workflow

This document gives the exact commands for the three benchmark workflows the
current codebase supports: static utility, attribution, and temporal evolve.

`akm-bench` ships a versioned reference-suite definition in
`fixtures/reference/v1/README.md` and a canonical run config in
`config/reference-suite-v1.json`.

## Inputs

Install dependencies once:

```sh
bun install
```

Use a repo-local opencode config:

```sh
cp ~/.config/opencode.json ./config/opencode.local.json
```

If you need to override the model at run time, set `BENCH_OPENCODE_MODEL`.

## Static Utility

Canonical reference suite using `config/reference-suite-v1.json`:

```sh
bun run src/cli.ts config/reference-suite-v1.json --results-dir ./results/reference/v1
```

Smaller pinned suite using `config/nano-quick.json`:

```sh
bun run src/cli.ts config/nano-quick.json --results-dir ./results/reference
```

Broader pinned suite using `config/full.json`:

```sh
bun run src/cli.ts config/full.json --results-dir ./results/reference
```

Legacy subcommand form with all three utility arms:

```sh
bun run src/cli.ts utility --tasks all --seeds 5 --include-synthetic --results-dir ./results/reference
```

Notes:

- Config-file mode is the recommended path for static utility runs.
- `config/reference-suite-v1.json` is the canonical checked-in config for the
  versioned reference suite.
- `config/nano-quick.json` and `config/full.json` currently run only the `akm`
  arm because that is what those checked-in config files specify.
- To get the `noakm` control arm, use the `utility` subcommand or create a run
  config whose `arms` include `noakm`.

## Attribution

Run attribution from a saved utility report:

```sh
bun run src/cli.ts attribute --base ./results/reference/<utility-report>.json --top 5
```

Example against a checked-in artifact:

```sh
bun run src/cli.ts attribute --base ./results/bench-report-utility-main-6229e9a-2026-05-05T23-29-38.867Z-shredder-qwen-qwen3.5-9b.json --top 5
```

What happens:

- `attribute` reads `perAsset` from the base utility artifact.
- It chooses the top `N` loaded assets.
- It re-runs the corpus with one asset masked at a time.
- It emits an `attribute` JSON report with both the source `perAsset` table and
  the leave-one-out `attributions[]` block.

## Temporal Evolve

Use a single domain that has both `train` and `eval` tasks. The clearest
checked-in domains are `drillbit` and `inkwell`.

`drillbit` evolve run:

```sh
bun run src/cli.ts evolve --tasks drillbit --seeds 5 --results-dir ./results/reference
```

`inkwell` evolve run:

```sh
bun run src/cli.ts evolve --tasks inkwell --seeds 5 --results-dir ./results/reference
```

Optional threshold overrides:

```sh
bun run src/cli.ts evolve --tasks drillbit --seeds 5 --negative-threshold-count 2 --negative-threshold-ratio 0.5 --results-dir ./results/reference
```

What happens:

1. Phase 1 runs the domain's `train` slice under the `akm` arm.
2. The runner dispatches `akm feedback <gold_ref> --positive|--negative` per
   non-`harness_error` result.
3. Assets that cross the negative threshold are sent through `akm distill` and
   `akm reflect`.
4. The runner inspects each proposal with `akm proposal show <id> --json`.
5. Lint-clean proposals are accepted with `akm proposal accept`; lint-failing
   proposals are rejected.
6. The stash is re-indexed with `akm index`.
7. The eval slice is re-run in three conditions:
   `arms.pre`, `arms.post`, and `arms.synthetic`.

The evolve report is a top-level `track: "evolve"` artifact. Its embedded
`arms.pre`, `arms.post`, and `arms.synthetic` blocks are utility-style reports.

## Reference Task Families

These checked-in tasks already match the current evolve split:

- `drillbit/backup-policy-train` and `drillbit/backup-policy`
- `drillbit/scale-replicas-train` and `drillbit/scale-replicas`
- `inkwell/add-healthcheck-train` and `inkwell/add-healthcheck`
- `inkwell/new-service-train` and `inkwell/new-service`

For `evolve`, prefer domains where the train and eval tasks share the same
`gold_ref` and `task_family` patterns, since that is what the current runner
uses to accumulate feedback and observe lesson reuse.
