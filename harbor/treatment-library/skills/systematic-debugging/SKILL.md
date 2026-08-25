---
name: systematic-debugging
description: The reproduce, hypothesize, instrument, bisect, fix, verify loop for tracking down any bug systematically instead of guessing — use whenever a task involves fixing a failure whose cause is not yet known.
tags: [debugging, systematic, methodology, reproduce, hypothesize, instrument, bisect]
searchHints:
  - "how do I debug this"
  - "what should I do when I am stuck on a bug"
  - "how do I go about finding the cause of a failure"
  - "systematic approach to debugging a bug"
  - "debugging methodology step by step"
  - "stuck on a bug don't know where to start"
  - "scientific method for fixing a failure"
---

# Systematic debugging

A repeatable loop for any bug whose cause is not yet known. Follow it in
order — skipping straight to "fix" without the earlier steps is the most
common way to waste time.

## The loop

1. **Reproduce.** Get the failure to happen on command, in the smallest
   possible form. If you cannot reproduce it reliably, everything after
   this step is unreliable too — invest here first, even if it feels slow.
2. **Read the evidence carefully.** The full error message, the full stack
   trace (read it root-to-symptom, not just the first line), the exact
   input, the exact expected vs. actual output. Most "mystery" bugs have
   the answer sitting in evidence that got skimmed too fast.
3. **Form a specific, falsifiable hypothesis.** Not "something's wrong with
   the parser" — instead "the parser drops the last element when the input
   list has exactly one item." A hypothesis you can't test isn't useful
   yet; narrow it until you can.
4. **Instrument to test the hypothesis**, not to fix it yet. Add a targeted
   log/print/assert/breakpoint at the exact point that would confirm or
   refute the hypothesis. Read the actual value, don't assume it.
5. **Bisect when the hypothesis is too broad to test directly.** "It broke
   somewhere in the last 40 commits" or "the bug is somewhere in this
   800-line function" both call for halving the search space rather than
   scanning linearly — see the bisecting-code-and-commits reference for
   the exact technique.
6. **Fix the smallest thing that addresses the confirmed root cause** —
   not the first plausible-looking line near the crash. If the
   instrumentation pointed at a specific wrong value or wrong branch,
   fix THAT, and be able to explain in one sentence why it was wrong.
7. **Verify against the ORIGINAL reproduction**, not just a related check.
   Then run the broader surrounding tests/checks before considering it
   done — a fix that only satisfies the narrow repro can still break
   something adjacent.
8. **Remove temporary instrumentation** (debug prints, temporary asserts)
   before finishing, unless it's genuinely worth keeping as permanent
   logging.

## When a hypothesis is wrong

Don't quietly pivot to a new hypothesis and keep the old instrumentation as
noise. Explicitly note the hypothesis was refuted and what the
instrumentation actually showed — that observation usually narrows the next
hypothesis significantly, so it's worth keeping in mind even though the
first guess was wrong.

## When you're not converging

If several hypotheses in a row have been refuted, that's a signal to step
back rather than keep guessing faster:

- Re-read the full error/traceback again — it's easy to have anchored on a
  wrong reading of it early and kept testing hypotheses downstream of that
  wrong reading.
- Check whether the "bug" is actually a bug in your understanding of the
  intended behavior, not the code — re-read the spec/requirements/tests
  that define correct behavior.
- Bisect if you haven't yet — even a vague "it broke recently" is often
  enough to start a git bisect, which converges in log(n) steps regardless
  of how confusing the symptom is.

## Related references

- reproduce-before-you-fix (knowledge) — the reproduction step in depth.
- reading-stack-traces (knowledge) — how to read the evidence correctly.
- bisecting-code-and-commits (knowledge) — narrowing a broad hypothesis.
- incremental-change-discipline (knowledge) — how to apply the fix step
  safely once you've found the cause.
