---
name: reproduce-before-you-fix
description: Reproduce a bug reliably and minimally before touching code — a fix for a bug you cannot trigger on demand is a guess, not a fix.
tags: [debugging, reproduce, repro, minimal-repro, isolate, root-cause]
searchHints:
  - "how do I reproduce a bug before fixing it"
  - "what should I do if I cannot reproduce the bug"
  - "how to reproduce a bug before fixing it"
  - "cannot reproduce the bug reliably"
  - "make a minimal reproduction case"
  - "isolate the exact conditions that trigger a failure"
  - "bug only happens sometimes reproduce it first"
---

# Reproduce before you fix

The single highest-leverage habit in debugging: get the failure to happen
**on command**, in the smallest possible form, before writing a single line
of fix code. Everything else — instrumenting, bisecting, patching — is only
trustworthy once you can reproduce at will.

## Why reproduce first

- A "fix" for a bug you cannot trigger is unverifiable. You cannot tell a
  real fix from a change that happens to make the symptom disappear once.
- Root cause and symptom are often several layers apart. Without a repro
  loop you cannot walk that distance safely.
- A minimal repro is the fastest possible feedback loop for every step that
  follows (bisection, instrumentation, testing the fix).

## Steps to a minimal reproduction

1. **Capture the exact trigger.** Exact command, exact input, exact
   environment (OS, versions, env vars, working directory, flags). Write it
   down verbatim — do not paraphrase from memory.
2. **Automate the trigger.** A repro you re-type by hand is a repro you will
   get wrong the third time. Turn it into a script, a single test, or a
   one-line shell command you can rerun unchanged.
3. **Confirm it reproduces at least 3 times in a row** before trusting it.
   If it does not reproduce every time, it is flaky — see the flaky-test
   playbook before proceeding; do not debug a moving target.
4. **Strip everything not required to trigger the failure.** Delete unrelated
   code paths, unrelated data, unrelated config. After each deletion, rerun
   the repro. If it still fails, the deleted part was not the cause — keep
   cutting. If it stops failing, put that part back; it is load-bearing.
5. **Note what does NOT trigger it.** A near-miss input that does not fail is
   as informative as the one that does — it brackets the real condition.

## When you cannot reproduce locally

- **Environment-specific:** compare OS, package versions, env vars, locale,
  timezone, and file permissions between the failing and working
  environments. A bug that "only happens in CI" or "only on their machine"
  is an environment-diff problem first, a code problem second.
- **Data-specific:** the failure may depend on a particular data shape
  (empty list, unicode, huge input, null field) not present in your test
  data. Ask for or reconstruct the exact triggering input.
- **Timing-specific:** race conditions and timing bugs may need load,
  concurrency, or artificial delay to surface reliably — see the flaky-test
  and concurrency notes rather than trying to force it head-on.
- If truly stuck, add read-only instrumentation (logging) at the suspected
  boundary in the environment where it DOES happen, and read the traceback
  and log output carefully before guessing at a fix.

## Anti-patterns

- Patching the first plausible cause you see without confirming it explains
  every observed symptom.
- Fixing in the environment where you cannot reproduce, then hoping.
- Debugging against a flaky repro that only fails 1 time in 5 — bisection
  and instrumentation both give false signals against a coin flip.
