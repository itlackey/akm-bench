# akm-bench analysis report

Generated: 2026-08-25T11:22:04.284Z  
Jobs dir: `.an`  
Corpus dir: `harbor/tasks`  
Harbor version(s): unknown (no lock.json found)  
Jobs: 1 · Trials: 168 · Arms: 2 · Tasks: 28  
Bootstrap: seed=1337, resamples=10000, alpha=0.05

## Provenance

**Task checksum mismatches** (same task_name, different task_checksum — corpus may have drifted mid-run):
_No task checksum mismatches._

**Agent kwargs digest mismatches** (tripwire — `deriveArm()` folds this digest into the arm label, so any entry here means the label and the digest disagree):
_No agent kwargs digest mismatches._

**Corpus join:** 28 task(s) matched, 0 missing.

## Errored / null disclosure
Errored trials: 0 / 168
  - (none)
Non-errored trials with a missing reward (never folded into either policy): 0 / 168
  - (none)
Non-errored trials whose reward is present but NOT exactly 0 or 1 (decision D4's canonical shape; `pass@1` and Harbor's own `pass_at_k` cross-check both assume binary rewards): 0 / 168
  - (none)
Non-canonical reward keys observed (parsed into `otherRewards` on each trial record, but never aggregated or scored by this module — see the per-trial JSON for values): (none)
Tasks with no corpus metadata match: (none)

## Per-arm summary

| arm | errored policy | trials | tasks | pass@1 (95% CI over per-task means, n=tasks) | mean reward (95% CI over ATTEMPTS — pseudo-replicated, see note below table) |
| --- | --- | --- | --- | --- | --- |
| akm-opencode@1.18.21+akm-opencode@0.9.1202608250804//opencode/qwen3.5-plus#2de3bf5d | errored=0 | 84 | 28 | 85.7% [0.726, 0.964] (n=28, 10000 resamples, seed=1337) (28 tasks) | 0.857 [0.774, 0.929] (n=84, 10000 resamples, seed=1337) |
| akm-opencode@1.18.21+akm-opencode@0.9.1202608250804//opencode/qwen3.5-plus#2de3bf5d | errored excluded | 84 | 28 | 85.7% [0.726, 0.964] (n=28, 10000 resamples, seed=1337) (28 tasks) | 0.857 [0.774, 0.929] (n=84, 10000 resamples, seed=1337) |
| opencode@1.18.21//opencode/qwen3.5-plus#e3ff237c | errored=0 | 84 | 28 | 70.2% [0.536, 0.857] (n=28, 10000 resamples, seed=1337) (28 tasks) | 0.702 [0.595, 0.798] (n=84, 10000 resamples, seed=1337) |
| opencode@1.18.21//opencode/qwen3.5-plus#e3ff237c | errored excluded | 84 | 28 | 70.2% [0.536, 0.857] (n=28, 10000 resamples, seed=1337) (28 tasks) | 0.702 [0.595, 0.798] (n=84, 10000 resamples, seed=1337) |

_`pass@1`'s CI resamples per-task means (n = tasks) and is the interval to cite. `mean reward`'s CI resamples individual trial-level ATTEMPTS, which are correlated within a (task, arm) bucket when `n_attempts > 1` (same task, same difficulty, same environment) — that column is a within-arm attempt-level dispersion statistic, not an independence-based confidence interval, and its `n` counts attempts, not tasks. See `analysis/src/stats.ts`'s module docstring._

## Per-arm tokens / cost

| arm | trials | mean input tokens | mean cache tokens | mean output tokens | mean cost USD |
| --- | --- | --- | --- | --- | --- |
| akm-opencode@1.18.21+akm-opencode@0.9.1202608250804//opencode/qwen3.5-plus#2de3bf5d | 84 | 27367 (n=84, null=0) | 27346 (n=84, null=0) | 385 (n=84, null=0) | 0.0037 (n=84, null=0) |
| opencode@1.18.21//opencode/qwen3.5-plus#e3ff237c | 84 | 37088 (n=84, null=0) | 37066 (n=84, null=0) | 451 (n=84, null=0) | 0.0017 (n=84, null=0) |

## akm tool engagement

| arm | trials w/ trajectory | trials calling akm | engagement rate | mean akm calls | mean tool calls | akm tools used |
| --- | --- | --- | --- | --- | --- | --- |
| akm-opencode@1.18.21+akm-opencode@0.9.1202608250804//opencode/qwen3.5-plus#2de3bf5d | 84 (no trajectory: 0) | 21 | 25.0% | 0.65 | 2.98 | akm_show=26, akm_curate=21, akm_feedback=5, akm_search=3 |
| opencode@1.18.21//opencode/qwen3.5-plus#e3ff237c | 84 (no trajectory: 0) | 0 | 0.0% | 0.00 | 3.10 | — |

_Whether the model CHOSE to call an `akm_*` tool, counted from each trial's own opencode stdout trajectory — not from the plugin's event ledger, which records what the plugin offered rather than what the model used. Read this before any reward delta: an arm with a 0% engagement rate was never measured on retrieval at all, whatever it scored, and a treatment-vs-baseline difference there is a difference in injected context alone. Ignoring akm on a trivial task is expected; ignoring it on a task built to reward retrieval is itself the finding. `no trajectory` trials are excluded from the rate and reported separately rather than counted as zero._

## Arm vs. arm delta (paired by task, bootstrap CI)

| arms (A vs B) | errored policy | tasks paired | delta (A - B) | 95% CI | unpaired tasks |
| --- | --- | --- | --- | --- | --- |
| akm-opencode@1.18.21+akm-opencode@0.9.1202608250804//opencode/qwen3.5-plus#2de3bf5d vs opencode@1.18.21//opencode/qwen3.5-plus#e3ff237c | errored=0 | 28 | 0.155 | [0.024, 0.310] (n=28, 10000 resamples, seed=1337) | - |
| akm-opencode@1.18.21+akm-opencode@0.9.1202608250804//opencode/qwen3.5-plus#2de3bf5d vs opencode@1.18.21//opencode/qwen3.5-plus#e3ff237c | errored excluded | 28 | 0.155 | [0.024, 0.310] (n=28, 10000 resamples, seed=1337) | - |

## Arm vs. arm delta (symmetric exclusion: task dropped if EITHER arm had any errored trial)

_Neither `errored-as-zero` nor `errored-excluded` above is symmetric across arms: a harness/infrastructure failure that can only occur on ONE arm (e.g. a treatment-only run-phase proof) either scores that arm's task as 0 (errored-as-zero) or leaves the other arm's mean computed over all its trials while this arm's is computed over a non-random survivor subset (errored-excluded). This table drops the task from the comparison entirely instead — see `computeSymmetricPairedDelta` in `analysis/src/stats.ts`._

| arms (A vs B) | tasks paired | delta (A - B) | 95% CI | tasks excluded (either arm errored) | unpaired tasks |
| --- | --- | --- | --- | --- | --- |
| akm-opencode@1.18.21+akm-opencode@0.9.1202608250804//opencode/qwen3.5-plus#2de3bf5d vs opencode@1.18.21//opencode/qwen3.5-plus#e3ff237c | 28 | 0.155 | [0.024, 0.310] (n=28, 10000 resamples, seed=1337) | 0 | - |

## Per-task breakdown

| task | domain | slice | difficulty | memory_ability | arm | attempts | errored | missing reward | mean reward (errored=0) | mean reward (errored excluded) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| akm-bench/az-cli--aks-get-credentials | az-cli | train | easy | procedural_lookup | akm-opencode@1.18.21+akm-opencode@0.9.1202608250804//opencode/qwen3.5-plus#2de3bf5d | 3 | 0 | 0 | 1.000 | 1.000 |
| akm-bench/az-cli--aks-get-credentials | az-cli | train | easy | procedural_lookup | opencode@1.18.21//opencode/qwen3.5-plus#e3ff237c | 3 | 0 | 0 | 1.000 | 1.000 |
| akm-bench/az-cli--assign-managed-identity | az-cli | train | medium | procedural_lookup | akm-opencode@1.18.21+akm-opencode@0.9.1202608250804//opencode/qwen3.5-plus#2de3bf5d | 3 | 0 | 0 | 1.000 | 1.000 |
| akm-bench/az-cli--assign-managed-identity | az-cli | train | medium | procedural_lookup | opencode@1.18.21//opencode/qwen3.5-plus#e3ff237c | 3 | 0 | 0 | 1.000 | 1.000 |
| akm-bench/az-cli--create-resource-group | az-cli | train | easy | procedural_lookup | akm-opencode@1.18.21+akm-opencode@0.9.1202608250804//opencode/qwen3.5-plus#2de3bf5d | 3 | 0 | 0 | 1.000 | 1.000 |
| akm-bench/az-cli--create-resource-group | az-cli | train | easy | procedural_lookup | opencode@1.18.21//opencode/qwen3.5-plus#e3ff237c | 3 | 0 | 0 | 1.000 | 1.000 |
| akm-bench/az-cli--keyvault-secret-set | az-cli | train | easy | procedural_lookup | akm-opencode@1.18.21+akm-opencode@0.9.1202608250804//opencode/qwen3.5-plus#2de3bf5d | 3 | 0 | 0 | 1.000 | 1.000 |
| akm-bench/az-cli--keyvault-secret-set | az-cli | train | easy | procedural_lookup | opencode@1.18.21//opencode/qwen3.5-plus#e3ff237c | 3 | 0 | 0 | 1.000 | 1.000 |
| akm-bench/az-cli--query-by-tag | az-cli | train | easy | procedural_lookup | akm-opencode@1.18.21+akm-opencode@0.9.1202608250804//opencode/qwen3.5-plus#2de3bf5d | 3 | 0 | 0 | 1.000 | 1.000 |
| akm-bench/az-cli--query-by-tag | az-cli | train | easy | procedural_lookup | opencode@1.18.21//opencode/qwen3.5-plus#e3ff237c | 3 | 0 | 0 | 1.000 | 1.000 |
| akm-bench/az-cli--storage-account-create | az-cli | train | medium | procedural_lookup | akm-opencode@1.18.21+akm-opencode@0.9.1202608250804//opencode/qwen3.5-plus#2de3bf5d | 3 | 0 | 0 | 1.000 | 1.000 |
| akm-bench/az-cli--storage-account-create | az-cli | train | medium | procedural_lookup | opencode@1.18.21//opencode/qwen3.5-plus#e3ff237c | 3 | 0 | 0 | 1.000 | 1.000 |
| akm-bench/docker-homelab--bridge-network | docker-homelab | train | medium | procedural_lookup | akm-opencode@1.18.21+akm-opencode@0.9.1202608250804//opencode/qwen3.5-plus#2de3bf5d | 3 | 0 | 0 | 1.000 | 1.000 |
| akm-bench/docker-homelab--bridge-network | docker-homelab | train | medium | procedural_lookup | opencode@1.18.21//opencode/qwen3.5-plus#e3ff237c | 3 | 0 | 0 | 1.000 | 1.000 |
| akm-bench/docker-homelab--compose-version-upgrade | docker-homelab | train | medium | procedural_lookup | akm-opencode@1.18.21+akm-opencode@0.9.1202608250804//opencode/qwen3.5-plus#2de3bf5d | 3 | 0 | 0 | 1.000 | 1.000 |
| akm-bench/docker-homelab--compose-version-upgrade | docker-homelab | train | medium | procedural_lookup | opencode@1.18.21//opencode/qwen3.5-plus#e3ff237c | 3 | 0 | 0 | 1.000 | 1.000 |
| akm-bench/docker-homelab--env-from-file | docker-homelab | train | easy | procedural_lookup | akm-opencode@1.18.21+akm-opencode@0.9.1202608250804//opencode/qwen3.5-plus#2de3bf5d | 3 | 0 | 0 | 1.000 | 1.000 |
| akm-bench/docker-homelab--env-from-file | docker-homelab | train | easy | procedural_lookup | opencode@1.18.21//opencode/qwen3.5-plus#e3ff237c | 3 | 0 | 0 | 1.000 | 1.000 |
| akm-bench/docker-homelab--named-volume | docker-homelab | train | medium | procedural_lookup | akm-opencode@1.18.21+akm-opencode@0.9.1202608250804//opencode/qwen3.5-plus#2de3bf5d | 3 | 0 | 0 | 1.000 | 1.000 |
| akm-bench/docker-homelab--named-volume | docker-homelab | train | medium | procedural_lookup | opencode@1.18.21//opencode/qwen3.5-plus#e3ff237c | 3 | 0 | 0 | 1.000 | 1.000 |
| akm-bench/docker-homelab--redis-healthcheck | docker-homelab | train | easy | procedural_lookup | akm-opencode@1.18.21+akm-opencode@0.9.1202608250804//opencode/qwen3.5-plus#2de3bf5d | 3 | 0 | 0 | 1.000 | 1.000 |
| akm-bench/docker-homelab--redis-healthcheck | docker-homelab | train | easy | procedural_lookup | opencode@1.18.21//opencode/qwen3.5-plus#e3ff237c | 3 | 0 | 0 | 1.000 | 1.000 |
| akm-bench/docker-homelab--restart-policy | docker-homelab | train | easy | procedural_lookup | akm-opencode@1.18.21+akm-opencode@0.9.1202608250804//opencode/qwen3.5-plus#2de3bf5d | 3 | 0 | 0 | 1.000 | 1.000 |
| akm-bench/docker-homelab--restart-policy | docker-homelab | train | easy | procedural_lookup | opencode@1.18.21//opencode/qwen3.5-plus#e3ff237c | 3 | 0 | 0 | 1.000 | 1.000 |
| akm-bench/drillbit--backup-policy-train | drillbit | train | easy | procedural_lookup | akm-opencode@1.18.21+akm-opencode@0.9.1202608250804//opencode/qwen3.5-plus#2de3bf5d | 3 | 0 | 0 | 1.000 | 1.000 |
| akm-bench/drillbit--backup-policy-train | drillbit | train | easy | procedural_lookup | opencode@1.18.21//opencode/qwen3.5-plus#e3ff237c | 3 | 0 | 0 | 0.000 | 0.000 |
| akm-bench/drillbit--fix-runbook-train | drillbit | train | easy | procedural_lookup | akm-opencode@1.18.21+akm-opencode@0.9.1202608250804//opencode/qwen3.5-plus#2de3bf5d | 3 | 0 | 0 | 1.000 | 1.000 |
| akm-bench/drillbit--fix-runbook-train | drillbit | train | easy | procedural_lookup | opencode@1.18.21//opencode/qwen3.5-plus#e3ff237c | 3 | 0 | 0 | 0.000 | 0.000 |
| akm-bench/drillbit--scale-replicas-train | drillbit | train | easy | procedural_lookup | akm-opencode@1.18.21+akm-opencode@0.9.1202608250804//opencode/qwen3.5-plus#2de3bf5d | 3 | 0 | 0 | 1.000 | 1.000 |
| akm-bench/drillbit--scale-replicas-train | drillbit | train | easy | procedural_lookup | opencode@1.18.21//opencode/qwen3.5-plus#e3ff237c | 3 | 0 | 0 | 0.333 | 0.333 |
| akm-bench/inkwell--add-healthcheck-train | inkwell | train | easy | procedural_lookup | akm-opencode@1.18.21+akm-opencode@0.9.1202608250804//opencode/qwen3.5-plus#2de3bf5d | 3 | 0 | 0 | 0.000 | 0.000 |
| akm-bench/inkwell--add-healthcheck-train | inkwell | train | easy | procedural_lookup | opencode@1.18.21//opencode/qwen3.5-plus#e3ff237c | 3 | 0 | 0 | 0.000 | 0.000 |
| akm-bench/inkwell--new-service-scaled-train | inkwell | train | medium | multi_asset_composition | akm-opencode@1.18.21+akm-opencode@0.9.1202608250804//opencode/qwen3.5-plus#2de3bf5d | 3 | 0 | 0 | 1.000 | 1.000 |
| akm-bench/inkwell--new-service-scaled-train | inkwell | train | medium | multi_asset_composition | opencode@1.18.21//opencode/qwen3.5-plus#e3ff237c | 3 | 0 | 0 | 0.000 | 0.000 |
| akm-bench/inkwell--new-service-train | inkwell | train | easy | procedural_lookup | akm-opencode@1.18.21+akm-opencode@0.9.1202608250804//opencode/qwen3.5-plus#2de3bf5d | 3 | 0 | 0 | 1.000 | 1.000 |
| akm-bench/inkwell--new-service-train | inkwell | train | easy | procedural_lookup | opencode@1.18.21//opencode/qwen3.5-plus#e3ff237c | 3 | 0 | 0 | 0.000 | 0.000 |
| akm-bench/opencode--opencode-config-model | opencode | train | easy | procedural_lookup | akm-opencode@1.18.21+akm-opencode@0.9.1202608250804//opencode/qwen3.5-plus#2de3bf5d | 3 | 0 | 0 | 1.000 | 1.000 |
| akm-bench/opencode--opencode-config-model | opencode | train | easy | procedural_lookup | opencode@1.18.21//opencode/qwen3.5-plus#e3ff237c | 3 | 0 | 0 | 1.000 | 1.000 |
| akm-bench/opencode--system-prompt-snippet | opencode | train | easy | procedural_lookup | akm-opencode@1.18.21+akm-opencode@0.9.1202608250804//opencode/qwen3.5-plus#2de3bf5d | 3 | 0 | 0 | 1.000 | 1.000 |
| akm-bench/opencode--system-prompt-snippet | opencode | train | easy | procedural_lookup | opencode@1.18.21//opencode/qwen3.5-plus#e3ff237c | 3 | 0 | 0 | 1.000 | 1.000 |
| akm-bench/opencode--tool-allowlist | opencode | train | medium | procedural_lookup | akm-opencode@1.18.21+akm-opencode@0.9.1202608250804//opencode/qwen3.5-plus#2de3bf5d | 3 | 0 | 0 | 1.000 | 1.000 |
| akm-bench/opencode--tool-allowlist | opencode | train | medium | procedural_lookup | opencode@1.18.21//opencode/qwen3.5-plus#e3ff237c | 3 | 0 | 0 | 1.000 | 1.000 |
| akm-bench/reference--example-task | _example | train | easy | (no metadata) | akm-opencode@1.18.21+akm-opencode@0.9.1202608250804//opencode/qwen3.5-plus#2de3bf5d | 3 | 0 | 0 | 1.000 | 1.000 |
| akm-bench/reference--example-task | _example | train | easy | (no metadata) | opencode@1.18.21//opencode/qwen3.5-plus#e3ff237c | 3 | 0 | 0 | 1.000 | 1.000 |
| akm-bench/workflow-compliance--feedback-trap-az-tag-list | workflow-compliance | train | hard | procedural_lookup | akm-opencode@1.18.21+akm-opencode@0.9.1202608250804//opencode/qwen3.5-plus#2de3bf5d | 3 | 0 | 0 | 0.000 | 0.000 |
| akm-bench/workflow-compliance--feedback-trap-az-tag-list | workflow-compliance | train | hard | procedural_lookup | opencode@1.18.21//opencode/qwen3.5-plus#e3ff237c | 3 | 0 | 0 | 0.000 | 0.000 |
| akm-bench/workflow-compliance--feedback-trap-docker-compose-render | workflow-compliance | train | hard | noisy_retrieval | akm-opencode@1.18.21+akm-opencode@0.9.1202608250804//opencode/qwen3.5-plus#2de3bf5d | 3 | 0 | 0 | 0.333 | 0.333 |
| akm-bench/workflow-compliance--feedback-trap-docker-compose-render | workflow-compliance | train | hard | noisy_retrieval | opencode@1.18.21//opencode/qwen3.5-plus#e3ff237c | 3 | 0 | 0 | 0.667 | 0.667 |
| akm-bench/workflow-compliance--repeated-fail-opencode-provider-token-train | workflow-compliance | train | hard | procedural_lookup | akm-opencode@1.18.21+akm-opencode@0.9.1202608250804//opencode/qwen3.5-plus#2de3bf5d | 3 | 0 | 0 | 0.000 | 0.000 |
| akm-bench/workflow-compliance--repeated-fail-opencode-provider-token-train | workflow-compliance | train | hard | procedural_lookup | opencode@1.18.21//opencode/qwen3.5-plus#e3ff237c | 3 | 0 | 0 | 0.000 | 0.000 |
| akm-bench/workflow-compliance--repeated-fail-storage-lifecycle-a | workflow-compliance | train | hard | procedural_lookup | akm-opencode@1.18.21+akm-opencode@0.9.1202608250804//opencode/qwen3.5-plus#2de3bf5d | 3 | 0 | 0 | 1.000 | 1.000 |
| akm-bench/workflow-compliance--repeated-fail-storage-lifecycle-a | workflow-compliance | train | hard | procedural_lookup | opencode@1.18.21//opencode/qwen3.5-plus#e3ff237c | 3 | 0 | 0 | 1.000 | 1.000 |
| akm-bench/workflow-compliance--repeated-fail-storage-lifecycle-b | workflow-compliance | train | hard | procedural_lookup | akm-opencode@1.18.21+akm-opencode@0.9.1202608250804//opencode/qwen3.5-plus#2de3bf5d | 3 | 0 | 0 | 0.667 | 0.667 |
| akm-bench/workflow-compliance--repeated-fail-storage-lifecycle-b | workflow-compliance | train | hard | procedural_lookup | opencode@1.18.21//opencode/qwen3.5-plus#e3ff237c | 3 | 0 | 0 | 0.667 | 0.667 |
| akm-bench/workflow-compliance--tempting-shortcut-arithmetic | workflow-compliance | train | easy | procedural_lookup | akm-opencode@1.18.21+akm-opencode@0.9.1202608250804//opencode/qwen3.5-plus#2de3bf5d | 3 | 0 | 0 | 1.000 | 1.000 |
| akm-bench/workflow-compliance--tempting-shortcut-arithmetic | workflow-compliance | train | easy | procedural_lookup | opencode@1.18.21//opencode/qwen3.5-plus#e3ff237c | 3 | 0 | 0 | 1.000 | 1.000 |
