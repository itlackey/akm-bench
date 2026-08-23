---
name: test-first-fix-discipline
description: The red-to-green loop for fixing a failing test correctly — confirm the failure reason, write or extend the test to pin the exact behavior, fix the code not the assertion, and never skip a failing test to get a green run.
tags: [test, red-green, tdd, fix-vs-skip, discipline, regression]
searchHints:
  - "how do I fix a failing test properly"
  - "should I fix the code or change the test"
  - "how to fix a failing test properly"
  - "skip a failing test to get ci green"
  - "test is failing should I loosen the assertion"
  - "red green test loop"
  - "fix the code or fix the test"
---

# Test-first fix discipline

When a test fails, the failure is information about either the CODE or the
TEST — figure out which before touching either one. This skill is the
discipline for making that call correctly and not taking the fast, wrong
shortcut under time pressure.

## Step 1 — confirm you understand WHY it's failing

- Read the actual assertion diff (expected vs. actual), not just
  "FAILED". Reproduce it as a single, isolated test run (see
  running-a-single-test-fast) before touching anything.
- Determine which of these it is, explicitly:
  - **The code has a real bug** — the test's expectation is correct, the
    implementation doesn't meet it.
  - **The test's expectation is stale/wrong** — a legitimate, intentional
    behavior change made the old assertion incorrect, and the test needs
    updating to match the new, correct behavior.
  - **The test is flaky** — the failure isn't a deterministic function of
    the code at all (see diagnosing-flaky-tests before assuming this
    without evidence).
- Do not proceed to "fix" anything until you can state in one sentence
  which of the three this is, and why.

## Step 2 — fix the RIGHT side

- If the code is wrong: fix the code. The test should stay unchanged
  (unless it also has an unrelated existing bug), and passing it is your
  verification.
- If the test's expectation is genuinely stale: update the test to assert
  the new, intentionally correct behavior — and explain in the commit
  message/PR description WHY the old expectation is no longer correct, so
  a reviewer doesn't read "loosened assertion" as suspicious without
  context.
- If it's flaky: fix the actual source of flakiness (see
  diagnosing-flaky-tests) — do not "fix" it by loosening the assertion or
  adding a retry loop as a permanent measure.

## Never skip instead of fix

Marking a failing test `.skip()`/`@pytest.mark.skip`/commenting it out to
get a green build is almost never the right move, because:

- It silently removes the safety net that test provided, for everyone,
  going forward — not just for this one investigation.
- A skipped test protecting a real bug means the bug ships, and the next
  person to touch that area gets no warning.
- "Temporary" skips have a strong tendency to become permanent — nobody
  circles back to an already-green build.

Legitimate exceptions are narrow and should be explicit, not silent:

- A test for a feature being deliberately removed (delete the test with
  the removal, don't skip it and leave it dangling).
- A known, TRACKED, actively-being-fixed issue where skipping is a
  conscious, temporary, ticketed decision with an owner and a reason
  documented directly in the skip annotation (`@skip("see ISSUE-123: ...")`
  not a bare `@skip`).

## The loop

1. Confirm the single test fails, and WHY (step 1 above).
2. Make the smallest change addressing the correct side (code or test).
3. Re-run that SAME single test — confirm it now passes for the reason you
   expect (re-check the assertion, don't just trust green).
4. Run the surrounding test file/module, then the full suite, before
   calling it done — a narrow fix can still have broken something
   adjacent.
5. If a new test is warranted (the bug had no test coverage at all),
   add one that would have caught this specific failure, not just a
   generic smoke test.

## Related references

- running-a-single-test-fast (knowledge) — narrowing to one fast test.
- diagnosing-flaky-tests (knowledge) — confirming/fixing genuine flakiness.
- lesson-skip-instead-of-fix (lesson) — a concrete postmortem of this
  failure mode.
