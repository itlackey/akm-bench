---
name: grouping-failing-tests-by-root-cause
description: When many tests fail at once, group them by likely shared root cause before fixing anything — one broken fixture or one changed function often produces dozens of failures that look independent but aren't.
tags: [test, failing-tests, summarize, triage, root-cause, many-failures]
searchHints:
  - "why are so many of my tests failing"
  - "what should I do when a lot of tests fail at once"
  - "summarize failing tests after a run"
  - "collect all test failures and group them"
  - "many tests failing where to start"
  - "hundred tests failing after one change"
  - "are these test failures related"
when_to_use: "A test run reports many failures at once and it isn't yet clear whether they're one bug or many — group before you start fixing individually."
---

# Grouping failing tests by root cause

Fixing failing tests one at a time, in the order they printed, is often the
slowest path when many fail at once: a single broken fixture, a single
changed function signature, or a single missing environment variable can
produce dozens of failures that look unrelated until they're grouped.

## Procedure

1. **Run with a reporter that includes the full assertion diff per
   failure**, not just pass/fail counts — you need the actual exception
   type and message for every failure, not a summary count.
2. **For each failing test, capture**: test name, file, the exact assertion
   diff or exception, and whether it looks environment-related (a
   connection/timeout/missing-resource error) vs. logic-related (a wrong
   value assertion).
3. **Group failures that share a likely root cause.** The same exception
   type at the same underlying call site, or the same fixture/setup step
   failing across many tests, is usually ONE bug producing many failures —
   not many independent bugs. Look specifically for:
   - The same exception TYPE and MESSAGE appearing across multiple tests.
   - Failures that all trace back through the same helper function, fixture,
     or setup/teardown step (see reading-stack-traces to identify the
     shared frame).
   - Failures clustered in one file or one module, suggesting a shared
     import, fixture, or recently-changed dependency of that module.
4. **Flag anything that looks flaky rather than deterministic** (mention of
   a timeout, a sleep, an order-dependent-looking fixture) for separate
   handling — see diagnosing-flaky-tests — rather than folding it into a
   root-cause group where it doesn't belong.
5. **Start with the group with the most failures attributed to it.** Fixing
   one shared root cause (a broken fixture, a signature change not
   propagated everywhere) can resolve many failures in a single fix; fixing
   failures in printed order instead means repeatedly re-diagnosing the
   same underlying cause.
6. **Re-run the full set after each group's fix** rather than assuming the
   grouping was exhaustive — a fix for one shared cause can also reveal
   failures that were previously masked by an earlier one in the same run
   (e.g. a setup failure that aborted before a later assertion could even
   run).

## Why this beats fixing in printed order

Test runners typically report failures in file/declaration order, which has
no relationship to root cause. Working through them in that order means
re-discovering the same underlying bug once per affected test instead of
once per bug — the grouping step is what turns "40 failures" into "3
actual problems, one of which explains 30 of them."
