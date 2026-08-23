---
name: lesson-big-bang-refactor
description: Lesson — a large simultaneous multi-file refactor introduced a regression that could not be bisected or isolated afterward, because dozens of unrelated changes landed in one unverified step.
tags: [lesson, refactor, incremental, postmortem, big-bang, unbisectable]
searchHints:
  - "why is it hard to find the bug after a big refactor"
  - "what happens if I change too many files at once"
  - "large refactor introduced a bug that's hard to find"
  - "big rewrite broke something can't isolate which part"
  - "too many changes at once caused a regression"
when_to_use: "Before starting any refactor or migration that touches many files, before deciding whether to land it as one change or a sequence of verified steps."
---

# Lesson: the big-bang refactor

## What happened

A refactor to rename a core abstraction touched roughly 60 files across the
codebase — renaming a type, updating every call site, and restructuring a
few adjacent functions "while already in there." It was written and
reviewed as a single large change, verified only by running the full test
suite once at the end.

The full suite passed. The change was applied. Later, a subtle behavioral
regression surfaced in a code path the refactor had touched only
incidentally (one of the "while already in there" adjustments) — not one
the top-level task description had called out. Because the refactor was
one large, simultaneous change, there was no way to bisect it internally —
`git bisect` across the single commit gave no information, and reverting
the whole 60-file commit to fix one small regression would have also
reverted the (correct, wanted) core rename. Isolating the actual faulty
piece required manually re-deriving which of the ~60 files' changes was
responsible, essentially redoing the refactor's diff-review from scratch
after the fact, under time pressure, instead of at the moment each piece
was written.

## What should have happened instead

- The core rename and the "while already in there" adjustments should have
  been SEPARATE changes, landed and verified independently — the
  incidental adjustments carried real regression risk that had nothing to
  do with the rename's own risk, and bundling them meant a failure in
  either was indistinguishable from a failure in the other.
- Even within the rename itself, landing it as a sequence of smaller,
  independently verified steps (a package at a time, or a layer at a time)
  would have kept each step bisectable, and would likely have caught the
  regression at the step that introduced it rather than after the full
  merge.
- "The full suite passed once at the end" is necessary but not sufficient
  verification for a large change — it confirms no test caught a problem,
  not that no problem exists; the absence of bisectable structure is what
  made the eventual regression so expensive to isolate, independent of
  whether more tests would have caught it sooner.

## Generalizable takeaway

The value of small, verified, independently-committed steps is not just
"catch problems sooner" — it's that it keeps every subsequent investigation
(bisection, revert, blame) cheap. A regression inside a single 60-file
commit costs an order of magnitude more to isolate than the same regression
inside one of twenty 3-file commits, even if the total amount of code
changed is identical. See incremental-change-discipline.
