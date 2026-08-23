---
name: running-a-single-test-fast
description: Run exactly one test by name instead of the whole suite — pytest -k/-x, jest -t, go test -run, cargo test, mocha --grep, rspec -e, and how to keep iteration under a few seconds.
tags: [test, pytest, jest, go-test, cargo-test, mocha, rspec, single-test, fast-iteration]
searchHints:
  - "how do I run only one test"
  - "what is the command to run one test by name"
  - "run just one test by name"
  - "run a single test fast"
  - "how to run only one test file"
  - "pytest run one test function"
  - "jest run a single test"
  - "go test run one function only"
---

# Running a single test fast

Running the full suite for every iteration is the single biggest tax on
debugging speed. Always narrow to the smallest command that still exercises
the failure before you start iterating on a fix.

## Python — pytest

- One test function: `pytest path/to/test_file.py::test_name`
- One class/method: `pytest path/to/test_file.py::TestClass::test_method`
- By substring match (no exact path needed): `pytest -k "substring"`
- Stop at the first failure: `pytest -x`
- Show full diff/locals on failure: `pytest -vv --showlocals`
- Re-run only what failed last time: `pytest --lf` (last-failed) or
  `pytest --ff` (failed-first)
- Skip slow/marked tests while iterating: `pytest -m "not slow"`

## Python — unittest

- `python -m unittest path.to.module.TestClass.test_method`

## JavaScript / TypeScript — Jest

- One test by name pattern: `jest -t "test name substring"`
- One file: `jest path/to/file.test.ts`
- Watch mode, rerun on save, filtered to changed files:
  `jest --watch` or `jest --watchAll`
- Only rerun previously failed: `jest --onlyFailures`

## JavaScript — Mocha

- `mocha --grep "test name substring" path/to/file.test.js`
- `.only` on a `describe`/`it` block runs just that block for that file
  (remember to remove it before committing).

## JavaScript — Vitest

- `vitest run -t "test name substring"`
- `vitest related path/to/file.ts` runs only tests related to changed files.

## Go

- One test function: `go test -run '^TestName$' ./path/to/package`
- Verbose output: `go test -v -run '^TestName$' ./...`
- `-run` is a regex match against test names — anchor with `^...$` to avoid
  accidentally matching multiple tests with overlapping names.

## Rust — cargo test

- By substring: `cargo test test_name`
- Exact match only: `cargo test --exact test_name`
- Show println! output even on pass: `cargo test -- --nocapture`
- Single-threaded (useful for flaky/order-dependent tests):
  `cargo test -- --test-threads=1`

## Ruby — RSpec / Minitest

- RSpec by line number: `rspec path/to/spec.rb:42`
- RSpec by description: `rspec -e "example description substring"`
- Minitest by name: `ruby -Itest test/file_test.rb -n test_method_name`

## Java — Maven / Gradle

- Maven, one test class: `mvn test -Dtest=ClassName`
- Maven, one method: `mvn test -Dtest=ClassName#methodName`
- Gradle: `gradle test --tests "com.pkg.ClassName.methodName"`

## General discipline

- Narrow to ONE failing test before making any code change. Confirm it
  fails for the reason you think it fails (read the assertion diff, not
  just "FAILED").
- After the fix, run that same single test again first — fast loop — THEN
  run the full surrounding file/module, THEN the full suite before calling
  it done. Do not jump straight from "single test iteration" to "assume
  it's fine" without the broader run.
- If a single-test command doesn't exist for your framework, check for a
  `--filter`, `-k`, `--grep`, or `-t` flag first — nearly every test runner
  has one even when the exact flag name differs.
- If you only have a partial or approximate test name, search for it first
  (`rg` the test file for the name/substring) rather than guessing a
  flag value — report the closest matches found instead of running the
  wrong test and misreading its result as the one you meant.
