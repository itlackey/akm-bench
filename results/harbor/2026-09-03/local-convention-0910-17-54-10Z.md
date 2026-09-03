# akm-bench analysis report

Generated: 2026-09-03T18:40:39.829Z  
Jobs dir: `jobs/.analysis-akm-corpus-local-convention-ab-0910`  
Corpus dir: `harbor/tasks`  
Harbor version(s): 0.22.0  
Jobs: 1 · Trials: 48 · Arms: 2 · Tasks: 8  
Bootstrap: seed=1337, resamples=10000, alpha=0.05

## Provenance

**Task checksum mismatches** (same task_name, different task_checksum — corpus may have drifted mid-run):
_No task checksum mismatches._

**Agent kwargs digest mismatches** (tripwire — `deriveArm()` folds this digest into the arm label, so any entry here means the label and the digest disagree):
_No agent kwargs digest mismatches._

**Corpus join:** 8 task(s) matched, 0 missing.

## Errored / null disclosure
Errored trials: 0 / 48
  - (none)
Non-errored trials with a missing reward (never folded into either policy): 0 / 48
  - (none)
Non-errored trials whose reward is present but NOT exactly 0 or 1 (decision D4's canonical shape; `pass@1` and Harbor's own `pass_at_k` cross-check both assume binary rewards): 0 / 48
  - (none)
Non-canonical reward keys observed (parsed into `otherRewards` on each trial record, but never aggregated or scored by this module — see the per-trial JSON for values): (none)
Tasks with no corpus metadata match: (none)

## Per-arm summary

| arm | errored policy | trials | tasks | pass@1 (95% CI over per-task means, n=tasks) | mean reward (95% CI over ATTEMPTS — pseudo-replicated, see note below table) |
| --- | --- | --- | --- | --- | --- |
| akm-opencode@1.18.21+akm-opencode@0.9.9202609021827//opencode/qwen3.5-plus#2de3bf5d | errored=0 | 24 | 8 | 12.5% [0.000, 0.375] (n=8, 10000 resamples, seed=1337) (8 tasks) | 0.125 [0.000, 0.292] (n=24, 10000 resamples, seed=1337) |
| akm-opencode@1.18.21+akm-opencode@0.9.9202609021827//opencode/qwen3.5-plus#2de3bf5d | errored excluded | 24 | 8 | 12.5% [0.000, 0.375] (n=8, 10000 resamples, seed=1337) (8 tasks) | 0.125 [0.000, 0.292] (n=24, 10000 resamples, seed=1337) |
| opencode@1.18.21//opencode/qwen3.5-plus#e3ff237c | errored=0 | 24 | 8 | 0.0% [0.000, 0.000] (n=8, 10000 resamples, seed=1337) (8 tasks) | 0.000 [0.000, 0.000] (n=24, 10000 resamples, seed=1337) |
| opencode@1.18.21//opencode/qwen3.5-plus#e3ff237c | errored excluded | 24 | 8 | 0.0% [0.000, 0.000] (n=8, 10000 resamples, seed=1337) (8 tasks) | 0.000 [0.000, 0.000] (n=24, 10000 resamples, seed=1337) |

_`pass@1`'s CI resamples per-task means (n = tasks) and is the interval to cite. `mean reward`'s CI resamples individual trial-level ATTEMPTS, which are correlated within a (task, arm) bucket when `n_attempts > 1` (same task, same difficulty, same environment) — that column is a within-arm attempt-level dispersion statistic, not an independence-based confidence interval, and its `n` counts attempts, not tasks. See `analysis/src/stats.ts`'s module docstring._

## Per-arm tokens / cost

| arm | trials | mean input tokens | mean cache tokens | mean output tokens | mean cost USD |
| --- | --- | --- | --- | --- | --- |
| akm-opencode@1.18.21+akm-opencode@0.9.9202609021827//opencode/qwen3.5-plus#2de3bf5d | 24 | 29671 (n=24, null=0) | 29648 (n=24, null=0) | 449 (n=24, null=0) | 0.0038 (n=24, null=0) |
| opencode@1.18.21//opencode/qwen3.5-plus#e3ff237c | 24 | 35263 (n=24, null=0) | 35237 (n=24, null=0) | 505 (n=24, null=0) | 0.0016 (n=24, null=0) |

## akm tool engagement

| arm | trials w/ trajectory | trials calling akm | engagement rate | mean akm calls | mean tool calls | akm tools used |
| --- | --- | --- | --- | --- | --- | --- |
| akm-opencode@1.18.21+akm-opencode@0.9.9202609021827//opencode/qwen3.5-plus#2de3bf5d | 24 (no trajectory: 0) | 3 | 12.5% | 0.25 | 3.38 | akm_curate=3, akm_show=3 |
| opencode@1.18.21//opencode/qwen3.5-plus#e3ff237c | 24 (no trajectory: 0) | 0 | 0.0% | 0.00 | 4.25 | — |

_Whether the model CHOSE to call an `akm_*` tool, counted from each trial's own opencode stdout trajectory — not from the plugin's event ledger, which records what the plugin offered rather than what the model used. Read this before any reward delta: an arm with a 0% engagement rate was never measured on retrieval at all, whatever it scored, and a treatment-vs-baseline difference there is a difference in injected context alone. Ignoring akm on a trivial task is expected; ignoring it on a task built to reward retrieval is itself the finding. `no trajectory` trials are excluded from the rate and reported separately rather than counted as zero._

## Arm vs. arm delta (paired by task, bootstrap CI)

| arms (A vs B) | errored policy | tasks paired | delta (A - B) | 95% CI | unpaired tasks |
| --- | --- | --- | --- | --- | --- |
| akm-opencode@1.18.21+akm-opencode@0.9.9202609021827//opencode/qwen3.5-plus#2de3bf5d vs opencode@1.18.21//opencode/qwen3.5-plus#e3ff237c | errored=0 | 8 | 0.125 | [0.000, 0.375] (n=8, 10000 resamples, seed=1337) | - |
| akm-opencode@1.18.21+akm-opencode@0.9.9202609021827//opencode/qwen3.5-plus#2de3bf5d vs opencode@1.18.21//opencode/qwen3.5-plus#e3ff237c | errored excluded | 8 | 0.125 | [0.000, 0.375] (n=8, 10000 resamples, seed=1337) | - |

## Arm vs. arm delta (symmetric exclusion: task dropped if EITHER arm had any errored trial)

_Neither `errored-as-zero` nor `errored-excluded` above is symmetric across arms: a harness/infrastructure failure that can only occur on ONE arm (e.g. a treatment-only run-phase proof) either scores that arm's task as 0 (errored-as-zero) or leaves the other arm's mean computed over all its trials while this arm's is computed over a non-random survivor subset (errored-excluded). This table drops the task from the comparison entirely instead — see `computeSymmetricPairedDelta` in `analysis/src/stats.ts`._

| arms (A vs B) | tasks paired | delta (A - B) | 95% CI | tasks excluded (either arm errored) | unpaired tasks |
| --- | --- | --- | --- | --- | --- |
| akm-opencode@1.18.21+akm-opencode@0.9.9202609021827//opencode/qwen3.5-plus#2de3bf5d vs opencode@1.18.21//opencode/qwen3.5-plus#e3ff237c | 8 | 0.125 | [0.000, 0.375] (n=8, 10000 resamples, seed=1337) | 0 | - |

## Engagement-conditioned delta (treatment split by whether the model called akm)

Treatment trials: 3 called / 21 did not.

| arms (treatment vs control) | partition | tasks paired | delta | 95% CI |
| --- | --- | --- | --- | --- |
| akm-opencode@1.18.21+akm-opencode@0.9.9202609021827//opencode/qwen3.5-plus#2de3bf5d vs opencode@1.18.21//opencode/qwen3.5-plus#e3ff237c | akm WAS called | 1 | 1.000 | [1.000, 1.000] (n=1, 10000 resamples, seed=1337) |
| akm-opencode@1.18.21+akm-opencode@0.9.9202609021827//opencode/qwen3.5-plus#2de3bf5d vs opencode@1.18.21//opencode/qwen3.5-plus#e3ff237c | akm NOT called | 7 | 0.000 | [0.000, 0.000] (n=7, 10000 resamples, seed=1337) |

_The aggregate delta above blends two different things: trials where the model consulted akm and trials where it was merely offered. This table separates them, pairing each partition by task against the same, unpartitioned control arm. READ THE `tasks paired` COLUMN BEFORE THE MAGNITUDE — a task joins the `called` partition when ANY of its treatment trials invoked akm, so at realistic engagement rates that partition is a handful of tasks with a wide interval. This is a descriptive split of behaviour the model chose, NOT a randomised comparison: the partitions differ by whatever drove that choice (task shape, difficulty, phrasing) as well as by akm, so it cannot carry a causal claim on its own. Trials whose trajectory was unreadable are excluded from both partitions rather than assumed silent. See `computeEngagementConditionedDelta` in `analysis/src/stats.ts`._

## Per-task breakdown

| task | domain | slice | difficulty | memory_ability | arm | attempts | errored | missing reward | mean reward (errored=0) | mean reward (errored excluded) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| akm-bench/az-cli--aks-credentials-local | az-cli | local-convention-v1 | medium | local_convention_override | akm-opencode@1.18.21+akm-opencode@0.9.9202609021827//opencode/qwen3.5-plus#2de3bf5d | 3 | 0 | 0 | 0.000 | 0.000 |
| akm-bench/az-cli--aks-credentials-local | az-cli | local-convention-v1 | medium | local_convention_override | opencode@1.18.21//opencode/qwen3.5-plus#e3ff237c | 3 | 0 | 0 | 0.000 | 0.000 |
| akm-bench/az-cli--keyvault-secret-local | az-cli | local-convention-v1 | medium | local_convention_override | akm-opencode@1.18.21+akm-opencode@0.9.9202609021827//opencode/qwen3.5-plus#2de3bf5d | 3 | 0 | 0 | 0.000 | 0.000 |
| akm-bench/az-cli--keyvault-secret-local | az-cli | local-convention-v1 | medium | local_convention_override | opencode@1.18.21//opencode/qwen3.5-plus#e3ff237c | 3 | 0 | 0 | 0.000 | 0.000 |
| akm-bench/az-cli--storage-account-naming | az-cli | local-convention-v1 | medium | local_convention_override | akm-opencode@1.18.21+akm-opencode@0.9.9202609021827//opencode/qwen3.5-plus#2de3bf5d | 3 | 0 | 0 | 0.000 | 0.000 |
| akm-bench/az-cli--storage-account-naming | az-cli | local-convention-v1 | medium | local_convention_override | opencode@1.18.21//opencode/qwen3.5-plus#e3ff237c | 3 | 0 | 0 | 0.000 | 0.000 |
| akm-bench/docker-homelab--push-image-local | docker-homelab | local-convention-v1 | easy | local_convention_override | akm-opencode@1.18.21+akm-opencode@0.9.9202609021827//opencode/qwen3.5-plus#2de3bf5d | 3 | 0 | 0 | 0.000 | 0.000 |
| akm-bench/docker-homelab--push-image-local | docker-homelab | local-convention-v1 | easy | local_convention_override | opencode@1.18.21//opencode/qwen3.5-plus#e3ff237c | 3 | 0 | 0 | 0.000 | 0.000 |
| akm-bench/docker-homelab--run-service-local | docker-homelab | local-convention-v1 | medium | local_convention_override | akm-opencode@1.18.21+akm-opencode@0.9.9202609021827//opencode/qwen3.5-plus#2de3bf5d | 3 | 0 | 0 | 0.000 | 0.000 |
| akm-bench/docker-homelab--run-service-local | docker-homelab | local-convention-v1 | medium | local_convention_override | opencode@1.18.21//opencode/qwen3.5-plus#e3ff237c | 3 | 0 | 0 | 0.000 | 0.000 |
| akm-bench/git--feature-branch-local | git | local-convention-v1 | easy | local_convention_override | akm-opencode@1.18.21+akm-opencode@0.9.9202609021827//opencode/qwen3.5-plus#2de3bf5d | 3 | 0 | 0 | 0.000 | 0.000 |
| akm-bench/git--feature-branch-local | git | local-convention-v1 | easy | local_convention_override | opencode@1.18.21//opencode/qwen3.5-plus#e3ff237c | 3 | 0 | 0 | 0.000 | 0.000 |
| akm-bench/kubectl--scale-production-local | kubectl | local-convention-v1 | medium | local_convention_override | akm-opencode@1.18.21+akm-opencode@0.9.9202609021827//opencode/qwen3.5-plus#2de3bf5d | 3 | 0 | 0 | 1.000 | 1.000 |
| akm-bench/kubectl--scale-production-local | kubectl | local-convention-v1 | medium | local_convention_override | opencode@1.18.21//opencode/qwen3.5-plus#e3ff237c | 3 | 0 | 0 | 0.000 | 0.000 |
| akm-bench/terraform--init-backend-local | terraform | local-convention-v1 | easy | local_convention_override | akm-opencode@1.18.21+akm-opencode@0.9.9202609021827//opencode/qwen3.5-plus#2de3bf5d | 3 | 0 | 0 | 0.000 | 0.000 |
| akm-bench/terraform--init-backend-local | terraform | local-convention-v1 | easy | local_convention_override | opencode@1.18.21//opencode/qwen3.5-plus#e3ff237c | 3 | 0 | 0 | 0.000 | 0.000 |
