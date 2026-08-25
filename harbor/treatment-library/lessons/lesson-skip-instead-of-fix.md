---
name: lesson-skip-instead-of-fix
description: Lesson — skipping a failing test to get a green build instead of fixing it masked a real regression, which shipped and was only caught later by users.
tags: [lesson, skip-test, regression, postmortem, test-discipline]
searchHints:
  - "what happens if I skip a failing test"
  - "is it ok to disable a test to get ci green"
  - "skipped a failing test to get green build"
  - "disabled a test instead of fixing it"
  - "consequence of skipping a failing test"
when_to_use: "Before marking any failing test as skipped, disabled, or expected-to-fail instead of fixing the underlying cause."
---

# Lesson: skip instead of fix

## What happened

A test started failing after an unrelated dependency bump. Under time
pressure to land an unrelated change, the failing test was marked
`@skip("flaky, revisit later")` without confirming it was actually flaky —
it was assumed to be flaky because the failure looked timing-related at a
glance. The build went green and the change merged.

The test was not flaky. The dependency bump had introduced a real behavior
change that the test correctly caught. Because it was skipped rather than
investigated, the regression shipped. It was found roughly two weeks later
by a user report, at which point the original context (which dependency
bump, which commit, what the intended behavior even was) had to be
reconstructed from scratch — considerably more expensive than the five
minutes it would have taken to actually read the assertion diff at the
time.

## What should have happened instead

- Before skipping ANY failing test, confirm whether it's actually flaky
  (re-run it several times in isolation — see diagnosing-flaky-tests) or
  a genuine deterministic failure. A single failure with a
  timing-adjacent-LOOKING error message is not evidence of flakiness on
  its own.
- If a fix genuinely cannot happen immediately, a skip is only acceptable
  when it's explicit, tracked, and owned: a linked issue, a reason in the
  skip annotation itself, and an understanding of what regression risk is
  being accepted in the meantime — not a bare skip with a vague comment.
- Time pressure to merge an unrelated change is not a reason to silence a
  test failure that change didn't cause — it's a reason to either revert
  the change that broke the test, or fix the actual regression, or (at
  minimum) escalate rather than quietly disabling the signal.

## Generalizable takeaway

A failing test is a message. Skipping it without reading the message
doesn't make the underlying problem go away — it just removes the
messenger. Treat "should I skip this" as always requiring the same
diagnostic step as "should I fix this": first understand WHY it's failing.
See test-first-fix-discipline for the full procedure.
