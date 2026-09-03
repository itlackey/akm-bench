# akm-bench

`akm-bench` is a benchmark harness for measuring how an agent performs on the
same task set with AKM enabled.

> **These numbers are not publishable beside a third-party benchmark result.**
> This corpus is one we wrote, so a favourable result here is partly a
> statement about our own task authorship. It supports longitudinal claims
> (akm against itself, across versions) and nothing else; the comparison to
> other tools has to come from [`akm-eval`](https://github.com/itlackey/akm-eval).
> The rules, and the calibration gate showing that 19 of 28 train-slice tasks
> currently do not measure akm at all, are in
> [`docs/comparability.md`](./docs/comparability.md). Read it before quoting a
> figure from this repo. Run the gate yourself with
> `bin/akm-bench-calibrate <jobs-dir> --corpus harbor/tasks`.

It has three workflows:

- `utility`: static benchmark runs over a fixed task set
- `attribute`: per-asset attribution and leave-one-out masking on a saved utility report
- `evolve`: a longitudinal workflow that records feedback, accepts lint-clean proposals, and re-runs the eval slice to measure lesson reuse

This README is the fast path for running benchmarks. For the full reference,
see `docs/operator-guide.md`.

Part of the broader akm ecosystem:

- [itlackey/akm](https://github.com/itlackey/akm) -- the core Agent Knowledge Management CLI
- [itlackey/akm-stash](https://github.com/itlackey/akm-stash) -- the official onboarding stash with ready-made skills, workflows, commands, and knowledge assets
- [itlackey/akm-registry](https://github.com/itlackey/akm-registry) -- the official searchable registry index used for discovery
- [itlackey/akm-plugins](https://github.com/itlackey/akm-plugins) -- optional editor and agent integrations, including OpenCode support
- [itlackey/akm-eval](https://github.com/itlackey/akm-eval) -- eval framework for running benchmark packs through authoritative upstream harnesses

## Reproduce the published results

Everything in `results/` comes from these commands. Two credentials, one of
which `bin/ab-run` will load from `akm env` if you keep it there:
`OPENCODE_API_KEY` (both arms' model provider) and a running Docker daemon.

```sh
bin/ab-run train --dry-run       # render + preflight, run nothing
bin/ab-run train                 # 28-task train slice, 168 trials, ~3h
bin/ab-run train-v2              # 9-task calibrated slice
bin/ab-run local-convention      # 8-task candidate slice, 48 trials, ~45m
```

Each writes `results/harbor/<date>/<slice>-<pin>-<stamp>.{md,json,log}`. The
report includes the engagement-conditioned split, which is the number to read
before the aggregate — see `docs/comparability.md` B6.

**Check whether a slice can measure akm at all:**

```sh
bin/akm-bench-calibrate jobs/.analysis-<job-name>
```

Reports each task's no-skill control pass rate. A task whose control already
passes cannot measure akm, however carefully it is run. On the v1 train slice,
19 of 28 tasks fail this gate — they are disclosed by name in
`results/calibration/`, not hidden.

**Version pins** live in `harbor/akm_opencode.py` and nowhere else. Changing
them there is enough; `bin/ab-run` prints what it resolved and refuses to start
if the pinned `akm-cli` falls outside the pinned plugin's own compatibility
range, which would otherwise leave the plugin unloaded and score every treatment
trial as a baseline.

**Do not compare a v2 number to a v1 number** without
`results/calibration/transition-v1-v2-0910.md`. v2 excludes the tasks that
contribute ~zero, so its aggregate is arithmetically larger on the same build —
composition, not improvement.

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

CI note: GitHub Actions runs a deterministic spawned-CLI smoke against
`config/reference-suite-v1.json`, narrowed to one canonical task. That smoke
validates config dispatch and report generation, but it intentionally does not
require a live model or `opencode` binary, so it is not a true live benchmark
run.

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

Before utility/config/evolve runs, the CLI performs a fixture-index preflight.
Each unique fixture index is built once per fixture content + toolchain
fingerprint, then reused from cache on subsequent runs.

- Cache location: `${AKM_CACHE_DIR:-~/.cache/akm}/bench/fixture-indexes/`
- Fingerprint includes fixture content hash, AKM runtime identity/version, Bun
  version, and platform/arch
- Legacy `fixtures/stashes/*/__akm_index__/` is an optional transition fallback
  and is gitignored

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

## Harbor A/B (experimental, in progress)

Everything above describes the legacy Bun harness. Separately, we are re-basing
akm-bench on [Harbor](https://github.com/harbor-framework/harbor) so that akm can be
A/B'd inside standard benchmark task containers instead of a bespoke runner.

The first milestone (P0) is a Harbor custom agent that runs opencode **with the
akm-opencode plugin enabled**, so it can be compared against the stock
`opencode` agent on the same task:

- `harbor/akm_opencode.py` -- the custom agent (`harbor.akm_opencode:AkmOpenCode`)
- `harbor/jobs/p0-smoke.yaml` -- both arms, one task, one job
- `harbor/seed-library/` -- the smoke-fixture akm bundle seeded into the container
- `harbor/tests/` -- unit tests; no Docker, no network, no credentials

Set **`OPENCODE_API_KEY`** before running any Harbor job (`model_name:
opencode/...`) -- akm-eval's `OPENAI_API_KEY` is a different repo's variable
for a different consumer (its LongMemEval evaluator's own OpenAI client), not
this one's. See `docs/harbor-p0.md` prerequisite 3.

**This path has not been executed live yet.** Nothing below has run in a
container: it is Harbor 0.22.0 source reading plus host-side simulation. It does
not affect any of the workflows documented above.

P0 answers exactly one question -- "can the model reach `akm_*` tools inside a
task container" -- and is **not** evidence that akm improves task performance.
Two traps are worth knowing before you read any output:

- **Zero `akm_*` calls does not mean "the model chose not to use akm."** The
  plugin's failure paths are warn-only and exit 0, so a plugin that never loaded
  produces a green, akm-free trial that looks identical to a model that
  declined. The agent now raises `AkmPluginNotLoadedError` rather than scoring
  such a trial -- check that first.
- **The two arms are not identical containers with one flag flipped.** The
  runbook carries the full asymmetry list (warm-vs-cold opencode first boot,
  autoupdate mechanism, disk, setup wall-clock) and says which entries are the
  treatment and which are confounds.

See **`docs/harbor-p0.md`** for prerequisites, the exact commands, how to
confirm the model really called `akm_*` tools, the network-policy and
CLI-pinning caveats, and the list of things still unverified.

### Running a corpus A/B: `bin/ab-run`

The committed `harbor/jobs/corpus-*-ab.yaml` are templates carrying
`model_name: PROVIDER/MODEL` placeholders, so they are not directly runnable.
`bin/ab-run` renders a runnable copy, preflights, executes, and analyzes:

```sh
bin/ab-run train --dry-run     # render + preflight, run nothing
bin/ab-run train               # the real thing (~3h for 28 tasks x 2 arms x k=3)
bin/ab-run eval                # the slice whose number you report
```

`OPENCODE_API_KEY` does not need to be exported. When it is absent, `ab-run`
finds the akm env asset that holds it and re-execs itself under
`akm env run <ref> --only OPENCODE_API_KEY -- ...` — the injection path akm's
own help prescribes over sourcing the file, with `--only` keeping every other
credential in that asset out of the run's environment and out of the
containers harbor hands it to. Export the variable yourself and that path is
skipped.

It defaults both arms to `opencode/qwen3.5-plus` — the model every committed
report used — so a fresh run stays comparable by default. Version pins come
from `harbor/akm_opencode.py` and are printed in the banner; change them there,
never here.

It will not start without a reachable Docker daemon or a resolvable API key,
and it will not start on a stale plugin-compatibility mirror (below). Where a
run *can* safely proceed it does: a second run of the same slice and pin lands
in `jobs/<job_name>-r2/` rather than stopping to ask, because a fresh directory
per run is what keeps `akm-bench-analyze` — which walks the whole tree — from
pooling two runs into one meaningless statistic.

Each run writes `results/harbor/<date>/<slice>-<pin>-<stamp>.{md,json,log}`.

#### The plugin-compatibility cross-check

The pinned `akm-cli` must satisfy the pinned plugin's own `AKM_VERSION_RANGE`.
When it does not, the plugin quietly declines to load and **every treatment
trial scores as a baseline** — an A/B that measures nothing while looking
perfectly healthy for three hours. This cannot be caught in the container: by
then, the only observable fact is whether the CLI installed, not whether the
plugin will accept it. It is a cross-check between two pins, so it lives where
both are known:

- `harbor/akm_opencode.py` mirrors the range as
  `AKM_PLUGIN_REQUIRED_CLI_RANGE` and calls `assert_pins_compatible()` **at
  import**, so a bare `harbor run` is covered too, before any container is
  built. `harbor/tests/` covers it.
- `bin/ab-run` additionally reads the range out of the published plugin tarball
  before every run and fails if the mirrored copy has gone stale — the failure
  mode that actually happened, when the range moved `^0.9.0` → `^0.9.8` between
  plugin builds and nothing noticed.

The in-container shell guard remains a coarse "is this a 0.9.x at all" install
check; a POSIX glob cannot express `^0.9.8`, and it is no longer asked to.

### Three-arm A/B job configs (P2)

Past P0, the plan (`docs/plans/benchmark-harness-consolidation.md` §7 phase
P2) calls for standard-benchmark A/B job configs against two registry
datasets:

- `harbor/jobs/tb2-ab.yaml` -- `terminal-bench@2.0` (89 tasks)
- `harbor/jobs/swebench-ab.yaml` -- `swebench-verified@1.0` (500 tasks)

Both run **three arms** per decision D7
(`docs/plans/benchmark-harness-decisions.md`), not two:

1. **baseline** -- stock `opencode`, no plugin
2. **akm-static** -- `AkmOpenCode` with a pristine per-trial akm bundle
   (freshly seeded in every container)
3. **akm-accumulating** -- `AkmOpenCode` with `shared_bundle_path` pointed at
   a bundle mounted from the host and shared, mutable, **across trials**
   (`environment.mounts` in the job config; `n_concurrent: 1` on that arm
   specifically, since concurrent writers to the same bundle race)

Three arms isolates akm's *retrieval* value (akm-static) from its *learning*
value (akm-accumulating) -- at the cost of roughly tripling run count
relative to a two-arm A/B. Both files pin the same `opencode-ai` version and
the same `override_timeout_sec` / `override_setup_timeout_sec` across all
three arms deliberately: an asymmetric budget on only one arm is a confound,
not a convenience.

**Both files validate against Harbor's own `JobConfig` pydantic model** (with
`DeprecationWarning` promoted to an error) and construct real agent instances
through Harbor's `AgentFactory`, confirming all three arms resolve to
distinct `agent_info.name` values. Reproduce it yourself (no Docker, no
credentials):

```sh
PYTHONPATH="$(pwd)" python -c "
import warnings, yaml, pathlib
warnings.simplefilter('error', DeprecationWarning)
from harbor.models.job.config import JobConfig
from harbor.agents.factory import AgentFactory
from pathlib import Path

for f in ('harbor/jobs/tb2-ab.yaml', 'harbor/jobs/swebench-ab.yaml'):
    cfg = JobConfig.model_validate(yaml.safe_load(pathlib.Path(f).read_text()))
    names = [
        AgentFactory.create_agent_from_config(a, logs_dir=Path('/tmp/check')).to_agent_info().name
        for a in cfg.agents
    ]
    print(f, '->', names)
"
```

Expected output -- three distinct names per file, confirming decision D7's
static/accumulating separation holds end to end through Harbor's own config
resolution and agent construction, not just through this repo's unit tests:

```
harbor/jobs/tb2-ab.yaml -> ['opencode', 'akm-opencode', 'akm-opencode-accumulating']
harbor/jobs/swebench-ab.yaml -> ['opencode', 'akm-opencode', 'akm-opencode-accumulating']
```

Both files are otherwise unrun, in the same "read from source, not executed
live" state P0 was in before its first container run; treat a first real
invocation as a debugging session.

**Neither file is safe to run at full size without reading its cost warning
first.** `swebench-verified@1.0` is 500 tasks x 3 arms; subset with the
dataset block's `task_names:` / `n_tasks:`, the CLI's
`-i/-x/-l/--n-tasks` flags, or (if you're materializing task directories
yourself instead of pulling the registry entry) the swebench adapter's own
`--limit` flag -- see the COST WARNING block near the bottom of each yaml for
specifics.

One thing worth knowing before analyzing either file's output: Harbor's agent
identity is `(agent_info.name, agent_info.version)` and nothing else -- not
the class, not the import path, not the kwargs. akm-static and
akm-accumulating are the same class at the same pins, so `version()` is
identical on both, and a three-arm run would report as **two** arms unless
something makes the pair distinguishable. Two independent guards do, and both
are covered by tests:

1. `AkmOpenCode.arm_name()` -- with `shared_bundle_path` set, `to_agent_info()`
   reports `akm-opencode-accumulating` instead of `akm-opencode`, so the arms
   are distinct in every `result.json` and `trajectory.json`, and to Harbor's
   own groupings (its `evals` key, `JobStatistics`, the viewer's comparison
   grid, and the decision-D4 `pass_at_k` cross-check).
2. `deriveArm()` in `analysis/src/loader.ts` -- folds a digest of
   `config.agent.kwargs` into the arm label, so the arms stay apart in results
   written before guard 1 existed, and so any *future* kwarg that changes an
   arm without changing its name (`stash_root`, `akm_plugin_spec`,
   `seed_library_dir`, ...) splits correctly too.

Decision D7 requires this separation ("do not pool it with the static arm"):
pooled, the treatment mean is the average of a retrieval arm and a learning
arm and describes neither.

### Analysis CLI (in progress)

Harbor computes no pass@1, no confidence intervals, no significance tests,
and no cross-job comparison -- every statistic in an A/B report is code this
repo owns (plan §1.1, "thin wrapper is true of execution and false of
analysis"). That layer is `analysis/` (TypeScript, Bun), driven by:

```sh
bin/akm-bench-analyze <jobs-dir> [--corpus <tasks-dir>] [--json <out>] [--md <out>]
```

- `<jobs-dir>` is walked as `<jobs-dir>/<job>/<trial>/result.json` --
  **never** `<jobs-dir>/<job>/result.json`, which Harbor always writes with
  `trial_results` excluded (see the contract check below). Trial dirs are
  direct children of the job dir; there is no further nesting.
- `--corpus <tasks-dir>` left-joins each task's `task.toml` `[metadata]`
  onto its trials by `task_name` -- Harbor's own result JSON never carries
  task metadata at any level, so this join is the only way slice/domain/
  difficulty fields reach the report.
- With neither `--json` nor `--md` given, a markdown report prints to
  stdout; either flag (or both) writes that output to a file instead.
- Loader and corpus-join warnings (an unparseable `result.json`, a task
  named in a trial but missing from the corpus, ...) never abort the run --
  they print to stderr *and* fold into the report's own disclosure block, so
  the report is self-describing even when read outside a terminal.

The statistics it computes over Harbor's raw per-trial output: per-(task,
arm) bucketing (attempt-level pairing across arms is impossible -- Harbor's
`-k`/`n_attempts` records no attempt index, only a random trial-name suffix,
so "attempt 3 of baseline" cannot be matched to "attempt 3 of akm-static");
pass@1 (Harbor's own metric can't go below k=2 -- see the contract check
below) under an explicit errored-trial policy (Harbor's default `Mean`
metric silently folds an errored trial in as a `0`; this layer's policy is
declared, not implicit); per-arm reward mean and bootstrap confidence
interval; and a paired-by-task bootstrap delta between arms. The
akm-accumulating arm's trials are **not** i.i.d. samples (order matters: a
later trial can see everything an earlier one wrote to the shared bundle) --
do not pool its rows with akm-static's in any report that assumes
independence.

`analysis/` is under active, concurrent development in this tree; the CLI's
exact flags and report shape are the source of truth over this description
if the two ever drift -- run `bin/akm-bench-analyze --help` (or read
`analysis/src/cli.ts`) to check.

### Contract check: `bin/check-harbor-contract`

Every behavior the two sections above depend on is **undocumented, internal
Harbor implementation**, not a contract Harbor promises to keep across
releases. It was verified against Harbor v0.22.0 (commit `39b8587`), and this
script re-verifies all twelve against whatever Harbor is actually installed:

| # | Behavior | What breaks if it moves |
| --- | --- | --- |
| 1 | `harbor.__version__ == 0.22.0` | the D12 pin itself |
| 2 | `jobs/<job>/result.json` never carries `trial_results` | `loader.ts` walks trial dirs and skips the job file |
| 3 | `pass_at_k`'s k-set starts at 2 | pass@1 is unreachable through Harbor, so `stats.ts` computes it |
| 4 | `exclude_logs` applies after `include_logs` | no job config carries an `exclude_logs` that could hide the run-phase plugin proof |
| 5 | per-trial result file is `result.json` (singular; Harbor's own `TrialPaths` docstring says `results.json` and is stale) | `loader.ts` finds no trials |
| 6 | `opencode_config` layering: `_DEFAULT_CONFIG` &lt; auto-generated `provider`/`mcp` &lt; job-level, dicts recursing and lists replaced wholesale | `_force_config()`'s guarantee that a job cannot degrade the treatment arm |
| 7 | `task.toml [metadata]` never reaches `result.json` at any level | `corpus.ts`'s left-join is the only path for slice/domain/difficulty |
| 8 | agent output is synced **before** the verifier runs | `_assert_plugin_ran()` has no log to read; every treatment trial errors |
| 9 | verifier reads `/logs/verifier/reward.json` (probed first) or `reward.txt` | every converted task's `tests/test.sh` writes the wrong file |
| 10 | local task-dir scanning is exactly one level deep | the flat `harbor/tasks/<domain>--<id>/` layout is required, not cosmetic |
| 11 | `AgentInfo.model_info` splits `provider/<model>` into two fields | `deriveArm()` would emit `anthropic/anthropic/<model>` or drop the provider |
| 12 | trial dirs are direct children of `jobs/<job>/` (`trials_dir=job_dir`, `trial_dir=trials_dir/<trial_name>`) -- no per-task level | `loader.ts`'s two-level walk finds zero trials; every `<job>/*/result.json` glob breaks |

Each check is mutation-tested: breaking the behavior it describes turns that
one check -- and only that one -- red.

```sh
bin/check-harbor-contract                                    # uses python3 on PATH
HARBOR_PYTHON=/path/to/venv/bin/python bin/check-harbor-contract
```

Run it after any fresh install of `harbor/requirements.txt`, and before *and*
after any change to the pin in that file. It prints one `PASS`/`FAIL` line
per behavior with an actionable message naming exactly what to re-check if
that behavior moved, exits `0` only if every check passes, and never lets
one failing check stop the rest from running -- so a single invocation
surfaces everything that regressed, not just the first thing alphabetically.

### Version pin policy (decision D12)

`harbor/requirements.txt` pins `harbor==0.22.0` exactly -- a range is not
safe here, because the pin is standing in for a set of internal behaviors,
not a public API. **Bumping it is a two-step change, not a one-line edit:**

1. Update the pin in `harbor/requirements.txt`, reinstall, and run
   `bin/check-harbor-contract` against the new install. Every `FAIL` names
   what broke and what in this repo depends on it.
2. Fix whatever the contract check flagged (`harbor/akm_opencode.py`, the
   job configs, `analysis/`, or this README) *before* trusting a real
   `harbor run` against the new version -- then update
   `EXPECTED_HARBOR_VERSION` inside `bin/check-harbor-contract` itself so
   the check enforces the new pin going forward, not the old one.

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
