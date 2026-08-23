---
name: sed-awk-jq-xargs-recipes
description: sed, awk, jq, and xargs one-liners for text and JSON processing — in-place substitution, column extraction, piping found files into a batch command.
tags: [sed, awk, jq, xargs, cli, one-liner, text-processing, json]
searchHints:
  - "how do I parse json on the command line"
  - "how do I replace a string in all of the files"
  - "sed find and replace in place across files"
  - "awk extract a column from output"
  - "jq parse json from the command line"
  - "xargs run a command on each found file"
  - "one-liner to process command output"
---

# sed, awk, jq, xargs recipes

The combination of these four tools covers most command-line text and data
munging without writing a script.

## `sed` — stream editing

- In-place substitution in one file: `sed -i 's/old/new/g' file.txt`
- In-place across many files (BSD/macOS needs `sed -i '' ...`, GNU/Linux
  needs `sed -i ...` with no argument after `-i`; check your platform):
  `sed -i 's/old/new/g' *.txt`
- Substitution across all files found by a search:
  `grep -rl "old" . | xargs sed -i 's/old/new/g'`
- Delete lines matching a pattern: `sed '/pattern/d' file.txt`
- Print only a line range: `sed -n '10,20p' file.txt`
- Escape special regex characters (`. * [ ] ^ $ \`) when the search string
  isn't meant as a pattern — or use `sed 's|old/path|new/path|g'` with an
  alternate delimiter to avoid escaping slashes in paths.
- **Always test on one file (or with no `-i`) before running `-i` across
  many files** — an in-place edit has no undo short of git.

## `awk` — column/field processing

Field references are `$N` for the Nth whitespace-delimited field (`$0` is
the whole line); the examples below use field 4, 5, and 6 to illustrate the
syntax, but any field number works the same way.

- Print a specific column (whitespace-delimited by default):
  `awk '{print $4}' file.txt`
- Custom delimiter (e.g. CSV): `awk -F',' '{print $5}' file.csv`
- Sum a column: `awk '{sum += $4} END {print sum}' file.txt`
- Filter rows by a condition on a field:
  `awk '$5 > 100 {print $0}' file.txt`
- Print with a different output separator:
  `awk -F',' 'BEGIN{OFS="\t"} {print $4, $5}' file.csv`
- Combine with `ps`/`df`/other columnar CLI output — this is the most
  common real use: extracting a PID, a percentage, a size from tool
  output rather than from a file. For example, `df -h` prints use-percent
  in field 5 and the mount point in field 6:
  `df -h | awk '{print $5, $6}'`.

## `jq` — JSON on the command line

- Pretty-print: `jq . file.json` or `curl ... | jq .`
- Extract a field: `jq '.data.items' file.json`
- Extract from an array: `jq '.items[].name' file.json`
- Filter an array by a field value:
  `jq '.items[] | select(.status == "failed")' file.json`
- Compact single-line output (good for piping onward): `jq -c '.items[]'`
- Raw string output without quotes (good for piping into another command):
  `jq -r '.items[].id'`
- Build a new object/shape: `jq '{id: .id, name: .user.name}' file.json`
- Read from `package.json`/`Cargo.toml`(after `toml2json` for the latter)/
  any structured build manifest instead of grepping it as plain text when
  you need one specific field reliably: `jq -r '.version' package.json`.

## `xargs` — turning a list into command invocations

- Run a command once per line of input:
  `find . -name "*.log" | xargs rm`
- Preview what would run without executing (use `echo` as a dry run):
  `find . -name "*.log" | xargs echo rm`
- Handle filenames with spaces safely (`-print0` / `-0` pairing):
  `find . -name "*.log" -print0 | xargs -0 rm`
- Run one invocation PER item rather than batching all items into one
  command line (needed when the command doesn't accept multiple
  arguments): `cat urls.txt | xargs -n1 curl -O`
- Run in parallel: `cat list.txt | xargs -P4 -n1 some-command` (4 at a
  time).
- Confirm before each run (careful/destructive operations):
  `find . -name "*.tmp" | xargs -p rm`

## Composing them together

- Find files, extract a field from each, and feed into a batch command:
  `find . -name "*.json" | xargs -I{} jq -r '.id' {}`
- Grep for matching files, then sed-replace in just those:
  `rg -l "OLD_API_NAME" | xargs sed -i 's/OLD_API_NAME/NEW_API_NAME/g'`
- Extract a column from `ps`/`docker ps`/`kubectl get pods` output and act
  on it: in `ps aux` output, the PID is field 2 and %CPU is field 3, so
  `ps aux | awk -v pidf=2 -v cpuf=3 '$cpuf > 50 {print $pidf}' | xargs -r kill`
  kills every process using more than 50% CPU — verify the column meanings
  for your platform's `ps` output before running anything destructive like
  this.

## Safety notes

- Prefer a dry run (`echo` prefix, or a non-destructive equivalent) before
  piping into `rm`, `kill`, or any in-place edit at scale.
- `sed -i` and `xargs ... rm` are both irreversible outside of git/backups
  — double-check the input list before the destructive step, not after.
