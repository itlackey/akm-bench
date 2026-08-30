# akm-bench analysis report

Generated: 2026-08-30T03:48:35.294Z  
Jobs dir: `jobs/.an093` (mirror of `jobs/akm-corpus-train-ab-093/`; `result.json` + `agent/opencode.txt` only)  
Corpus dir: `harbor/tasks`  
Harbor version(s): unknown (no lock.json found)  
Jobs: 1 · Trials: 168 · Arms: 2 · Tasks: 28  
Bootstrap: seed=1337, resamples=10000, alpha=0.05

## Retrain context (akm-093 re-measurement)

**Run:** `jobs/akm-corpus-train-ab-093/` — started 2026-08-29T17:50:16, finished
2026-08-29T20:50:57 (~3h01m). 168/168 trials completed, 0 errors, 1 retry.

**Stack measured:**

| component | version |
| --- | --- |
| akm-cli | 0.9.3 |
| akm-opencode plugin | 0.9.2202608290901 |
| opencode | 1.18.21 |
| model (both arms) | opencode/qwen3.5-plus |

**Config:** train slice (`harbor/jobs/corpus-train-ab.yaml`), 28 tasks, k=3,
168 trials. The treatment arm's `env` block in the job config is empty (no
`AKM_WRITE_GATE` set explicitly) — confirmed from the plugin's own event
ledger (`agent/opencode/xdg-state/akm-opencode/events.jsonl`,
`"event":"write_gate"`) that every trial actually ran with
`"mode":"observe"`, i.e. the plugin's own default resolves to observe when
unset. This matches the baseline's explicit `AKM_WRITE_GATE=observe`, so the
two runs are configuration-comparable.

**Why this run exists:** akm-plugins#97 rewrote the session-start trigger
wording because the prior measurement (this same train slice, plugin
0.9.1202608250804) showed the old wording ("before writing anything from
scratch") gated akm out of edit-shaped tasks. This is the first measurement
on the rewritten wording, at the same slice and write-gate setting as that
prior measurement — `results/harbor/2026-08-25/train-observe-stage1.md`.

**Baseline used for comparison:** `results/harbor/2026-08-25/train-observe-stage1.md`
(akm-cli 0.9.1, plugin 0.9.1202608250804, opencode 1.18.21, same 28-task
train slice, `AKM_WRITE_GATE=observe`). This pipeline reproduces that
baseline byte-for-byte (aside from the `Generated:`/`Jobs dir:` header
lines) from `jobs/akm-train-observe-stage1/`.

The headline eval-slice number some readers may recall (+0.439 delta, 75.4%
engagement, `results/harbor/2026-08-25/eval-enforce.md`) is **not** the
right comparison here — that run used the eval slice under
`AKM_WRITE_GATE=enforce`, a different slice and a different gate setting.
It is not reproduced or referenced further below.

### Side-by-side: baseline (2026-08-25) vs this run (2026-08-29)

| metric | baseline (plugin 0.9.1202608250804) | this run (plugin 0.9.2202608290901) |
| --- | --- | --- |
| control pass@1 | 70.2% [0.536, 0.857] (n=28 tasks) | 69.0% [0.524, 0.845] (n=28 tasks) |
| treatment pass@1 | 85.7% [0.726, 0.964] (n=28 tasks) | 85.7% [0.726, 0.964] (n=28 tasks) |
| paired delta (akm − control) | +0.155 [0.024, 0.310] | +0.167 [0.036, 0.321] |
| akm engagement rate (treatment trials calling any `akm_*` tool) | 25.0% (21/84) | 21.4% (18/84) |
| engagement-conditioned delta, **called** (ad hoc, see below) | +0.583 [0.250, 0.875] (n=8 tasks) | +0.778 [0.444, 1.000] (n=6 tasks) |
| engagement-conditioned delta, **not called** (ad hoc, see below) | −0.015 [−0.045, 0.000] (n=22 tasks) | 0.000 [−0.061, 0.061] (n=22 tasks) |

All CIs are 95%, paired-by-task bootstrap, seed=1337, 10000 resamples,
`errored-as-zero` policy (no errored trials in either run so this is
identical to `errored-excluded`).

**Engagement-conditioned split, method note:** the standard `akm-bench-analyze`
report (below) does not render this split as a table — it only reports the
overall per-arm engagement rate. The numbers above were computed with an ad
hoc script that reuses this pipeline's own exported `bucketByTaskArm` /
`summarizeTaskArmRewards` / `computePairedDelta` (`analysis/src/stats.ts`)
against the treatment arm's trials partitioned into "called an `akm_*` tool"
vs "did not", each paired by task against the same control arm. Both
per-task buckets are small (6-8 tasks for "called"), so the CIs are wide;
read the direction and magnitude, not the third decimal.

### Verdict: did #97's engagement-wording rewrite hold?

**No evidence of improvement, and a small (noise-level) drop in the raw
engagement count.** Engagement went from 21/84 (25.0%) trials calling an
`akm_*` tool under the old wording to 18/84 (21.4%) under the rewritten
wording — down 3 trials on an 84-trial sample. That is not a result to
build on; it is flat-to-slightly-down. The rewrite was made specifically to
fix under-engagement on edit-shaped tasks, and this measurement gives no
sign that it worked.

The overall reward effect held: paired delta +0.167 [0.036, 0.321] here vs
+0.155 [0.024, 0.310] at baseline — the two CIs overlap almost completely,
so there is no resolvable change in the aggregate effect at this sample
size (28 tasks × 3 attempts).

The mechanism itself replicates and, if anything, looks sharper in the raw
numbers: on tasks where the model actually called `akm_*`, the treatment
lift is large (+0.778 [0.444, 1.000], n=6 tasks) vs baseline's +0.583
[0.250, 0.875] (n=8 tasks); on tasks where it never called `akm_*`, the
lift is ~zero in both runs (0.000 [−0.061, 0.061] here vs −0.015 [−0.045,
0.000] at baseline). But treat that "sharper" language cautiously — the
called-bucket n dropped from 8 to 6 tasks alongside the lower engagement
rate, and both called-bucket CIs are wide enough ([0.444, 1.000] and
[0.250, 0.875]) that they are consistent with the same true effect. The one
number worth carrying forward plainly is the direction of the engagement
rate: it did not go up.

**Bottom line:** #97's rewrite has not been shown to help engagement on
this slice — the honest read is "held flat to slightly down," within
plausible run-to-run noise on a 28-task/84-trial slice, not an
improvement. This should go back to whoever is tracking #97, since the
wording change was justified on the strength of exactly this benchmark.

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
| akm-opencode@1.18.21+akm-opencode@0.9.2202608290901//opencode/qwen3.5-plus#2de3bf5d | errored=0 | 84 | 28 | 85.7% [0.726, 0.964] (n=28, 10000 resamples, seed=1337) (28 tasks) | 0.857 [0.774, 0.929] (n=84, 10000 resamples, seed=1337) |
| akm-opencode@1.18.21+akm-opencode@0.9.2202608290901//opencode/qwen3.5-plus#2de3bf5d | errored excluded | 84 | 28 | 85.7% [0.726, 0.964] (n=28, 10000 resamples, seed=1337) (28 tasks) | 0.857 [0.774, 0.929] (n=84, 10000 resamples, seed=1337) |
| opencode@1.18.21//opencode/qwen3.5-plus#e3ff237c | errored=0 | 84 | 28 | 69.0% [0.524, 0.845] (n=28, 10000 resamples, seed=1337) (28 tasks) | 0.690 [0.595, 0.786] (n=84, 10000 resamples, seed=1337) |
| opencode@1.18.21//opencode/qwen3.5-plus#e3ff237c | errored excluded | 84 | 28 | 69.0% [0.524, 0.845] (n=28, 10000 resamples, seed=1337) (28 tasks) | 0.690 [0.595, 0.786] (n=84, 10000 resamples, seed=1337) |

_`pass@1`'s CI resamples per-task means (n = tasks) and is the interval to cite. `mean reward`'s CI resamples individual trial-level ATTEMPTS, which are correlated within a (task, arm) bucket when `n_attempts > 1` (same task, same difficulty, same environment) — that column is a within-arm attempt-level dispersion statistic, not an independence-based confidence interval, and its `n` counts attempts, not tasks. See `analysis/src/stats.ts`'s module docstring._

## Per-arm tokens / cost

| arm | trials | mean input tokens | mean cache tokens | mean output tokens | mean cost USD |
| --- | --- | --- | --- | --- | --- |
| akm-opencode@1.18.21+akm-opencode@0.9.2202608290901//opencode/qwen3.5-plus#2de3bf5d | 84 | 27221 (n=84, null=0) | 27200 (n=84, null=0) | 381 (n=84, null=0) | 0.0037 (n=84, null=0) |
| opencode@1.18.21//opencode/qwen3.5-plus#e3ff237c | 84 | 28373 (n=84, null=0) | 28353 (n=84, null=0) | 409 (n=84, null=0) | 0.0013 (n=84, null=0) |

## akm tool engagement

| arm | trials w/ trajectory | trials calling akm | engagement rate | mean akm calls | mean tool calls | akm tools used |
| --- | --- | --- | --- | --- | --- | --- |
| akm-opencode@1.18.21+akm-opencode@0.9.2202608290901//opencode/qwen3.5-plus#2de3bf5d | 84 (no trajectory: 0) | 18 | 21.4% | 0.55 | 2.89 | akm_show=21, akm_curate=18, akm_feedback=5, akm_search=2 |
| opencode@1.18.21//opencode/qwen3.5-plus#e3ff237c | 84 (no trajectory: 0) | 0 | 0.0% | 0.00 | 2.79 | — |

_Whether the model CHOSE to call an `akm_*` tool, counted from each trial's own opencode stdout trajectory — not from the plugin's event ledger, which records what the plugin offered rather than what the model used. Read this before any reward delta: an arm with a 0% engagement rate was never measured on retrieval at all, whatever it scored, and a treatment-vs-baseline difference there is a difference in injected context alone. Ignoring akm on a trivial task is expected; ignoring it on a task built to reward retrieval is itself the finding. `no trajectory` trials are excluded from the rate and reported separately rather than counted as zero._

## Arm vs. arm delta (paired by task, bootstrap CI)

| arms (A vs B) | errored policy | tasks paired | delta (A - B) | 95% CI | unpaired tasks |
| --- | --- | --- | --- | --- | --- |
| akm-opencode@1.18.21+akm-opencode@0.9.2202608290901//opencode/qwen3.5-plus#2de3bf5d vs opencode@1.18.21//opencode/qwen3.5-plus#e3ff237c | errored=0 | 28 | 0.167 | [0.036, 0.321] (n=28, 10000 resamples, seed=1337) | - |
| akm-opencode@1.18.21+akm-opencode@0.9.2202608290901//opencode/qwen3.5-plus#2de3bf5d vs opencode@1.18.21//opencode/qwen3.5-plus#e3ff237c | errored excluded | 28 | 0.167 | [0.036, 0.321] (n=28, 10000 resamples, seed=1337) | - |

## Arm vs. arm delta (symmetric exclusion: task dropped if EITHER arm had any errored trial)

_Neither `errored-as-zero` nor `errored-excluded` above is symmetric across arms: a harness/infrastructure failure that can only occur on ONE arm (e.g. a treatment-only run-phase proof) either scores that arm's task as 0 (errored-as-zero) or leaves the other arm's mean computed over all its trials while this arm's is computed over a non-random survivor subset (errored-excluded). This table drops the task from the comparison entirely instead — see `computeSymmetricPairedDelta` in `analysis/src/stats.ts`._

| arms (A vs B) | tasks paired | delta (A - B) | 95% CI | tasks excluded (either arm errored) | unpaired tasks |
| --- | --- | --- | --- | --- | --- |
| akm-opencode@1.18.21+akm-opencode@0.9.2202608290901//opencode/qwen3.5-plus#2de3bf5d vs opencode@1.18.21//opencode/qwen3.5-plus#e3ff237c | 28 | 0.167 | [0.036, 0.321] (n=28, 10000 resamples, seed=1337) | 0 | - |

## Per-task breakdown

| task | domain | slice | difficulty | memory_ability | arm | attempts | errored | missing reward | mean reward (errored=0) | mean reward (errored excluded) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| akm-bench/az-cli--aks-get-credentials | az-cli | train | easy | procedural_lookup | akm-opencode@1.18.21+akm-opencode@0.9.2202608290901//opencode/qwen3.5-plus#2de3bf5d | 3 | 0 | 0 | 1.000 | 1.000 |
| akm-bench/az-cli--aks-get-credentials | az-cli | train | easy | procedural_lookup | opencode@1.18.21//opencode/qwen3.5-plus#e3ff237c | 3 | 0 | 0 | 1.000 | 1.000 |
| akm-bench/az-cli--assign-managed-identity | az-cli | train | medium | procedural_lookup | akm-opencode@1.18.21+akm-opencode@0.9.2202608290901//opencode/qwen3.5-plus#2de3bf5d | 3 | 0 | 0 | 1.000 | 1.000 |
| akm-bench/az-cli--assign-managed-identity | az-cli | train | medium | procedural_lookup | opencode@1.18.21//opencode/qwen3.5-plus#e3ff237c | 3 | 0 | 0 | 1.000 | 1.000 |
| akm-bench/az-cli--create-resource-group | az-cli | train | easy | procedural_lookup | akm-opencode@1.18.21+akm-opencode@0.9.2202608290901//opencode/qwen3.5-plus#2de3bf5d | 3 | 0 | 0 | 1.000 | 1.000 |
| akm-bench/az-cli--create-resource-group | az-cli | train | easy | procedural_lookup | opencode@1.18.21//opencode/qwen3.5-plus#e3ff237c | 3 | 0 | 0 | 1.000 | 1.000 |
| akm-bench/az-cli--keyvault-secret-set | az-cli | train | easy | procedural_lookup | akm-opencode@1.18.21+akm-opencode@0.9.2202608290901//opencode/qwen3.5-plus#2de3bf5d | 3 | 0 | 0 | 1.000 | 1.000 |
| akm-bench/az-cli--keyvault-secret-set | az-cli | train | easy | procedural_lookup | opencode@1.18.21//opencode/qwen3.5-plus#e3ff237c | 3 | 0 | 0 | 1.000 | 1.000 |
| akm-bench/az-cli--query-by-tag | az-cli | train | easy | procedural_lookup | akm-opencode@1.18.21+akm-opencode@0.9.2202608290901//opencode/qwen3.5-plus#2de3bf5d | 3 | 0 | 0 | 1.000 | 1.000 |
| akm-bench/az-cli--query-by-tag | az-cli | train | easy | procedural_lookup | opencode@1.18.21//opencode/qwen3.5-plus#e3ff237c | 3 | 0 | 0 | 1.000 | 1.000 |
| akm-bench/az-cli--storage-account-create | az-cli | train | medium | procedural_lookup | akm-opencode@1.18.21+akm-opencode@0.9.2202608290901//opencode/qwen3.5-plus#2de3bf5d | 3 | 0 | 0 | 1.000 | 1.000 |
| akm-bench/az-cli--storage-account-create | az-cli | train | medium | procedural_lookup | opencode@1.18.21//opencode/qwen3.5-plus#e3ff237c | 3 | 0 | 0 | 1.000 | 1.000 |
| akm-bench/docker-homelab--bridge-network | docker-homelab | train | medium | procedural_lookup | akm-opencode@1.18.21+akm-opencode@0.9.2202608290901//opencode/qwen3.5-plus#2de3bf5d | 3 | 0 | 0 | 1.000 | 1.000 |
| akm-bench/docker-homelab--bridge-network | docker-homelab | train | medium | procedural_lookup | opencode@1.18.21//opencode/qwen3.5-plus#e3ff237c | 3 | 0 | 0 | 1.000 | 1.000 |
| akm-bench/docker-homelab--compose-version-upgrade | docker-homelab | train | medium | procedural_lookup | akm-opencode@1.18.21+akm-opencode@0.9.2202608290901//opencode/qwen3.5-plus#2de3bf5d | 3 | 0 | 0 | 1.000 | 1.000 |
| akm-bench/docker-homelab--compose-version-upgrade | docker-homelab | train | medium | procedural_lookup | opencode@1.18.21//opencode/qwen3.5-plus#e3ff237c | 3 | 0 | 0 | 1.000 | 1.000 |
| akm-bench/docker-homelab--env-from-file | docker-homelab | train | easy | procedural_lookup | akm-opencode@1.18.21+akm-opencode@0.9.2202608290901//opencode/qwen3.5-plus#2de3bf5d | 3 | 0 | 0 | 1.000 | 1.000 |
| akm-bench/docker-homelab--env-from-file | docker-homelab | train | easy | procedural_lookup | opencode@1.18.21//opencode/qwen3.5-plus#e3ff237c | 3 | 0 | 0 | 1.000 | 1.000 |
| akm-bench/docker-homelab--named-volume | docker-homelab | train | medium | procedural_lookup | akm-opencode@1.18.21+akm-opencode@0.9.2202608290901//opencode/qwen3.5-plus#2de3bf5d | 3 | 0 | 0 | 1.000 | 1.000 |
| akm-bench/docker-homelab--named-volume | docker-homelab | train | medium | procedural_lookup | opencode@1.18.21//opencode/qwen3.5-plus#e3ff237c | 3 | 0 | 0 | 1.000 | 1.000 |
| akm-bench/docker-homelab--redis-healthcheck | docker-homelab | train | easy | procedural_lookup | akm-opencode@1.18.21+akm-opencode@0.9.2202608290901//opencode/qwen3.5-plus#2de3bf5d | 3 | 0 | 0 | 1.000 | 1.000 |
| akm-bench/docker-homelab--redis-healthcheck | docker-homelab | train | easy | procedural_lookup | opencode@1.18.21//opencode/qwen3.5-plus#e3ff237c | 3 | 0 | 0 | 1.000 | 1.000 |
| akm-bench/docker-homelab--restart-policy | docker-homelab | train | easy | procedural_lookup | akm-opencode@1.18.21+akm-opencode@0.9.2202608290901//opencode/qwen3.5-plus#2de3bf5d | 3 | 0 | 0 | 1.000 | 1.000 |
| akm-bench/docker-homelab--restart-policy | docker-homelab | train | easy | procedural_lookup | opencode@1.18.21//opencode/qwen3.5-plus#e3ff237c | 3 | 0 | 0 | 1.000 | 1.000 |
| akm-bench/drillbit--backup-policy-train | drillbit | train | easy | procedural_lookup | akm-opencode@1.18.21+akm-opencode@0.9.2202608290901//opencode/qwen3.5-plus#2de3bf5d | 3 | 0 | 0 | 1.000 | 1.000 |
| akm-bench/drillbit--backup-policy-train | drillbit | train | easy | procedural_lookup | opencode@1.18.21//opencode/qwen3.5-plus#e3ff237c | 3 | 0 | 0 | 0.000 | 0.000 |
| akm-bench/drillbit--fix-runbook-train | drillbit | train | easy | procedural_lookup | akm-opencode@1.18.21+akm-opencode@0.9.2202608290901//opencode/qwen3.5-plus#2de3bf5d | 3 | 0 | 0 | 1.000 | 1.000 |
| akm-bench/drillbit--fix-runbook-train | drillbit | train | easy | procedural_lookup | opencode@1.18.21//opencode/qwen3.5-plus#e3ff237c | 3 | 0 | 0 | 0.000 | 0.000 |
| akm-bench/drillbit--scale-replicas-train | drillbit | train | easy | procedural_lookup | akm-opencode@1.18.21+akm-opencode@0.9.2202608290901//opencode/qwen3.5-plus#2de3bf5d | 3 | 0 | 0 | 1.000 | 1.000 |
| akm-bench/drillbit--scale-replicas-train | drillbit | train | easy | procedural_lookup | opencode@1.18.21//opencode/qwen3.5-plus#e3ff237c | 3 | 0 | 0 | 0.333 | 0.333 |
| akm-bench/inkwell--add-healthcheck-train | inkwell | train | easy | procedural_lookup | akm-opencode@1.18.21+akm-opencode@0.9.2202608290901//opencode/qwen3.5-plus#2de3bf5d | 3 | 0 | 0 | 0.000 | 0.000 |
| akm-bench/inkwell--add-healthcheck-train | inkwell | train | easy | procedural_lookup | opencode@1.18.21//opencode/qwen3.5-plus#e3ff237c | 3 | 0 | 0 | 0.333 | 0.333 |
| akm-bench/inkwell--new-service-scaled-train | inkwell | train | medium | multi_asset_composition | akm-opencode@1.18.21+akm-opencode@0.9.2202608290901//opencode/qwen3.5-plus#2de3bf5d | 3 | 0 | 0 | 1.000 | 1.000 |
| akm-bench/inkwell--new-service-scaled-train | inkwell | train | medium | multi_asset_composition | opencode@1.18.21//opencode/qwen3.5-plus#e3ff237c | 3 | 0 | 0 | 0.000 | 0.000 |
| akm-bench/inkwell--new-service-train | inkwell | train | easy | procedural_lookup | akm-opencode@1.18.21+akm-opencode@0.9.2202608290901//opencode/qwen3.5-plus#2de3bf5d | 3 | 0 | 0 | 1.000 | 1.000 |
| akm-bench/inkwell--new-service-train | inkwell | train | easy | procedural_lookup | opencode@1.18.21//opencode/qwen3.5-plus#e3ff237c | 3 | 0 | 0 | 0.000 | 0.000 |
| akm-bench/opencode--opencode-config-model | opencode | train | easy | procedural_lookup | akm-opencode@1.18.21+akm-opencode@0.9.2202608290901//opencode/qwen3.5-plus#2de3bf5d | 3 | 0 | 0 | 1.000 | 1.000 |
| akm-bench/opencode--opencode-config-model | opencode | train | easy | procedural_lookup | opencode@1.18.21//opencode/qwen3.5-plus#e3ff237c | 3 | 0 | 0 | 1.000 | 1.000 |
| akm-bench/opencode--system-prompt-snippet | opencode | train | easy | procedural_lookup | akm-opencode@1.18.21+akm-opencode@0.9.2202608290901//opencode/qwen3.5-plus#2de3bf5d | 3 | 0 | 0 | 1.000 | 1.000 |
| akm-bench/opencode--system-prompt-snippet | opencode | train | easy | procedural_lookup | opencode@1.18.21//opencode/qwen3.5-plus#e3ff237c | 3 | 0 | 0 | 1.000 | 1.000 |
| akm-bench/opencode--tool-allowlist | opencode | train | medium | procedural_lookup | akm-opencode@1.18.21+akm-opencode@0.9.2202608290901//opencode/qwen3.5-plus#2de3bf5d | 3 | 0 | 0 | 1.000 | 1.000 |
| akm-bench/opencode--tool-allowlist | opencode | train | medium | procedural_lookup | opencode@1.18.21//opencode/qwen3.5-plus#e3ff237c | 3 | 0 | 0 | 1.000 | 1.000 |
| akm-bench/reference--example-task | _example | train | easy | (no metadata) | akm-opencode@1.18.21+akm-opencode@0.9.2202608290901//opencode/qwen3.5-plus#2de3bf5d | 3 | 0 | 0 | 1.000 | 1.000 |
| akm-bench/reference--example-task | _example | train | easy | (no metadata) | opencode@1.18.21//opencode/qwen3.5-plus#e3ff237c | 3 | 0 | 0 | 1.000 | 1.000 |
| akm-bench/workflow-compliance--feedback-trap-az-tag-list | workflow-compliance | train | hard | procedural_lookup | akm-opencode@1.18.21+akm-opencode@0.9.2202608290901//opencode/qwen3.5-plus#2de3bf5d | 3 | 0 | 0 | 0.000 | 0.000 |
| akm-bench/workflow-compliance--feedback-trap-az-tag-list | workflow-compliance | train | hard | procedural_lookup | opencode@1.18.21//opencode/qwen3.5-plus#e3ff237c | 3 | 0 | 0 | 0.000 | 0.000 |
| akm-bench/workflow-compliance--feedback-trap-docker-compose-render | workflow-compliance | train | hard | noisy_retrieval | akm-opencode@1.18.21+akm-opencode@0.9.2202608290901//opencode/qwen3.5-plus#2de3bf5d | 3 | 0 | 0 | 0.667 | 0.667 |
| akm-bench/workflow-compliance--feedback-trap-docker-compose-render | workflow-compliance | train | hard | noisy_retrieval | opencode@1.18.21//opencode/qwen3.5-plus#e3ff237c | 3 | 0 | 0 | 0.333 | 0.333 |
| akm-bench/workflow-compliance--repeated-fail-opencode-provider-token-train | workflow-compliance | train | hard | procedural_lookup | akm-opencode@1.18.21+akm-opencode@0.9.2202608290901//opencode/qwen3.5-plus#2de3bf5d | 3 | 0 | 0 | 0.000 | 0.000 |
| akm-bench/workflow-compliance--repeated-fail-opencode-provider-token-train | workflow-compliance | train | hard | procedural_lookup | opencode@1.18.21//opencode/qwen3.5-plus#e3ff237c | 3 | 0 | 0 | 0.000 | 0.000 |
| akm-bench/workflow-compliance--repeated-fail-storage-lifecycle-a | workflow-compliance | train | hard | procedural_lookup | akm-opencode@1.18.21+akm-opencode@0.9.2202608290901//opencode/qwen3.5-plus#2de3bf5d | 3 | 0 | 0 | 0.667 | 0.667 |
| akm-bench/workflow-compliance--repeated-fail-storage-lifecycle-a | workflow-compliance | train | hard | procedural_lookup | opencode@1.18.21//opencode/qwen3.5-plus#e3ff237c | 3 | 0 | 0 | 0.333 | 0.333 |
| akm-bench/workflow-compliance--repeated-fail-storage-lifecycle-b | workflow-compliance | train | hard | procedural_lookup | akm-opencode@1.18.21+akm-opencode@0.9.2202608290901//opencode/qwen3.5-plus#2de3bf5d | 3 | 0 | 0 | 0.667 | 0.667 |
| akm-bench/workflow-compliance--repeated-fail-storage-lifecycle-b | workflow-compliance | train | hard | procedural_lookup | opencode@1.18.21//opencode/qwen3.5-plus#e3ff237c | 3 | 0 | 0 | 1.000 | 1.000 |
| akm-bench/workflow-compliance--tempting-shortcut-arithmetic | workflow-compliance | train | easy | procedural_lookup | akm-opencode@1.18.21+akm-opencode@0.9.2202608290901//opencode/qwen3.5-plus#2de3bf5d | 3 | 0 | 0 | 1.000 | 1.000 |
| akm-bench/workflow-compliance--tempting-shortcut-arithmetic | workflow-compliance | train | easy | procedural_lookup | opencode@1.18.21//opencode/qwen3.5-plus#e3ff237c | 3 | 0 | 0 | 1.000 | 1.000 |
