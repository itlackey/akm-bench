# Custom Benchmarks

This guide explains how to create a custom benchmark corpus and custom AKM
stashes without editing the repo's built-in `fixtures/` tree.

The key mechanism is `--fixtures-dir <path>` or `BENCH_FIXTURES_DIR=<path>`.
That path becomes the root for all benchmark assets:

- `corpus/tasks/`
- `corpus/workflows/`
- `stashes/`

## Layout

Your custom fixtures root must contain both `corpus/` and `stashes/`.

```text
my-fixtures/
  corpus/
    tasks/
      my-domain/
        my-task/
          task.yaml
          workspace/
          verify.sh
    workflows/
      lookup-before-edit.yaml
  stashes/
    my-stash/
      MANIFEST.json
      skills/
      knowledge/
      commands/
      agents/
      scripts/
```

`corpus/workflows/` is optional.

## Stashes

Each stash lives under `stashes/<name>/` and must contain `MANIFEST.json`.

Minimal example:

```json
{
  "name": "my-stash",
  "description": "Custom stash for my benchmark tasks.",
  "purpose": "Benchmark a local AKM knowledge set.",
  "assets": { "skill": 1, "knowledge": 1, "command": 0, "agent": 0, "script": 0 },
  "consumers": ["my-domain/my-task"]
}
```

Add normal AKM assets under the usual directories, for example:

```text
stashes/my-stash/
  MANIFEST.json
  skills/
    deploy-checklist.md
  knowledge/
    architecture-notes.md
```

The benchmark harness copies and indexes the stash automatically during runs.

## Tasks

Each task lives at `corpus/tasks/<domain>/<task-id>/` and must include
`task.yaml`.

Example:

```yaml
id: my-domain/update-config
title: "Update the service config with a healthcheck"
domain: my-domain
difficulty: easy
slice: train
gold_ref: skill:deploy-checklist
stash: my-stash
verifier: script
budget:
  tokens: 15000
  wallMs: 120000
memory_ability: procedural_lookup
task_family: my-domain/config-basics
akm_keywords: "service config healthcheck"
```

Required fields:

- `id`: `<domain>/<task-name>`
- `title`
- `domain`
- `difficulty`: `easy|medium|hard`
- `stash`: stash directory name under `stashes/`
- `verifier`: `script|pytest|regex`
- `budget.tokens`
- `budget.wallMs`

Common optional fields:

- `slice`: `train|eval`
- `gold_ref`
- `expected_match`: required when `verifier: regex`
- `memory_ability`
- `task_family`
- `akm_keywords`

## Workspace

If your task needs files for the model to edit, create a `workspace/`
directory alongside `task.yaml`.

Example:

```text
corpus/tasks/my-domain/update-config/
  task.yaml
  workspace/
    README.md
    service.yaml
  verify.sh
```

The harness copies `workspace/` into a fresh tmp directory for each run.

## Verifiers

Use one of three verifier modes.

### `script`

Add `verify.sh` in the task directory.

Example:

```bash
#!/usr/bin/env bash
set -euo pipefail

grep -q "healthcheck:" service.yaml
```

### `pytest`

Add `tests/` in the task directory.

Example:

```text
corpus/tasks/my-domain/update-config/
  task.yaml
  workspace/
    service.yaml
  tests/
    test_service.py
```

```python
import pathlib


def test_healthcheck_present():
    text = pathlib.Path("service.yaml").read_text()
    assert "healthcheck:" in text
```

### `regex`

Set `verifier: regex` and add `expected_match` to `task.yaml`.

Example:

```yaml
verifier: regex
expected_match: "DONE"
```

This checks the agent stdout, not workspace files.

## Workflow Specs

If you want workflow-compliance evaluation, add YAML specs under
`corpus/workflows/`.

This is optional. If you only want utility benchmarking, you can omit the
directory.

## Run Configs

Run configs do not need custom fields for custom fixtures. Keep them normal and
point the bench at your fixtures root with `--fixtures-dir`.

Example `my-config.json`:

```json
{
  "$schema": "./bench-run-config.schema.json",
  "schemaVersion": 1,
  "name": "custom-quick",
  "description": "Quick run against my custom fixtures.",
  "tasks": ["my-domain/update-config"],
  "arms": ["akm"],
  "seeds": 2,
  "budgetTokens": 15000,
  "budgetWallMs": 120000,
  "parallel": 1
}
```

You can also select:

- all tasks: `"tasks": "all"`
- one domain: `"tasks": "my-domain"`
- an explicit task list: `"tasks": ["my-domain/a", "my-domain/b"]`

## Opencode Configs

Your custom benchmark still uses the normal opencode config flow.

Common patterns:

- pass `--opencode-config /path/to/opencode.json`
- set `BENCH_OPENCODE_CONFIG=/path/to/opencode.json`
- put `opencodeConfigRef` in the run config

If your provider config uses env refs like `{env:OPENAI_API_KEY}`, make sure
the variable is set in the parent shell or passed through Docker.

## Running Custom Benchmarks

Local run:

```sh
bun run src/cli.ts /path/to/my-config.json \
  --fixtures-dir /path/to/my-fixtures \
  --opencode-config /path/to/opencode.json
```

With a custom results directory:

```sh
bun run src/cli.ts /path/to/my-config.json \
  --fixtures-dir /path/to/my-fixtures \
  --results-dir ./bench-results/custom \
  --opencode-config /path/to/opencode.json
```

Docker run:

```sh
bash bin/akm-bench run /path/to/my-config.json \
  --fixtures-dir /path/to/my-fixtures \
  --results-dir ./bench-results/custom \
  --opencode-config /path/to/opencode.json
```

Docker with local AKM source:

```sh
bash bin/akm-bench run /path/to/my-config.json \
  --fixtures-dir /path/to/my-fixtures \
  --results-dir ./bench-results/custom-source \
  --opencode-config /path/to/opencode.json \
  --akm-mode source \
  --akm-source ../akm
```

## Tips

- Start with one task and one stash.
- Use `verifier: script` first if you want the fastest setup.
- Keep stash names simple: letters, numbers, `.`, `_`, `-`.
- Put task-specific editable files in `workspace/`, not in the stash.
- Use `gold_ref` only when you know the intended asset.
- Use `akm_keywords` when you want benchmark prompts to search with stable,
  explicit terms instead of inferred domain words.

## Troubleshooting

`no tasks found`

- check `--fixtures-dir`
- check that `corpus/tasks/` exists
- check that each task has a valid `task.yaml`

`fixture "..." missing MANIFEST.json`

- check `stashes/<name>/MANIFEST.json`
- check that `task.yaml` uses the right `stash:` name

`task not found`

- check `id:` in `task.yaml`
- check the `tasks` selector in your run config

`harness_error` from verifier runtime

- make sure your verifier type matches the files you created
- `script` tasks need `verify.sh`
- `pytest` tasks need Python tests

## Related Docs

- `docs/operator-guide.md`
- `config/bench-run-config.schema.json`
- `README.md`
