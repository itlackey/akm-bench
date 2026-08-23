---
name: bisecting-code-and-commits
description: Binary-search a regression down to the exact commit or the exact code path — git find commit that broke a test, automate it with git bisect run, or narrow a bug inside one function by halving the search space.
tags: [bisect, bisection, regression, git-bisect, git-bisect-run, binary-search, root-cause, breaking-commit]
searchHints:
  - "how do I find the commit that broke the build"
  - "why did this used to work and now it is broken"
  - "git find commit that broke this"
  - "which commit introduced this bug"
  - "find the change that caused a regression"
  - "binary search a bug in the code"
  - "narrow down where in the code the bug is"
  - "used to work now it's broken find out why"
  - "how do I automate git bisect"
  - "git bisect skip a commit that won't build"
when_to_use: "Something used to pass and now fails, and you have (or can script) a reliable pass/fail check for it — across commits, across a suspect region of code with no commit history, or across dependency/config versions."
---

# Bisecting code and commits

Bisection is binary search applied to "when/where did this break". It turns
an unbounded "somewhere in months of history / thousands of lines" search
into O(log n) steps. Use it whenever something USED to work and now does
not, and you have a reliable pass/fail check (see reproduce-before-you-fix
first — bisection needs a trustworthy repro).

## `git bisect` — finding the breaking commit

1. `git bisect start`
2. `git bisect bad` (current commit is broken; or `git bisect bad <ref>`)
3. `git bisect good <ref>` — a known-working commit/tag/older release
4. Git checks out the midpoint commit. Run your repro / test suite.
5. Mark it: `git bisect good` or `git bisect bad`. Repeat — git keeps
   halving the range.
6. When it reports the first bad commit, read that diff — the culprit is
   almost always visible directly in it.
7. `git bisect reset` to return to your original branch/HEAD when done.

### Automating it

If the check can be scripted (a test command that exits 0 on good, nonzero
on bad):

```
git bisect start <bad-ref> <good-ref>
git bisect run <script-or-command>
```

`git bisect run` drives the whole loop unattended — this is almost always
worth setting up over manually marking good/bad by hand, even for a one-off
investigation, because it removes the risk of a manual good/bad mistake
silently corrupting the search.

### Bisect hygiene

- The "good" and "bad" refs must both actually build/run — a commit that
  doesn't compile for unrelated reasons poisons the bisection. Use
  `git bisect skip` for a commit that cannot be tested at all.
- If the codebase changed shape (renamed files, moved directories) across
  the range, the repro/test command itself may need to be resilient to
  that, or bisect will report false failures for unrelated reasons.
- A flaky test inside the bisected range gives a flaky bisection — verify
  the check is NOT flaky (run it 3+ times at both the known-good and
  known-bad ref, confirm consistent results) before trusting a bisect run
  built on it; see the flaky-test diagnosis doc.

### Handling commits that can't be tested

- `git bisect skip` marks the current commit untestable and moves on — use
  it for a commit that fails to build for reasons unrelated to the bug
  you're chasing (a known-broken intermediate commit, a submodule that
  doesn't resolve at that point in history).
- If MANY consecutive commits are untestable, `git bisect run` can still
  work if the script itself detects the untestable condition and exits with
  code 125 — a reserved exit code `git bisect run` treats as "skip this
  commit automatically" rather than good or bad.

### After `git bisect` reports the first bad commit

1. `git show <first-bad-commit>` — read the full diff and commit message,
   not just the one-line summary; the cause is almost always directly
   visible.
2. Confirm CAUSALLY, not just correlatively: does reverting just this
   commit (or a minimal patch undoing its relevant change) actually fix the
   check? A "first bad" commit can be coincidental if the check itself has
   any nondeterminism — re-verify before trusting the result as final.
3. Decide the fix: revert the commit outright, or write a forward-fix that
   addresses specifically what that commit got wrong — a forward-fix is
   usually preferable when the commit's other changes are still wanted and
   only part of it is at fault.
4. `git bisect reset` before continuing other work, so you're not left on a
   detached-HEAD bisection state.

## Bisecting inside code (no commit history involved)

The same halving idea applies WITHIN a single version of the code, when the
bug is "somewhere in this call chain / this data pipeline / this 2000-line
function" and there is no earlier working commit to lean on:

1. Pick a midpoint in the suspect region (a function boundary, roughly the
   middle of a pipeline of transforms, roughly the middle of a large
   function).
2. Insert a check at that midpoint: is the state already wrong there, or
   still correct? (A print, an assert, a debugger breakpoint, a temporary
   return early.)
3. If already wrong at the midpoint: the bug is in the FIRST half — recurse
   into that half.
4. If still correct at the midpoint: the bug is in the SECOND half —
   recurse into that half.
5. Repeat until the suspect region is a single function or a single
   expression.

This works for: a long pipe of `.map().filter().reduce()`-style
transformations, a multi-stage build/render pipeline, a large function with
many sequential steps, or a deep call stack where you don't yet know which
layer corrupts the value.

## Bisecting dependency/config changes

The same technique applies to "it broke after I updated a dependency" or
"it broke after a config change": binary search the dependency version
range (or the set of changed config keys) the same way you would a set of
commits — halve the candidate set, test, repeat.

## Rules that make bisection reliable

- Confirm the SAME check both flags the bug and confirms its absence — a
  test that is itself unstable defeats the entire method.
- Never change two things between bisection steps. Bisection assumes a
  single boolean signal per step; conflating causes gives an ambiguous
  result.
- Write down the range and the result of each step if doing it by hand — it
  is easy to lose track of which half you already excluded.
