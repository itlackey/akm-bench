# akm-bench

Benchmark-only repo for evaluating akm-assisted agent runs.

## Repo Map

| Path | Purpose |
| --- | --- |
| `src/` | Runtime harness, CLI, and the operator guide in `src/BENCH.md` |
| `fixtures/corpus/` | Benchmark inputs: task fixtures and workflow specs |
| `fixtures/stashes/` | Reusable fixture stashes loaded by corpus tasks and stash-loader tests |
| `configs/` | Run configs, provider config fixtures, and the config schema |
| `results/` | Checked-in baseline result snapshots |
| `tests/` | Harness and fixture-loader test files |

The corpus lives under `fixtures/corpus/tasks/<domain>/<task-id>/`.
Each task directory includes `task.yaml`, a `workspace/` seed, and a deterministic verifier.
Workflow-compliance tasks live alongside the other corpus domains; their workflow specs live under `fixtures/corpus/workflows/`.

## Run

```sh
bun install
bun test ./tests
bun run src/cli.ts configs/nano-quick.json
```

## Scope

- Keep repo-level orientation here.
- Keep harness/operator details in `src/BENCH.md`.
- Treat `fixtures/` as benchmark inputs, not operator docs.
