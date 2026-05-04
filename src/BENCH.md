# akm-bench Operator Guide

This repo contains the benchmark harness only. The harness measures whether
AKM changes how an agent performs on benchmark tasks.

## Layout

- Runtime harness code lives under `src/`.
- Harness tests live under `tests/`.
- Benchmark fixtures live under `fixtures/`.
- Run configs live under `configs/`.
- Checked-in baseline result snapshots live under `results/`.

Task fixtures live under `fixtures/corpus/tasks/<domain>/<task-id>/`.
Workflow specs live under `fixtures/corpus/workflows/`.
Fixture stashes live under `fixtures/stashes/`.
Committed provider fixtures live under `fixtures/corpus/opencode-providers.json`.

## Run

```sh
bun install
bun test ./tests
bun run src/cli.ts configs/nano-quick.json
```

Config-file mode is the preferred path. The committed configs are:

- `configs/nano-quick.json`
- `configs/full.json`
- `configs/failing-tasks.json`
- `configs/curate-test.json`

The run-config schema lives at `configs/bench-run-config.schema.json`.

## Provider Discovery

Provider resolution order is:

1. `--opencode-config <path>`
2. `BENCH_OPENCODE_CONFIG`
3. `fixtures/corpus/opencode-providers.local.json`
4. `fixtures/corpus/opencode-providers.json`
5. `${XDG_CONFIG_HOME:-~/.config}/akm/bench-providers.json`

Model resolution order is:

1. `BENCH_OPENCODE_MODEL`
2. config `defaultModel`
3. providers file `defaultModel`

Baseline result files referenced by configs live under `results/`.

## Tmp Root

All harness tmp directories live under `${AKM_CACHE_DIR}/bench/`, not `/tmp`.
Use `benchTmpRoot()` / `benchMkdtemp()` from `src/tmp.ts` for every harness tmp
directory. The invariant is enforced by `tests/no-os-tmpdir-invariant.test.ts`.

## Reports

Persistent run artifacts are written under `${AKM_CACHE_DIR}/bench-reports/`.
The report-stamping helpers live in `src/report.ts`, and `compare` / `attribute`
operate on those JSON envelopes.

## Test Scope

The default `bun test ./tests` run executes unit-focused coverage. Spawned CLI
integration tests in `tests/cli.test.ts` are skipped by default because they
materially slow the suite; opt in with:

```sh
AKM_BENCH_RUN_CLI_TESTS=1 bun test ./tests/cli.test.ts
```

This keeps the default verification loop fast while preserving the heavier
end-to-end coverage as an explicit check.
