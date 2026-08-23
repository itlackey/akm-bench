---
name: git-log-and-blame-archaeology
description: Dig through git history to find who changed a line and why — log --follow across renames, blame, the pickaxe search (-S/-G) for when a string or pattern was added or removed, and reflog for recovering lost commits.
tags: [git, blame, log, pickaxe, reflog, history, archaeology]
searchHints:
  - "how do I find out who changed this line and why"
  - "how do I find the author of a line of code"
  - "who changed this line and why"
  - "find when a function was added"
  - "search git history for a string that was removed"
  - "git blame shows a merge commit not the real author"
  - "recover a commit that disappeared"
  - "trace file history across a rename"
---

# Git log and blame archaeology

Before changing code you don't understand, find out how it got that way.
Git history usually answers "why is this here" faster than reading the code
in isolation.

## `git log` for a file or line range

- Full history of a file, following renames:
  `git log --follow -- path/to/file`
- Show the actual diffs, not just messages:
  `git log -p --follow -- path/to/file`
- History of just a line range (very targeted):
  `git log -L 10,25:path/to/file`
- One-line summaries for fast scanning:
  `git log --oneline --follow -- path/to/file`
- Commits touching a specific function (works well in C-like/Python/etc.
  languages git can parse):
  `git log -L :function_name:path/to/file`

## `git blame`

- `git blame path/to/file` shows the last commit to touch each line.
- `git blame -L 40,60 path/to/file` limits to a line range — much faster and
  more readable on large files.
- **Skip past a noisy commit** (a mass reformat, a mechanical rename) to see
  who *actually* wrote the logic:
  `git blame --ignore-rev <commit> path/to/file`, or maintain a
  `.git-blame-ignore-revs` file and configure
  `git config blame.ignoreRevsFile .git-blame-ignore-revs`.
- `git blame -w` ignores whitespace-only changes when attributing lines.
- `git blame -C` detects lines moved/copied from elsewhere in the same
  commit (and `-CC`/`-CCC` extend detection across files/older commits) —
  use this when blame keeps attributing a moved block to the move, not the
  original author.
- Once you have the commit hash, `git show <commit>` shows the full diff and
  message together — read the message, not just the diff, for intent.

## Pickaxe search — "when was this string/pattern added or removed"

- `git log -S"exact_string"` finds commits where the number of occurrences
  of `exact_string` CHANGED (added or removed) — the classic way to find
  when a specific function name, config key, or literal was introduced or
  deleted.
- `git log -G"regex_pattern"` finds commits where a line MATCHING the regex
  was added or removed, even if the total occurrence count didn't change —
  better for finding *any* touch to lines matching a pattern, not just net
  additions/removals.
- Add `-p` to see the actual diff for each matching commit:
  `git log -p -S"exact_string" -- path/to/file`
- Narrow by path to cut noise: `git log -S"foo" -- src/`
- `-S` and `-G` both search the whole repo by default — always add
  `-- <path>` once you have a rough area, or the result set is huge.

## `git reflog` — recovering "lost" commits

- `git reflog` shows every place HEAD has pointed, including commits no
  longer reachable from any branch (after a reset, a rebase, an amend, a
  deleted branch).
- Find the commit you want in the list, then `git checkout <hash>` or
  `git branch recovery-branch <hash>` to get it back.
- The reflog is LOCAL and time-limited (default ~90 days for reachable, ~30
  for unreachable entries) — it does not help recover something from
  someone else's machine or a force-push that happened before you last
  fetched.

## Practical recipe: "why does this weird line exist"

1. `git blame -L <start>,<end> file` to get the commit.
2. `git show <commit>` to read the full diff and commit message.
3. If the message is unhelpful ("fix bug", "wip"), check if it references
   an issue/ticket number, or look at the commits immediately before/after
   it on the same file for context.
4. If blame points at a mechanical commit (reformat/rename), re-run blame
   with `--ignore-rev` or walk further back with `git log -L` on that line
   range to find the substantive change underneath it.
