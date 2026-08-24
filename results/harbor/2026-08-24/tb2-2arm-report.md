# akm-bench analysis report

Generated: 2026-08-24T10:10:48.238Z  
Jobs dir: `.analyze-tb2`  
Corpus dir: `terminal-bench`  
Harbor version(s): unknown (no lock.json found)  
Jobs: 1 · Trials: 60 · Arms: 2 · Tasks: 10  
Bootstrap: seed=1337, resamples=10000, alpha=0.05

## Provenance

**Task checksum mismatches** (same task_name, different task_checksum — corpus may have drifted mid-run):
_No task checksum mismatches._

**Agent kwargs digest mismatches** (tripwire — `deriveArm()` folds this digest into the arm label, so any entry here means the label and the digest disagree):
_No agent kwargs digest mismatches._

**Corpus join:** 10 task(s) matched, 0 missing.

## Errored / null disclosure
Errored trials: 43 / 60
  - `akm-opencode@1.18.21+akm-opencode@0.9.202808220049//opencode/mimo-v2.5-free#2de3bf5d`: 22
  - `opencode@1.18.21//opencode/mimo-v2.5-free#e3ff237c`: 21
Exception types: AgentTimeoutError=42, NonZeroAgentExitCodeError=1
Non-errored trials with a missing reward (never folded into either policy): 0 / 60
  - (none)
Non-errored trials whose reward is present but NOT exactly 0 or 1 (decision D4's canonical shape; `pass@1` and Harbor's own `pass_at_k` cross-check both assume binary rewards): 0 / 60
  - (none)
Non-canonical reward keys observed (parsed into `otherRewards` on each trial record, but never aggregated or scored by this module — see the per-trial JSON for values): (none)
Tasks with no corpus metadata match: (none)

## Per-arm summary

| arm | errored policy | trials | tasks | pass@1 (95% CI over per-task means, n=tasks) | mean reward (95% CI over ATTEMPTS — pseudo-replicated, see note below table) |
| --- | --- | --- | --- | --- | --- |
| akm-opencode@1.18.21+akm-opencode@0.9.202808220049//opencode/mimo-v2.5-free#2de3bf5d | errored=0 | 30 | 10 | 16.7% [0.067, 0.267] (n=10, 10000 resamples, seed=1337) (10 tasks) | 0.167 [0.033, 0.300] (n=30, 10000 resamples, seed=1337) |
| akm-opencode@1.18.21+akm-opencode@0.9.202808220049//opencode/mimo-v2.5-free#2de3bf5d | errored excluded | 30 | 10 | 62.5% [0.250, 0.875] (n=8, 10000 resamples, seed=1337) (8 tasks, 2 excluded) | 0.625 [0.250, 0.875] (n=8, 10000 resamples, seed=1337) |
| opencode@1.18.21//opencode/mimo-v2.5-free#e3ff237c | errored=0 | 30 | 10 | 16.7% [0.067, 0.267] (n=10, 10000 resamples, seed=1337) (10 tasks) | 0.167 [0.033, 0.300] (n=30, 10000 resamples, seed=1337) |
| opencode@1.18.21//opencode/mimo-v2.5-free#e3ff237c | errored excluded | 30 | 10 | 55.6% [0.222, 0.889] (n=9, 10000 resamples, seed=1337) (9 tasks, 1 excluded) | 0.556 [0.222, 0.889] (n=9, 10000 resamples, seed=1337) |

_`pass@1`'s CI resamples per-task means (n = tasks) and is the interval to cite. `mean reward`'s CI resamples individual trial-level ATTEMPTS, which are correlated within a (task, arm) bucket when `n_attempts > 1` (same task, same difficulty, same environment) — that column is a within-arm attempt-level dispersion statistic, not an independence-based confidence interval, and its `n` counts attempts, not tasks. See `analysis/src/stats.ts`'s module docstring._

## Per-arm tokens / cost

| arm | trials | mean input tokens | mean cache tokens | mean output tokens | mean cost USD |
| --- | --- | --- | --- | --- | --- |
| akm-opencode@1.18.21+akm-opencode@0.9.202808220049//opencode/mimo-v2.5-free#2de3bf5d | 30 | 694621 (n=9, null=21) | 655509 (n=9, null=21) | 29580 (n=9, null=21) | n/a (n=0, null=30) |
| opencode@1.18.21//opencode/mimo-v2.5-free#e3ff237c | 30 | 566462 (n=10, null=20) | 536934 (n=10, null=20) | 22497 (n=10, null=20) | n/a (n=0, null=30) |

## akm tool engagement

| arm | trials w/ trajectory | trials calling akm | engagement rate | mean akm calls | mean tool calls | akm tools used |
| --- | --- | --- | --- | --- | --- | --- |
| akm-opencode@1.18.21+akm-opencode@0.9.202808220049//opencode/mimo-v2.5-free#2de3bf5d | 30 (no trajectory: 0) | 1 | 3.3% | 0.07 | 7.13 | akm_curate=2 |
| opencode@1.18.21//opencode/mimo-v2.5-free#e3ff237c | 29 (no trajectory: 1) | 0 | 0.0% | 0.00 | 7.52 | — |

_Whether the model CHOSE to call an `akm_*` tool, counted from each trial's own opencode stdout trajectory — not from the plugin's event ledger, which records what the plugin offered rather than what the model used. Read this before any reward delta: an arm with a 0% engagement rate was never measured on retrieval at all, whatever it scored, and a treatment-vs-baseline difference there is a difference in injected context alone. Ignoring akm on a trivial task is expected; ignoring it on a task built to reward retrieval is itself the finding. `no trajectory` trials are excluded from the rate and reported separately rather than counted as zero._

## Arm vs. arm delta (paired by task, bootstrap CI)

| arms (A vs B) | errored policy | tasks paired | delta (A - B) | 95% CI | unpaired tasks |
| --- | --- | --- | --- | --- | --- |
| akm-opencode@1.18.21+akm-opencode@0.9.202808220049//opencode/mimo-v2.5-free#2de3bf5d vs opencode@1.18.21//opencode/mimo-v2.5-free#e3ff237c | errored=0 | 10 | 0.000 | [-0.100, 0.100] (n=10, 10000 resamples, seed=1337) | - |
| akm-opencode@1.18.21+akm-opencode@0.9.202808220049//opencode/mimo-v2.5-free#2de3bf5d vs opencode@1.18.21//opencode/mimo-v2.5-free#e3ff237c | errored excluded | 8 | 0.000 | [-0.375, 0.375] (n=8, 10000 resamples, seed=1337) | 0 only-A, 1 only-B |

## Arm vs. arm delta (symmetric exclusion: task dropped if EITHER arm had any errored trial)

_Neither `errored-as-zero` nor `errored-excluded` above is symmetric across arms: a harness/infrastructure failure that can only occur on ONE arm (e.g. a treatment-only run-phase proof) either scores that arm's task as 0 (errored-as-zero) or leaves the other arm's mean computed over all its trials while this arm's is computed over a non-random survivor subset (errored-excluded). This table drops the task from the comparison entirely instead — see `computeSymmetricPairedDelta` in `analysis/src/stats.ts`._

| arms (A vs B) | tasks paired | delta (A - B) | 95% CI | tasks excluded (either arm errored) | unpaired tasks |
| --- | --- | --- | --- | --- | --- |
| akm-opencode@1.18.21+akm-opencode@0.9.202808220049//opencode/mimo-v2.5-free#2de3bf5d vs opencode@1.18.21//opencode/mimo-v2.5-free#e3ff237c | 0 | n/a | n/a | 10 | - |

## Per-task breakdown

| task | domain | slice | difficulty | memory_ability | arm | attempts | errored | missing reward | mean reward (errored=0) | mean reward (errored excluded) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| break-filter-js-from-html | (no metadata) | (no metadata) | medium | (no metadata) | akm-opencode@1.18.21+akm-opencode@0.9.202808220049//opencode/mimo-v2.5-free#2de3bf5d | 3 | 2 | 0 | 0.333 | 1.000 |
| break-filter-js-from-html | (no metadata) | (no metadata) | medium | (no metadata) | opencode@1.18.21//opencode/mimo-v2.5-free#e3ff237c | 3 | 2 | 0 | 0.333 | 1.000 |
| gpt2-codegolf | (no metadata) | (no metadata) | hard | (no metadata) | akm-opencode@1.18.21+akm-opencode@0.9.202808220049//opencode/mimo-v2.5-free#2de3bf5d | 3 | 2 | 0 | 0.000 | 0.000 |
| gpt2-codegolf | (no metadata) | (no metadata) | hard | (no metadata) | opencode@1.18.21//opencode/mimo-v2.5-free#e3ff237c | 3 | 2 | 0 | 0.000 | 0.000 |
| largest-eigenval | (no metadata) | (no metadata) | medium | (no metadata) | akm-opencode@1.18.21+akm-opencode@0.9.202808220049//opencode/mimo-v2.5-free#2de3bf5d | 3 | 3 | 0 | 0.000 | n/a |
| largest-eigenval | (no metadata) | (no metadata) | medium | (no metadata) | opencode@1.18.21//opencode/mimo-v2.5-free#e3ff237c | 3 | 3 | 0 | 0.000 | n/a |
| llm-inference-batching-scheduler | (no metadata) | (no metadata) | hard | (no metadata) | akm-opencode@1.18.21+akm-opencode@0.9.202808220049//opencode/mimo-v2.5-free#2de3bf5d | 3 | 2 | 0 | 0.333 | 1.000 |
| llm-inference-batching-scheduler | (no metadata) | (no metadata) | hard | (no metadata) | opencode@1.18.21//opencode/mimo-v2.5-free#e3ff237c | 3 | 2 | 0 | 0.333 | 1.000 |
| log-summary-date-ranges | (no metadata) | (no metadata) | medium | (no metadata) | akm-opencode@1.18.21+akm-opencode@0.9.202808220049//opencode/mimo-v2.5-free#2de3bf5d | 3 | 2 | 0 | 0.000 | 0.000 |
| log-summary-date-ranges | (no metadata) | (no metadata) | medium | (no metadata) | opencode@1.18.21//opencode/mimo-v2.5-free#e3ff237c | 3 | 2 | 0 | 0.333 | 1.000 |
| merge-diff-arc-agi-task | (no metadata) | (no metadata) | medium | (no metadata) | akm-opencode@1.18.21+akm-opencode@0.9.202808220049//opencode/mimo-v2.5-free#2de3bf5d | 3 | 2 | 0 | 0.333 | 1.000 |
| merge-diff-arc-agi-task | (no metadata) | (no metadata) | medium | (no metadata) | opencode@1.18.21//opencode/mimo-v2.5-free#e3ff237c | 3 | 2 | 0 | 0.000 | 0.000 |
| pytorch-model-cli | (no metadata) | (no metadata) | medium | (no metadata) | akm-opencode@1.18.21+akm-opencode@0.9.202808220049//opencode/mimo-v2.5-free#2de3bf5d | 3 | 2 | 0 | 0.333 | 1.000 |
| pytorch-model-cli | (no metadata) | (no metadata) | medium | (no metadata) | opencode@1.18.21//opencode/mimo-v2.5-free#e3ff237c | 3 | 2 | 0 | 0.333 | 1.000 |
| reshard-c4-data | (no metadata) | (no metadata) | medium | (no metadata) | akm-opencode@1.18.21+akm-opencode@0.9.202808220049//opencode/mimo-v2.5-free#2de3bf5d | 3 | 2 | 0 | 0.333 | 1.000 |
| reshard-c4-data | (no metadata) | (no metadata) | medium | (no metadata) | opencode@1.18.21//opencode/mimo-v2.5-free#e3ff237c | 3 | 2 | 0 | 0.333 | 1.000 |
| winning-avg-corewars | (no metadata) | (no metadata) | medium | (no metadata) | akm-opencode@1.18.21+akm-opencode@0.9.202808220049//opencode/mimo-v2.5-free#2de3bf5d | 3 | 2 | 0 | 0.000 | 0.000 |
| winning-avg-corewars | (no metadata) | (no metadata) | medium | (no metadata) | opencode@1.18.21//opencode/mimo-v2.5-free#e3ff237c | 3 | 2 | 0 | 0.000 | 0.000 |
| write-compressor | (no metadata) | (no metadata) | hard | (no metadata) | akm-opencode@1.18.21+akm-opencode@0.9.202808220049//opencode/mimo-v2.5-free#2de3bf5d | 3 | 3 | 0 | 0.000 | n/a |
| write-compressor | (no metadata) | (no metadata) | hard | (no metadata) | opencode@1.18.21//opencode/mimo-v2.5-free#e3ff237c | 3 | 2 | 0 | 0.000 | 0.000 |
