# akm-bench

Standalone benchmark harness extracted from `itlackey/akm` for evaluating agent runs with and without akm assistance.

## Requirements

- `bun >= 1.0`
- `opencode` on `PATH`
- `BENCH_OPENCODE_MODEL` set, unless your providers file supplies `defaultModel`
- Python + `pytest` on `PATH` for tasks that use `verifier: pytest`

## Setup

```sh
bun install
cp tests/fixtures/bench/opencode-providers.json tests/fixtures/bench/opencode-providers.local.json
$EDITOR tests/fixtures/bench/opencode-providers.local.json
```

## Run

```sh
bun run tests/bench/cli.ts tests/bench/configs/nano-quick.json
bun run tests/bench/cli.ts tests/bench/configs/full.json --json > report.json
```

## Validation

```sh
bun run check
```

## Documentation

See `/home/runner/work/akm-bench/akm-bench/tests/bench/BENCH.md` for the full operator guide, configuration schema, fixtures, and workflow evaluation rules.
