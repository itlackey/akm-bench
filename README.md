# akm-bench

`akm-bench` is a benchmark harness for measuring how an agent performs on the
same task set with AKM enabled.

This README is the fast path for running benchmarks. For the full reference,
see `docs/operator-guide.md`.

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

## Docker

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
