---
name: patch-and-diff-mechanics
description: Generate a correct unified diff, apply a patch with git apply or patch -p1, and fix the common failure modes — context/whitespace mismatch, wrong strip level, a patch that applies to the wrong base revision.
tags: [patch, diff, git-apply, unified-diff, patch-p1, whitespace, context-mismatch, reject]
searchHints:
  - "git apply patch failed"
  - "patch does not apply"
  - "how do I generate a unified diff"
  - "why does git apply reject my patch"
  - "patch -p1 vs -p0 what is the difference"
  - "whitespace error when applying a patch"
  - "corrupt patch at line"
  - "apply a diff to a file"
  - "create a patch file from my changes"
when_to_use: "You need to produce a patch/diff as output, or an attempt to apply one (git apply, patch -p1) fails and you need to find out why before retrying blindly."
---

# Patch and diff mechanics

A patch is a text format with exact structural requirements — context
lines, line-number headers, and a base path convention. Most "patch does
not apply" failures come from a mismatch in one of these, not from the
underlying change being wrong.

## Generating a correct patch

- `git diff` (unstaged) or `git diff --cached` (staged) produces a unified
  diff against the current `HEAD` — the standard format both `git apply`
  and `patch` understand.
- `git diff > my.patch` — redirect to a file. Confirm the file is non-empty
  and actually contains `diff --git` / `---`/`+++` headers before treating
  it as done; a diff run in the wrong directory, or with nothing staged
  when `--cached` was used, silently produces an empty file.
- For a patch meant to apply cleanly elsewhere, generate it from a clean
  working tree state relative to a known base commit
  (`git diff <base-commit>`) rather than from an already-dirty tree — an
  unrelated local change bleeding into the diff is a common source of a
  patch that then fails to apply somewhere else.
- A unified diff's hunk header (`@@ -a,b +c,d @@`) records line numbers
  and a line COUNT for both sides — these must match the actual file
  content exactly; a hand-edited patch with a wrong count is invalid even
  if the added/removed lines themselves are correct.

## Applying a patch — `git apply`

- `git apply my.patch` — applies against the current working tree. Fails
  loudly (not silently partial) if any hunk doesn't match.
- `git apply --check my.patch` — validates without actually applying;
  always do this first when you didn't generate the patch yourself, so a
  failure doesn't leave the tree half-modified.
- `git apply --stat my.patch` — shows which files/how many lines would
  change, useful for confirming the patch targets what you expect before
  applying it.
- `git apply -3 my.patch` (3-way merge) can succeed where a plain apply
  fails, by falling back to a merge of the blobs referenced in the patch's
  own index lines — only works if those blobs exist in the local object
  database (e.g. the patch came from a commit you have, not an arbitrary
  hand-written diff).
- `git apply --whitespace=fix my.patch` — auto-corrects trailing
  whitespace / line-ending mismatches that would otherwise cause a
  whitespace-only apply failure.

## Applying a patch — `patch -pN`

- `patch -p1 < my.patch` is the common case for a `git diff`-style patch
  (paths like `a/src/foo.py` and `b/src/foo.py` — `-p1` strips the leading
  `a/`/`b/` component).
- `-p0` expects paths with NO leading component stripped (a patch
  generated with plain paths, not `git diff`'s `a/`/`b/` convention) — the
  most common cause of "patch does not apply" from `patch` specifically is
  using the wrong `-p` level for how the patch's paths were written; check
  the `---`/`+++` header lines in the patch file to tell which convention
  it uses.
- `patch --dry-run -p1 < my.patch` — validates without writing, same idea
  as `git apply --check`.
- A hunk that fails outright is written to a `.rej` file next to the
  target (`file.orig` may also appear) — read the `.rej` file's context
  lines to see exactly which part didn't match, rather than re-running the
  same command hoping for a different result.

## Common failure modes

- **Context/whitespace mismatch**: the target file's surrounding lines
  don't exactly match what the patch expects (a prior edit already changed
  a nearby line, or line endings differ CRLF vs LF). Try
  `--whitespace=fix` (`git apply`) or regenerate the patch against the
  file's actual current content.
- **Wrong base revision**: the patch was generated against a different
  version of the file than the one being patched — `git apply --check`
  or `patch --dry-run` will report which hunks fail; confirm you're
  patching the same base commit the diff was taken from.
- **Wrong strip level (`-p`)**: see above — mismatched leading path
  components are the single most common `patch -pN` failure and are
  fixable by trying the other strip level rather than debugging the diff
  content itself.
- **Line-ending mismatch (CRLF vs LF)**: a patch generated on one line-
  ending convention applied to a file using the other fails on every hunk
  that touches an affected line, not just one — normalize line endings
  first if this is suspected (mixed line endings in one file is also worth
  checking for directly).
- **Partial application**: some hunks apply, others don't — `git apply`
  refuses to leave the tree partially patched by default (all-or-nothing);
  `patch` may apply what it can and report failures per-hunk via `.rej`
  files — check which behavior the tool you used has before assuming the
  whole patch either fully applied or fully didn't.

## Verifying a patch actually took effect

After applying, don't just trust a zero exit code — `git diff` (or `git
status`) to confirm the expected files actually changed, and re-run
whatever check the patch was meant to fix. A patch can report success
while applying to the wrong file, or applying a hunk in a location that
doesn't semantically match its intent even though the context lines
technically matched (rare, but possible with a very generic context block
repeated elsewhere in the file).
