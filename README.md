# akm-bench

`akm-bench` is a benchmark harness for measuring how an agent performs on the
same task set with AKM enabled.

It has three workflows:

- `utility`: static benchmark runs over a fixed task set
- `attribute`: per-asset attribution and leave-one-out masking on a saved utility report
- `evolve`: a longitudinal workflow that records feedback, accepts lint-clean proposals, and re-runs the eval slice to measure lesson reuse

This README is the fast path for running benchmarks. For the full reference,
see `docs/operator-guide.md`.

Part of the broader akm ecosystem:

- [itlackey/akm](https://github.com/itlackey/akm) -- the core Agent Kit Manager CLI
- [itlackey/akm-stash](https://github.com/itlackey/akm-stash) -- the official onboarding stash with ready-made skills, workflows, commands, and knowledge assets
- [itlackey/akm-registry](https://github.com/itlackey/akm-registry) -- the official searchable registry index used for discovery
- [itlackey/akm-plugins](https://github.com/itlackey/akm-plugins) -- optional editor and agent integrations, including OpenCode support

## What You Need

- `bun`
- `opencode`
- an opencode config that can access the model you want to benchmark

## Quick Start

1. Install dependencies.

```sh
bun install
```

2. Create a repo-local opencode config.

```sh
cp ~/.config/opencode.json ./config/opencode.local.json
```

This repo does not automatically read a global opencode config. That is
intentional so benchmark runs do not accidentally consume tokens from a paid or
metered setup.

3. Run the smallest benchmark.

```sh
bun run src/cli.ts config/nano-quick.json
```

Start with `config/nano-quick.json`. It is the fastest way to verify that your
setup works.

## Benchmark Workflows

`akm-bench` currently exposes one baseline workflow and two analysis workflows:

1. `utility` runs a fixed corpus and writes the canonical benchmark artifact.
2. `attribute` starts from a saved utility artifact and explains which AKM assets were loaded, then estimates marginal contribution by masking the top loaded assets one at a time.
3. `evolve` runs the train slice, records `akm feedback`, runs `akm distill` and `akm reflect`, accepts lint-clean proposals, re-indexes the stash, and re-runs the eval slice in `pre`, `post`, and `synthetic` conditions.

The saved report from `utility` is the input to `attribute`. The saved report
from `evolve` contains full utility-style envelopes for the `pre`, `post`, and
`synthetic` arms plus proposal, lesson, and feedback-integrity summaries.

## Reference Suite

This repo ships a versioned reference-suite definition in
`fixtures/reference/v1/README.md` plus a canonical run config at
`config/reference-suite-v1.json`.

- For the canonical reference suite, use `config/reference-suite-v1.json`.
- For a smaller smoke-style pinned suite, use `config/nano-quick.json`.
- For a broader pinned suite, use `config/full.json`.
- For temporal `evolve` runs, use one domain that already has both `train` and `eval` tasks. `drillbit` and `inkwell` are the clearest first-party examples.

Exact commands for static utility, attribution, and temporal evolve runs are in
`docs/reference-workflow.md`.

## Docker Quick Start

Run the benchmark in Docker and write reports to a host directory:

```sh
bash bin/akm-bench run config/nano-quick.json \
  --results-dir ./bench-results \
  --opencode-config ./config/opencode.local.json
```

Run against a specific published AKM version:

```sh
bash bin/akm-bench run config/nano-quick.json \
  --results-dir ./bench-results/akm-0.7.1 \
  --opencode-config ./config/opencode.local.json \
  --akm-mode version \
  --akm-version 0.7.1
```

Run against a local AKM checkout while contributing:

```sh
bash bin/akm-bench run config/nano-quick.json \
  --results-dir ./bench-results/local-source \
  --opencode-config ./config/opencode.local.json \
  --akm-mode source \
  --akm-source ../akm
```

Notes:

- The wrapper defaults to `--network host`.
- The image includes `opencode`, OpenAI support, and Antigravity auth support.
- Use `--env OPENAI_API_KEY` or `--env-file <path>` when your provider config references host secrets.
- Use `--opencode-home ~/.config/opencode` if you need to import Antigravity auth files into the container.

## Common Commands

Run the quick benchmark:

```sh
bun run src/cli.ts config/nano-quick.json
```

Run the larger benchmark:

```sh
bun run src/cli.ts config/full.json
```

Override seeds or parallelism:

```sh
bun run src/cli.ts config/nano-quick.json --seeds 3 --parallel 2
```

Write reports into a custom directory:

```sh
bun run src/cli.ts config/nano-quick.json --results-dir ./results/docker
```

Use a custom opencode config for one run:

```sh
bun run src/cli.ts config/nano-quick.json --opencode-config /path/to/opencode.json
```

Compare two saved reports:

```sh
bun run src/cli.ts compare --base results/baseline.json --current results/current.json
```

Compute per-asset attribution:

```sh
bun run src/cli.ts attribute --base results/current.json --top 5
```

Run the evolve workflow for one domain:

```sh
bun run src/cli.ts evolve --tasks drillbit --seeds 5
```

This requires a domain with both `train` and `eval` tasks. The runner uses the
train slice to accumulate feedback and generate proposals, then evaluates the
`pre`, `post`, and `synthetic` arms on the eval slice.

## Local Models

If you want to benchmark against a local model, use `config/opencode.local.json`.

The full setup guide for LM Studio and Ollama lives in `docs/operator-guide.md`.

LM Studio example:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "model": "lmstudio/qwen/qwen3.5-9b",
  "provider": {
    "lmstudio": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "LM Studio",
      "options": {
        "baseURL": "http://127.0.0.1:1234/v1",
        "timeout": 600000
      },
      "models": {
        "qwen/qwen3.5-9b": {
          "name": "Qwen3.5 9B",
          "limit": {
            "context": 32768,
            "output": 8192
          },
          "capabilities": {
            "tool": true
          }
        }
      }
    }
  }
}
```

Ollama example:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "model": "ollama/qwen3.5:9b",
  "provider": {
    "ollama": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Ollama",
      "options": {
        "baseURL": "http://127.0.0.1:11434/v1",
        "timeout": 600000
      },
      "models": {
        "qwen3.5:9b": {
          "name": "Qwen3.5 9B",
          "limit": {
            "context": 32768,
            "output": 8192
          },
          "capabilities": {
            "tool": true
          }
        }
      }
    }
  }
}
```

The top-level `model` must match `<provider-key>/<model-key>`, for example
`lmstudio/qwen/qwen3.5-9b` or `ollama/qwen3.5:9b`.

## Results

Successful runs write a timestamped JSON report into `results/` by default.

Override the output directory with `--results-dir <path>` or `BENCH_RESULTS_DIR`.

Report tracks written by the current CLI:

- `utility`: top-level aggregate, per-task metrics, `runs[]`, `perAsset`, and diagnostic blocks such as workflow, search-bridge, failure-modes, token coverage, and AKM overhead
- `attribute`: the saved `perAsset` table from the base utility report plus leave-one-out marginal contribution rows
- `evolve`: proposal-quality metrics, lesson metrics, feedback-integrity metrics, and embedded utility-style envelopes for `arms.pre`, `arms.post`, and `arms.synthetic`

Public documentation for these contracts lives in:

- `docs/reference-workflow.md`
- `docs/attribution-schema.md`
- `docs/lesson-lifecycle.md`

## Custom Benchmarks

Point the bench at a custom fixtures root that contains `corpus/` and
`stashes/`.

Local example:

```sh
bun run src/cli.ts /path/to/my-config.json \
  --fixtures-dir /path/to/my-fixtures \
  --opencode-config /path/to/opencode.json
```

Docker example:

```sh
bash bin/akm-bench run /path/to/my-config.json \
  --fixtures-dir /path/to/my-fixtures \
  --results-dir ./bench-results/custom \
  --opencode-config /path/to/opencode.json
```

See `docs/custom-benchmarks.md` for the expected directory layout, task and
stash examples, and authoring guidance.

Typical filename:

```text
results/bench-report-utility-main-<commit>-<timestamp>-<model>.json
```

## More Detail

See `docs/operator-guide.md` for:

- config discovery order
- custom benchmark authoring
- local provider setup notes
- repo layout
- tmp directory behavior
- test scope and verification commands

See `docs/custom-benchmarks.md` for building a custom `fixtures/` root with
your own tasks, stashes, workflows, and run configs.
