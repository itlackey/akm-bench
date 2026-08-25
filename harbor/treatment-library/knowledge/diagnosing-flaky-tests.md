---
name: diagnosing-flaky-tests
description: Diagnose a test that fails only in CI, only sometimes, or only in a certain run order — repeat-run to confirm flakiness, then isolate shared state, timing, and ordering causes before touching test logic.
tags: [flaky, test, ci, intermittent, race-condition, order-dependent, timing]
searchHints:
  - "why does my test pass locally but fail in ci"
  - "why is this test flaky and what do I check first"
  - "test fails only in ci"
  - "test passes locally but fails in ci"
  - "flaky test fails intermittently"
  - "test fails only when run with the full suite"
  - "test fails only sometimes not every run"
  - "why does this test fail randomly"
---

# Diagnosing flaky tests

A flaky test is one whose pass/fail outcome is not a pure function of the
code under test — it also depends on timing, ordering, or shared state. Do
not "fix" a flaky test by rewriting assertions until you know WHICH of these
it is; the wrong fix hides the flake instead of removing it.

## Step 1 — confirm it's actually flaky, not actually broken

- Re-run the single failing test 10–20 times in a tight loop, alone.
- If it fails 0/20 alone: the failure depends on something outside that
  single test — go to "run-order dependence" below.
- If it fails some-but-not-all times even alone: it's timing/race-based —
  go to "timing and concurrency" below.
- If it fails consistently alone: it is not flaky, it is a real regression —
  stop here and debug it as a normal failure (reproduce-before-you-fix).

## Step 2 — "only in CI, not locally"

This is an environment-diff problem, not a test-logic problem. Compare:

- **Parallelism**: CI often runs tests in parallel or with more worker
  processes than local runs — this surfaces shared-state and port/file
  collisions that never happen serially.
- **Resource constraints**: CI runners are typically slower and more
  memory/CPU constrained — timeouts calibrated on a fast laptop fail under
  load. Look for hardcoded sleep/timeout values.
- **Clean state vs. accumulated local state**: CI runs from a fresh
  checkout/container every time; a local repo may have stale caches,
  leftover files, or a database with prior test data that happens to make
  the test pass.
- **Environment variables / locale / timezone**: CI images often differ
  from a dev machine in locale, timezone, or default env vars — date/time
  and sorting-order tests are especially sensitive to this.
- **Non-deterministic ordering**: CI test order (often alphabetical or
  parallel-shard assigned) can differ from local IDE/manual run order.

## Step 3 — run-order dependence

- Run the FULL suite (not just this test) and see if it fails only in
  that context.
- Run just this test together with a small, growing subset of others to
  narrow down which OTHER test is polluting shared state (global variables,
  a shared database, a shared temp directory, static/class-level
  fields, module-level caches, environment variables mutated and not
  restored).
- Most test frameworks support randomized order (`pytest-randomly`,
  Jest's `--randomize`, Go's default unordered map iteration exposed via
  `-shuffle=on`) — running with randomized order on repeat is the fastest
  way to surface hidden ordering dependencies.
- Fix by ensuring proper setup/teardown per test (fresh fixtures, mocks
  reset, temp resources cleaned up) rather than reordering tests to dodge
  the interaction.

## Step 4 — timing and concurrency

- Look for `sleep(N)` used to "wait long enough" — this is the single most
  common source of CI-only flakiness, because CI's slower/loaded machines
  need longer than N.
- Replace fixed sleeps with polling/condition-waiting (wait until the
  actual condition is true, with a generous timeout) instead of a fixed
  delay.
- Look for tests that depend on real wall-clock time, real network calls,
  or unmocked randomness — these are non-deterministic by construction.
- For genuine concurrency bugs (a race in the code under test, not the
  test itself): run with a race detector where available (Go's
  `-race`, ASan/TSan for C/C++) and increase iteration count/parallelism to
  surface it more reliably.

## Step 5 — shared external resources

- A shared port, shared database, shared file, or shared temp directory
  across parallel test workers causes intermittent collisions. Fix by
  giving each test/worker its own isolated resource (random port,
  per-test temp dir, per-test DB schema/transaction rollback).

## What NOT to do

- Do not retry-until-green in CI as a permanent fix — it hides a real bug
  and slows the pipeline; it's an acceptable SHORT-TERM mitigation while
  you investigate, never a resolution.
- Do not delete/skip a flaky test without first confirming it isn't
  catching a real, intermittent production bug (see the lesson on skipping
  instead of fixing).
- Do not "fix" flakiness by loosening an assertion (widening a tolerance,
  removing a check) unless you've confirmed the widened case is actually
  correct behavior, not just less likely to be observed as wrong.
