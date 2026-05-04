# akm-bench

Benchmark-only repo for evaluating akm-assisted agent runs.

## Repo Map

| Path | Purpose |
| --- | --- |
| `bench/` | Runtime harness, CLI, configs, baselines, and the operator guide in `bench/BENCH.md` |
| `corpus/` | Benchmark inputs: task fixtures, workflow specs, and provider fixtures |
| `stashes/` | Reusable fixture stashes loaded by corpus tasks and stash-loader tests |
| `test/` | Harness and fixture-loader test files |

The corpus lives under `corpus/tasks/<domain>/<task-id>/`.
Each task directory includes `task.yaml`, a `workspace/` seed, and a deterministic verifier.
Workflow-compliance tasks live alongside the other corpus domains; their workflow specs live under `corpus/workflows/`.

## Run

```sh
bun install
bun test ./test
bun run bench/cli.ts bench/configs/nano-quick.json
```

## Scope

- Keep repo-level orientation here.
- Keep harness/operator details in `bench/BENCH.md`.
- Treat `corpus/` and `stashes/` as benchmark inputs, not operator docs.
