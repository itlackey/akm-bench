# Transition round: v1 ↔ v2 scale, akm-cli 0.9.10

Date: 2026-09-03 · Source: `jobs/akm-corpus-train-ab-0910/` (168 trials)

`docs/comparability.md` B3 requires the two slices to be tied together by a
measured overlap before any v2 number is read against a v1 one. That overlap is
**exact here rather than approximate**: every v2 member is a byte-identical
re-reference to a v1 task directory, and the 0910 round ran all 28 v1 train
tasks — so both slice aggregates are computed from *the same trials*. No second
run, no cross-round variance, no model or version drift between the two scales.

| slice | tasks | control | akm | delta | engagement |
| --- | --- | --- | --- | --- | --- |
| v1 (`akm-tasks-train`) | 28 | 0.667 | 0.869 | **+0.202** | 19/84 (23%) |
| v2 (`akm-tasks-train-v2`) | 9 | **0.000** | 0.667 | **+0.667** | 19/27 (**70%**) |

## Reading it

**v2's larger delta is composition, not improvement.** Same akm build, same
trials, same agent — 3.3x the delta purely because v2 excludes the 19 tasks
whose control already passes and which therefore contribute ~zero. This is the
arithmetic the registry and job config warn about, now measured rather than
predicted. **A v2 figure may never be compared to a v1 figure without this
table.**

**v2's control is 0.000 across all 9 tasks.** That is the calibration gate
holding: on this slice the agent cannot succeed without akm, so the slice
measures akm rather than pretraining.

**Every engaged trial in the whole round is on a v2 task.** 19 of 84 treatment
trials engaged akm; all 19 fall inside v2's 27. Engagement is 70% where a
knowledge gap exists and **0% across all 19 excluded tasks** — the
corpus-composition finding, stated as cleanly as this corpus can state it. The
long-flat 21-23% aggregate engagement rate was never a plugin property; it was
19/84 ≈ the gap-bearing fraction.

## What this does not establish

- v2 has 9 tasks. Its delta's interval is wide; read the sign and rough
  magnitude.
- Passing the calibration gate is necessary, not sufficient. Three of v2's nine
  are `workflow-compliance` tasks whose control fails because they score a
  *behaviour*, not because akm is the sole source of a fact. The knowledge-gap
  principle's second half — the verifier asserts a stash-only value — is not
  checkable from run data.
- Neither figure is publishable beside a third-party benchmark (B1).
