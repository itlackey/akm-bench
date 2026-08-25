---
name: incremental-change-discipline
description: Make the smallest change that could work, verify after every step, and revert immediately on regression instead of layering fix on top of fix — the discipline that keeps a debugging session or a multi-step refactor from spiraling.
tags: [incremental, small-change, small-steps, verify, revert, regression, discipline, safe-change]
searchHints:
  - "should I keep going or revert when a change makes it worse"
  - "how do I make a risky change safely"
  - "how do I make a large change safely"
  - "smallest change that could work"
  - "revert last change and verify baseline"
  - "made things worse after a change keep going or revert"
  - "verify after every step instead of batching changes"
  - "change made it worse not better"
  - "safest way to apply a risky fix"
  - "how big should one step of a change be"
when_to_use: "Before making any nontrivial change (a fix, a refactor, a migration) that could plausibly be done in one large step instead — decide the step size and the keep/amend/revert loop before starting, not partway through."
---

# Incremental-change discipline

The single biggest amplifier of debugging time is making several changes at
once and then trying to reason about their combined effect. Incremental
discipline trades a little speed per step for a large reduction in total
time, because every step stays verifiable.

## The core loop

1. Make the SMALLEST change that could plausibly move you toward a fix or
   toward more information — not the most complete-looking fix you can
   imagine.
2. Run the fastest available check that would reveal whether that change
   helped, hurt, or did nothing (ideally a single targeted test — see
   running-a-single-test-fast).
3. Read the actual result, not just pass/fail — did the SPECIFIC symptom
   change? A test that now fails differently is information, not the same
   as "no progress."
4. Decide explicitly: keep, revert, or amend — then repeat from step 1.

## Why "smallest change" beats "most complete fix"

- A large speculative change conflates several independent hypotheses. If
  it doesn't fully fix the issue, you don't know which PART helped, which
  was neutral, and which made things worse.
- A small change gives an unambiguous signal per step, which compounds:
  five small verified steps produce more reliable understanding than one
  large unverified leap, even though the large leap "looks" faster.
- If a small change fully fixes the issue, you're done faster than the
  large speculative version would have gotten you — you didn't need the
  extra scope.

## Verify after every step — don't batch

- Running the check after EVERY change, not after a batch of several,
  is what makes each step's effect unambiguous. Batching multiple changes
  before checking recreates the "which of these caused it" problem
  incremental discipline exists to avoid.
- This applies as much to environment/config changes as to code changes —
  changing two env vars and one dependency version at once, then testing
  once, tells you nothing about which one mattered.
- When a check is slow, still verify at coarser granularity than "the
  whole task" — batch a FEW small, clearly related changes together
  deliberately (and note that you did), rather than letting batching
  happen by accident because verification felt like overhead.

## Revert on regression — don't layer a fix on a fix

- If a change makes things WORSE (a new failure, a previously-passing
  check now failing, a symptom that got broader instead of narrower), the
  correct default is to REVERT that specific change and re-verify you're
  back at the known baseline, before trying something else.
- The tempting alternative — adding a second change on top to compensate
  for the first change's side effect — creates a compound state nobody
  has verified as a whole, and hides the fact that the first change was
  wrong. It also makes the eventual diff much harder to review.
- "Revert" here means undo the specific change (`git checkout -- file`,
  `git revert`, or simply re-editing back to the prior content) — not
  "keep trying more things without removing what didn't work."
- Confirm the revert actually restored the baseline (rerun the same check)
  before concluding "reverting didn't help either" — a failed revert looks
  identical to a genuinely unrelated cause if you don't re-verify.

## Sizing a step

Too small and verification overhead dominates progress (busywork). Too
large and you're back to the batched-change problem this discipline exists
to avoid. A reasonable step is the smallest change that is INDEPENDENTLY
meaningful — one function's behavior, one config value, one file's
migration — such that "did this step work" has a clear yes/no answer from a
single fast check. If a large change is unavoidable, decompose it into an
ordered list of such steps BEFORE starting, rather than improvising the
granularity as you go.

## Recognizing when you've drifted from the discipline

Warning signs that steps have grown too large or verification has lapsed:

- You can't describe, in one sentence, what the LAST step you made was
  supposed to do.
- The check you're about to run would take more than a minute or two —
  consider whether a narrower check exists for just the last step.
- You're tempted to make "one more small tweak" before checking, because
  checking now "obviously" won't reveal anything new — this is exactly the
  point where batching creeps in.

## Keeping a change reviewable

- A change that grew through many small, verified, RETAINED steps is
  usually still small and coherent at the end, because each step was
  individually justified.
- A change that grew through unverified batching often needs to be
  unpicked before review — commit as you go (or keep a running note of
  what worked) so you can reconstruct which parts are load-bearing if you
  need to trim the final diff down to just what's necessary.

## When this discipline matters most

- Debugging sessions that have been running a while and are not
  converging — this is exactly when the temptation to batch multiple
  speculative changes is highest, and exactly when it costs the most.
- Any change to shared/critical infrastructure, migrations, or anything
  hard to undo in production — verify smaller and more often, not less,
  as the blast radius of a mistake grows.
