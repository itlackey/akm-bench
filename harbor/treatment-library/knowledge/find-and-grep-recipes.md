---
name: find-and-grep-recipes
description: find, grep, and ripgrep recipes for locating files and code fast in an unfamiliar repo — by name, by content, by recency, and excluding noisy directories.
tags: [find, grep, ripgrep, rg, cli, search, locate-file]
searchHints:
  - "how do I search for a string in all of the files"
  - "what is the fastest way to find a file in a big repo"
  - "find all files matching a pattern"
  - "grep recursively for a string in a repo"
  - "find recently modified files"
  - "search code excluding node_modules"
  - "ripgrep search examples"
  - "find files by name in a large repo"
---

# find and grep recipes

Fast, targeted search beats browsing a file tree by hand, especially in a
codebase you don't know. `rg` (ripgrep) is strongly preferred when
available — it respects `.gitignore` automatically and is dramatically
faster; `grep`/`find` recipes are included for when it isn't installed.

## Finding files by name

- `find . -iname "*pattern*"` — case-insensitive name search from the
  current directory down.
- `find . -maxdepth 2 -name "*.config.js"` — limit depth to avoid
  descending into huge subtrees like `node_modules`.
- `find . -type f -name "*.py" -not -path "*/venv/*"` — exclude a
  directory by path pattern.
- `rg --files -g "*controller*"` — ripgrep's fast file-name glob search
  (skips ignored dirs automatically).

## Searching file contents

- `grep -rn "pattern" .` — recursive, with line numbers.
- `grep -rn --include="*.py" "pattern" .` — restrict to one extension.
- `grep -rln "pattern" .` — list only matching FILE NAMES, not every line
  (faster to scan when you just need to know where).
- `rg "pattern"` — recursive by default, respects `.gitignore`, colorized,
  usually the fastest option.
- `rg -i "pattern"` — case-insensitive.
- `rg -w "pattern"` — whole-word match only (avoids matching inside longer
  identifiers).
- `rg -t py "pattern"` / `rg -t js "pattern"` — restrict to a known file
  type without spelling out globs.
- `rg -g '!*.min.js' "pattern"` — exclude a glob (e.g. minified bundles).
- `rg -C 3 "pattern"` — show 3 lines of context around each match.
- `rg --files-with-matches "pattern"` — just the file list (same idea as
  `grep -l`).

## Excluding noisy directories

- `rg` and `git grep` skip `.gitignore`d directories (like `node_modules`,
  `dist`, `build`, `.venv`) automatically — this alone is often the reason
  to reach for them over plain `grep`/`find`.
- Plain `grep`/`find` need explicit excludes:
  `grep -rn --exclude-dir={node_modules,.git,dist,build,venv} "pattern" .`
  `find . -path "*/node_modules" -prune -o -type f -name "*.js" -print`
- `git grep "pattern"` searches only tracked files in the current git
  checkout — a good middle ground when `rg` isn't installed but you still
  want to skip ignored/untracked noise.

## Finding recently changed files

- `find . -type f -mtime -1` — modified in the last 1 day.
- `find . -type f -newer reference_file` — modified more recently than a
  given reference file (useful for "what changed since I last built").
- `git diff --name-only <ref>` / `git status --porcelain` — for
  git-tracked recency instead of filesystem mtime, which is usually what
  you actually want (filesystem mtime survives a checkout/clone in ways
  that don't reflect the git history).

## Combining find + grep for structured search

- `find . -name "*.py" -exec grep -l "pattern" {} +` — grep only within a
  file-name-filtered set (useful when `rg -t` doesn't have a type mapping
  for an unusual extension).
- `find . -name "*.log" -mtime -1 -exec grep -l "ERROR" {} +` — recent log
  files that contain an error string, a common first move when triaging an
  incident.

## Practical recipes for orienting in a new repo

- Find the entry point: `rg "def main\(" ` (Python) or
  `rg "func main\(" ` (Go) or `rg "\"main\":" package.json` (Node) or
  `rg "public static void main"` (Java).
- Find where a config key is read: `rg "CONFIG_KEY_NAME"` across the repo,
  not just the config file that defines it — shows every consumer.
- Find where an error message originates: `rg "exact error message text"`
  — works even when the code path is deeply nested, since the string
  itself is unique.
- Find all TODO/FIXME markers: `rg "TODO|FIXME|XXX"` (add `-t <lang>` to
  scope to source files only, or `--glob '!**/vendor/**'` /
  `--glob '!**/node_modules/**'` to exclude vendored code from the results).
