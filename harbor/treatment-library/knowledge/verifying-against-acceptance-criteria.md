---
name: verifying-against-acceptance-criteria
description: Verify a change against the task's stated acceptance criteria before declaring it done, not just against tests you wrote yourself — re-read the original issue/task description as the source of truth for what "done" means.
tags: [acceptance-criteria, done, verification, task-description, issue, requirements, self-verification]
searchHints:
  - "how do I know when a task is actually done"
  - "when am I done with this task"
  - "did I actually fix what the issue asked for"
  - "verify against the issue description"
  - "acceptance criteria for a task"
  - "does my fix match what was actually asked"
  - "self-written test passes but did I solve the right problem"
when_to_use: "Before declaring a task complete — re-check what was asked against what was actually done, using the task's own description as the source of truth rather than only the checks you happened to write."
---

# Verifying against acceptance criteria

A task passing the checks you personally wrote is not the same claim as a
task satisfying what was actually asked. The two usually agree, but the gap
between them — a self-written test that checks the wrong thing, or a fix
that addresses a symptom the task didn't actually describe — is exactly the
gap that "looks done" without being done.

## Before starting: read the actual requirement, not just the symptom

- Re-read the full task/issue description, not just the first line or the
  error message it happens to quote. A description often states the
  ACTUAL expected behavior explicitly ("X should return Y when Z"), which
  is a stronger source of truth than inferring intent from a stack trace or
  a single failing test alone.
- Distinguish what is REQUIRED from what is merely EXAMPLE or CONTEXT in
  the description — a task that says "for example, this fails when the
  input is empty" is describing one manifestation, not necessarily the
  full scope of what needs to be fixed; check whether the same underlying
  issue affects other inputs the description implies but doesn't spell out.
- If the task references specific expected output, an exact error message,
  a specific return value, or a specific exit code — treat that as a
  literal acceptance check, not a paraphrase-able suggestion.

## Before declaring done: verify against the criteria, not just your own checks

- If the task provides its own tests, checks, or a verification command —
  run THAT, not just tests you wrote yourself, before considering the task
  complete. A self-written test can pass while missing what the task's own
  verification actually checks for, especially if your test was written
  from your own mental model of the bug rather than from the task's stated
  requirement.
- If you wrote your own test(s) to drive the fix (see
  test-first-fix-discipline), treat them as scaffolding, not as the final
  proof of correctness — they confirm the SPECIFIC case you modeled, not
  necessarily every case the task actually requires.
- Re-read the task description ONE more time immediately before finishing,
  specifically checking for any requirement not yet covered — it is easy
  to fully solve the first concrete example in a task description and stop
  there, missing a second requirement stated in a later sentence.
- If the task specifies a particular way the solution should be verified
  (a specific command to run, a specific test file, a specific expected
  output), use exactly that — don't substitute an equivalent-seeming check
  of your own; the task's own verification is the actual acceptance test,
  and a plausible-looking substitute can differ in exactly the detail that
  matters.

## Common ways "looks done" and "is done" diverge

- **Overfitting to one example.** The task gives one concrete failing case;
  the fix handles exactly that case and no other, when the description
  implies (or a stated requirement demands) a general fix.
- **Fixing a different symptom than the one described.** An error message
  or stack trace suggests an obvious-looking fix that makes the SPECIFIC
  error go away without addressing what the task actually asked for — see
  lesson-guessed-without-reproducing for the broader version of this trap.
- **Passing self-written tests that don't match the task's own
  verification.** A test written to confirm your own fix can silently
  encode the same wrong assumption the fix itself makes, so it passes
  without proving what actually needed proving.
- **Stopping at the first requirement satisfied**, when the task
  description contains more than one — re-scan the full description before
  finishing, not just the part that prompted the first fix.

## A minimal final check before finishing

1. Re-read the task's stated requirement(s) in full, one more time.
2. Run the task's own verification/tests if any were provided, not only
   your own.
3. For each distinct requirement in the description, confirm explicitly
   (not just "the tests are green") that it is addressed — a green test
   suite proves nothing about a requirement no test in it actually checks.
4. If anything in the description is still unaddressed, treat the task as
   not yet done rather than declaring completion on the strength of
   unrelated passing checks.
