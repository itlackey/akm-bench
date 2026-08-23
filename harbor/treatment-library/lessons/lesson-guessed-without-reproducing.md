---
name: lesson-guessed-without-reproducing
description: Lesson — patched the most plausible-looking cause from a bug report without reproducing it first, which fixed nothing and wasted a full debugging session before the real cause was found.
tags: [lesson, reproduce, debugging, postmortem, wasted-effort]
searchHints:
  - "what happens if I fix a bug without reproducing it first"
  - "why did my guess at the fix not work"
  - "fixed based on a guess without reproducing first"
  - "patched the wrong thing without a repro"
  - "debugging without reproducing wasted time"
when_to_use: "Before writing any fix for a bug report you have not personally reproduced yet."
---

# Lesson: guessed without reproducing

## What happened

A bug report described an intermittent crash with a stack trace pointing
into a specific function. The function had a plausible-looking edge case
(an unguarded index access) that matched the crash type. A fix was written
and shipped to guard that edge case — without first reproducing the crash
locally.

The crash kept happening. The unguarded index access was real but was not
actually reachable under the conditions in the bug report; it was a
red herring that merely looked like a match for the exception type. The
actual cause — a race condition in a completely different code path that
happened to corrupt the same data structure — was found a day later, after
finally investing in a proper reproduction (running the reported workflow
under load until the race surfaced reliably).

The day spent on the first, unverified fix was not wasted in service of
finding the real bug — it was wasted because a change shipped to production
with a false sense that the bug was resolved, delaying the real fix and
creating a second incident when the crash recurred.

## What should have happened instead

- Reproduce the failure before writing a fix, even under time pressure —
  see reproduce-before-you-fix. A stack trace pointing at a plausible edge
  case is a HYPOTHESIS, not confirmation.
- If reproduction is genuinely hard (intermittent, environment-specific),
  that difficulty is itself informative — it should raise suspicion of
  concurrency/environment/timing causes rather than justify skipping
  straight to a guessed fix.
- A fix that ships without a reproduction to verify against should be
  treated as UNVERIFIED, and communicated as such — not reported as
  resolved.

## Generalizable takeaway

A plausible-looking cause that matches the surface symptom (same exception
type, similar-looking code shape) is not the same as a confirmed cause.
The only way to tell them apart reliably is to reproduce the failure and
confirm the fix actually changes the outcome against that reproduction —
skipping this step trades a small amount of upfront time for a much larger
risk of shipping a fix that fixes nothing.
