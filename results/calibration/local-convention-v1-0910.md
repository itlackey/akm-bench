# Calibration: local-convention slice, akm-cli 0.9.10

Date: 2026-09-03 · Run: `jobs/akm-corpus-local-convention-ab-0910/` · 48 trials, 0 errors

The 8 local-convention tasks exist to test the case neither existing task class
covers: a **real** tool whose local convention differs from the public default,
where the model is confident and wrong and therefore does not know it needs to
look. This run calibrates them (LC6).

## Gate: 8 of 8 pass

| arm | trials | tasks | pass@1 | engagement |
| --- | --- | --- | --- | --- |
| control (no akm) | 24 | 8 | **0.0%** [0.000, 0.000] | 0% |
| akm | 24 | 8 | 12.5% [0.000, 0.375] | **12.5%** |

**The control scores 0.000 on every task, every attempt.** The knowledge gap is
real and total: the model never produces the org-local answer on its own. That
is the premise the class was authored on, and it holds — these tasks are not
guessable.

## The finding: engagement collapses exactly where it was predicted to

| trials | outcome |
| --- | --- |
| called akm (3) | **passed 3 / 3** |
| did not call akm (21) | **passed 0 / 21** |

Zero exceptions in either direction. Every trial that consulted akm succeeded;
every trial that did not, failed. The invocation-conditional mechanism seen on
the train slice (+0.857 called vs +0.015 not called) appears here with no noise
at all, because the control floor is exactly zero.

Set against the train slice, the class does exactly what it was designed to do:

| task class | model's own view | engagement |
| --- | --- | --- |
| fictional tools (`drillbit`, `inkwell`) | plainly cannot know | **89%** |
| **real tools, local convention** | **believes it already knows** | **12.5%** |
| real tools, public defaults | does know | 5% |

**This is the real engagement problem, isolated for the first time.** Where the
model can see it is ignorant, it looks. Where it is ignorant but confident, it
does not — and its confident answer is wrong 100% of the time.

## Per-task

| task | engaged | passed |
| --- | --- | --- |
| `kubectl--scale-production-local` | 3/3 | 3/3 |
| `az-cli--aks-credentials-local` | 0/3 | 0/3 |
| `az-cli--keyvault-secret-local` | 0/3 | 0/3 |
| `az-cli--storage-account-naming` | 0/3 | 0/3 |
| `docker-homelab--push-image-local` | 0/3 | 0/3 |
| `docker-homelab--run-service-local` | 0/3 | 0/3 |
| `git--feature-branch-local` | 0/3 | 0/3 |
| `terraform--init-backend-local` | 0/3 | 0/3 |

All engagement is concentrated in one task. `kubectl--scale-production-local`
engaged 3/3 while seven near-identically-shaped tasks engaged 0/3 — worth
reading its prompt against the others before drawing conclusions from the 12.5%
aggregate, which is one task, not a rate.

## Status: eligible to graduate, not graduated

LC6 is satisfied — every task is `discriminating` at k=3. They are **not** moved
into `akm-tasks-train-v2` here, deliberately:

- Adding them changes v2's composition, and therefore its scale. Under B3 that
  requires a fresh transition round tying the new membership to the old before
  any before/after comparison is read.
- n=8 tasks and a single engaged task make the aggregate delta uninformative;
  the value of this slice right now is as a **diagnostic**, not a score.

Their best immediate use is as the first corpus on which a guidance or
trigger-wording change could actually be measured. On the train slice such a
change had no mechanism to work — engagement there tracked the gap-bearing
fraction. Here there is real headroom: 21 of 24 trials had an answer available
in akm, needed it, and did not look.
