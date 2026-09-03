---
description: Northwind git branch naming and branch-creation standards
---
# Git standards

## Branch names

`<type>/NW-<ticket>-<kebab-summary>` where `<type>` is one of `feat`, `fix`,
`chore`. The ticket id is mandatory — the release-notes generator parses it
out of the branch name, and a branch without one is skipped silently in the
changelog.

A branch for ticket NW-1234 adding CSV export is:

```
feat/NW-1234-add-csv-export
```

## Creating a branch

Use `git switch -c`, not `git checkout -b`. `checkout` is overloaded and the
platform pre-commit hook detects the reflog signature of a `checkout -b` on a
protected base and refuses the first commit.

```sh
git switch -c feat/NW-1234-add-csv-export
```
