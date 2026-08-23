---
name: codebase-orientation
description: Orient quickly in an unfamiliar codebase — find the real entry point, identify the manifest and build system, trace one feature end to end from the outside boundary to the data layer, and know when to widen the trace before changing code.
tags: [codebase, orientation, entry-point, unfamiliar-repo, trace-feature, onboarding, new-repo]
searchHints:
  - "where do I start in an unfamiliar codebase"
  - "how do I find my way around a new repo"
  - "where is the entry point of this codebase"
  - "how to understand a new unfamiliar codebase"
  - "trace a feature from the api to the database"
  - "find where a request is handled"
  - "unfamiliar repo where do I start reading"
  - "just cloned this repo where do I start"
  - "new to this codebase need to make a change fast"
  - "first time in this repo"
when_to_use: "On first contact with a repo you've never seen, scoped to the change you actually need to make rather than full comprehension."
---

# Codebase orientation

The goal on first contact with an unfamiliar repo is not to read
everything — it's to build a rough MAP fast: what runs, where it starts,
and how the major pieces connect. Depth comes later, on the specific area
you actually need to change.

## Step 1 — identify the manifest and toolchain

The manifest file tells you the language, the build/run commands, and
often the entry point directly:

- `package.json` (Node/JS/TS) — check `"main"`, `"scripts"` (especially
  `start`/`dev`/`build`/`test`), and `"bin"` for CLI entry points.
- `pyproject.toml` / `setup.py` / `setup.cfg` (Python) — check
  `[project.scripts]` / `entry_points` for CLI commands, and look for a
  `__main__.py` or a conventionally named `main.py`/`app.py`/`cli.py`.
- `Cargo.toml` (Rust) — `src/main.rs` is the binary entry point by
  convention; `[[bin]]` sections name additional binaries.
- `go.mod` plus a `package main` file with `func main()` — usually in
  `cmd/<name>/main.go` in larger Go repos.
- `pom.xml` / `build.gradle` (Java) — look for a class with
  `public static void main`, often named in the build config's
  `mainClass`.
- A `Makefile`, `justfile`, or `Taskfile.yml` at the repo root often
  documents the actual day-to-day commands (build/test/run/lint) more
  reliably than the README.
- A top-level `README.md` — skim for "Getting Started"/"Development"
  sections even if you don't trust the rest of it to be current; setup
  commands are usually kept accurate because they're exercised often.

## Step 2 — find the real entry point

- CLI tool: search for `func main(` / `def main(` / `if __name__ ==
  "__main__"` / the binary's declared entry in the manifest.
- Web service: search for where the HTTP server/router is constructed
  (`app.listen`, `http.ListenAndServe`, `uvicorn.run`, a framework's
  `App()`/`Router()` construction) — that's where requests first enter
  your code.
- Library (no standalone entry point): the manifest's exported
  surface (`package.json` `"exports"`/`"main"`, an `__init__.py`'s
  imports, a `lib.rs`) tells you what's actually PUBLIC — start there
  rather than an arbitrary internal file.

## Step 3 — trace one feature end to end

Pick ONE concrete, narrow feature (ideally the one you actually need to
touch) and trace it fully from the outside boundary to the data layer,
rather than trying to understand the whole system at once:

1. Find where the request/input enters (a route handler, a CLI subcommand,
   an event handler, a message queue consumer).
2. Follow the call chain one hop at a time — use "go to definition" if
   your editor/agent tooling supports it, or `rg` for the function/class
   name to find its definition and other call sites.
3. Identify the boundary where it touches persistent state (a database
   query, a file write, a cache, an external API call) — this is usually
   where the interesting business logic lives.
4. Note every abstraction layer crossed (a service layer, a repository
   pattern, a middleware chain, dependency injection) — write down the
   names even if you don't yet understand each one fully; you now have a
   map for the next feature, which likely reuses the same layers.
5. Find the corresponding TEST for this feature (search test directories
   for the feature/function name) — tests are often the most concise,
   accurate description of intended behavior, more reliable than comments.

## Step 4 — orient around conventions, not just code

- Directory naming conventions (`src/`, `lib/`, `internal/` in Go meaning
  "not importable outside this module", `test/`/`spec/`/`__tests__/`)
  signal architecture decisions before you read a single file inside them.
- Check for an architecture doc, ADRs (architecture decision records,
  often in `docs/adr/` or similar), or a CONTRIBUTING.md — these
  explain WHY, which grepping the code alone cannot.
- Look at recent, small, well-described commits (`git log --oneline -20`)
  for a sense of current active areas and the team's typical change size —
  useful calibration for how large a change is "normal" here.

## What to skip on first pass

- Generated code, vendored/third-party directories, build output
  directories — these bulk up a repo without teaching you its actual
  design.
- Full test-suite reading — sample a few relevant tests, don't read every
  test file up front.
- Deep-diving unrelated modules "just in case" — go deep only on the area
  you're actually changing; breadth-first orientation, depth-first
  implementation.
- Historical git archaeology beyond a quick `git log --oneline -20` for
  calibration — go deeper (git-log-and-blame-archaeology) only for the
  specific lines you're about to change, and only if their intent isn't
  otherwise clear from the code and its tests.

## Make the smallest possible first change, then verify

Once oriented, make the smallest possible first change in the traced area
and verify it end to end (build + the specific test covering that path)
before expanding scope. This both confirms your mental model of the traced
path is correct and keeps the change reviewable if the model turns out to
be wrong — see incremental-change-discipline for the general version of
this loop.

## Red flags that mean you should widen the trace before changing code

- The path you traced touches shared/global state also used by other
  features (a shared cache, a shared config object) — a change here can
  have effects outside the feature you're focused on; identify the other
  consumers before changing shared behavior.
- The existing tests for this path are thin or absent — treat this as a
  signal to write a characterization test (a test that pins CURRENT
  behavior) before changing anything, so you have a way to detect an
  unintended behavior change.
- The code you're about to change doesn't match the conventions you saw
  elsewhere in the repo — that mismatch is itself worth understanding
  (deliberate exception, or just older code) before adding to it.
