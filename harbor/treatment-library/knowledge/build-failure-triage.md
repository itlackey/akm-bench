---
name: build-failure-triage
description: Systematic procedure and canonical causes for make, cmake, npm, cargo, and pip build failures — try a clean rebuild first, classify undefined-symbol/missing-header/dependency/permission errors, then apply the matching fix.
tags: [build, triage, make, cmake, npm, cargo, pip, linker, compile-error, undefined-symbol, diagnose, clean-rebuild]
searchHints:
  - "why is my build failing"
  - "why is my build failing and what do I check first"
  - "what should I do when a build fails with a linker error"
  - "undefined symbol linker error"
  - "undefined reference to function linker"
  - "cmake configure fails"
  - "make build fails with cryptic error"
  - "npm build fails after dependency update"
  - "cargo build fails to compile"
  - "pip install fails to build wheel"
  - "how do I debug a broken build"
  - "systematic way to debug a broken build"
  - "build worked yesterday now fails"
  - "how do I clear the build cache and rebuild from scratch"
  - "nuke node_modules and reinstall"
when_to_use: "A build, compile, or link step fails and the cause isn't obvious from the last line of output. Try the clean rebuild below FIRST, then classify the failure before investigating further."
---

# Build failure triage

Build failures cluster into a small number of canonical causes across every
toolchain. Rule out stale state first, then classify WHICH category before
trying random fixes.

## Step 0 — try a clean rebuild first

Before investigating anything else, rule out stale/inconsistent local state
— this alone resolves a large fraction of "build is failing for no reason"
reports, and costs only a few minutes:

- **npm/yarn/pnpm**: remove `node_modules/` and the toolchain's cache dir
  (keep the lockfile), then reinstall strictly from it — `npm ci`, not
  `npm install`.
- **cargo**: `cargo clean`, then `cargo build` (`Cargo.lock` is respected by
  default).
- **cmake**: remove the build directory entirely (or at minimum
  `CMakeCache.txt` and `CMakeFiles/`) and reconfigure from scratch — do not
  try to reconfigure in place over a stale cache; cached variables from a
  prior run are a very common source of "impossible" configure errors.
- **pip/venv**: remove and recreate the virtualenv rather than trying to
  force-reinstall into a possibly-corrupted one, then
  `pip install -r requirements.txt` fresh.
- **make**: `make clean` if the Makefile defines it, else remove the
  declared output/object directories, then rebuild.
- If this alone fixes it, the root cause was stale state — worth a one-line
  note if it's likely to recur (a `.gitignore` gap, a cache that should be
  invalidated on a manifest change) but not worth deeper investigation
  otherwise. If it does NOT fix it, the exact error from the clean rebuild
  now rules out stale state as the cause and narrows the remaining
  investigation — proceed to classification below.

## Step 1 — classify the failure

Read the FULL error output (not just the last line) and classify it into
one of these categories before doing anything else.

### Linker errors — "undefined symbol" / "undefined reference"

Message shapes: `undefined symbol: foo`, `undefined reference to
'foo'`, `ld: symbol(s) not found`, `LNK2019 unresolved external symbol`.

This means the COMPILER succeeded (it accepted the declaration) but the
LINKER cannot find the actual implementation. Canonical causes, in order of
likelihood:

1. **The library providing the symbol isn't linked at all.** Check the
   link flags (`-lfoo`, a CMake `target_link_libraries`, a missing
   dependency in a Makefile) — the declaration (header) can be visible
   without the implementation (`.a`/`.so`/`.lib`) being linked in.
2. **Link order matters for static libraries** on some linkers (classic GNU
   `ld`): a static lib must come AFTER the object files that use its
   symbols on the command line, or its symbols are dropped before they're
   needed. Reordering `-lfoo -lbar` relative to the objects that need them
   often fixes this without any other change.
3. **ABI/name-mangling mismatch**: a C++ symbol expected as C linkage (or
   vice versa) — missing/incorrect `extern "C"`, or the library was built
   with a different compiler/standard library than the code linking
   against it.
4. **Architecture/bitness mismatch**: linking a 32-bit library into a
   64-bit build (or arm64 vs x86_64 on macOS) produces symbol-not-found,
   not a clearer "wrong arch" message on every toolchain.
5. **Stale build artifacts**: an old `.o`/`.a` file left over from before a
   function was added/renamed. A clean rebuild (see below) rules this out
   in seconds — always try it before deeper investigation.

### Missing headers / "No such file or directory" for a `.h`/`.hpp`

- The development package, not just the runtime library, is missing —
  Debian/Ubuntu split runtime and headers (`libfoo` vs `libfoo-dev`), as do
  most Linux distros. Installing `libfoo-dev` (or `-devel` on
  RPM-based distros) is usually the fix, not the runtime package.
- Check the include path (`-I` flags, `CPATH`, CMake
  `include_directories`/`target_include_directories`) actually points at
  where the header lives.

### `make`

- `make: *** No rule to make target 'X'` — the target name is misspelled,
  or a file it depends on doesn't exist yet (check the Makefile's
  dependency graph, not just the failing target).
- Stale incremental state: `make clean && make` (or delete the specific
  stale object files) before debugging further — a huge fraction of "make
  is being weird" reports are stale-object issues.
- `-j<N>` parallel builds can expose missing dependency declarations (a
  target that implicitly relied on build order, which serial `make`
  happened to preserve) — if a build only fails with `-j`, look for a
  missing prerequisite in the Makefile rule, not a code bug.

### `cmake`

- Configure failures (`cmake ..` itself failing) are almost always: a
  required package not found (`find_package` failing — check the reported
  search paths and `CMAKE_PREFIX_PATH`), or a stale `CMakeCache.txt` from a
  previous configure with different options/paths.
- **Always delete the build directory (or at least `CMakeCache.txt`) and
  reconfigure from scratch** before deep-diving a confusing CMake error —
  cached variables from a prior run are a very common source of
  "impossible" configure errors.
- A successful configure but failing build points at the actual
  compiler/linker step — apply the linker-error or missing-header guidance
  above.

### `npm` / `yarn` / `pnpm` (JS/TS builds)

- Build fails right after a dependency bump: check for a breaking change in
  that dependency's changelog; pin back temporarily to confirm it's the
  cause.
- `Module not found` at build time but the package is in
  `package.json`: `node_modules` is out of sync with the lockfile — see the
  dependency/lockfile doc, and try a clean install first.
- Native addon build failures (`node-gyp` errors) usually mean a missing
  system build toolchain (`build-essential`/Xcode command line tools) or a
  Node version mismatch with a prebuilt binary — check the addon's engine
  requirements against your Node version.
- TypeScript build errors that don't reproduce in the editor: the editor
  and the build may be using different `tsconfig.json` files or different
  TypeScript versions — confirm both point at the same config and version.

### `cargo` (Rust)

- Compile errors from `rustc` are usually precise and actionable — read the
  FULL message including the "help:" and "note:" lines, not just the first
  line; Rust's compiler frequently states the fix directly.
- Version conflicts between crates: `cargo tree -d` shows duplicate
  dependency versions; `Cargo.lock` pins exact versions — deleting it and
  re-resolving (`cargo update`) can both fix and cause conflicts, so change
  it deliberately, not as a first guess.
- Linker errors from a `-sys` crate (FFI bindings) usually mean the
  underlying C library isn't installed on the system — same as the missing
  headers section above.

### `pip` / Python packaging

- "Failed building wheel for X": the package has a native (C/C++/Rust)
  extension and needs a system build toolchain and headers — check the
  package's install docs for required system packages (often
  `python3-dev`/`python3-devel` plus a compiler).
- Version resolution failures/conflicts: read pip's dependency resolver
  output carefully — it names the exact conflicting requirement chain
  since pip 20.3+; don't guess, read it.
- Building against the wrong Python (`python3` vs a specific venv's
  interpreter) — see the PATH/interpreter-resolution doc.

## Step 2 — narrow with a minimal reproduction

If the clean rebuild + classification doesn't immediately reveal the fix:

- Reproduce the SMALLEST build command that still fails (a single
  target/module rather than the whole project, if the build system
  supports it) — see reproduce-before-you-fix.
- If the build recently started failing and there's relevant history,
  bisect it (bisecting-code-and-commits) — across commits if it's a code
  change, or across dependency versions if it started after an update.

## Step 3 — verify the fix narrowly, then broadly

1. Re-run the SAME minimal failing build command first — confirm the
   specific error is gone, not just that SOMETHING now builds.
2. Run the full build.
3. Run the test suite — a build that succeeds can still be silently wrong
   if the fix changed behavior unintentionally (e.g. relaxing a version
   pin, changing a compiler flag).

## Anti-patterns

- Jumping to "delete node_modules and reinstall everything" (or the
  equivalent nuke-and-reinstall for another ecosystem) as the FIRST and
  ONLY move for every build failure, without ever reading the actual
  error once Step 0 doesn't fix it — Step 0 is a reasonable hygiene check,
  not a substitute for understanding a genuine linker/dependency/permission
  error that will simply recur after reinstalling.
- Force-installing past a dependency resolver's objection
  (`--legacy-peer-deps`, `--force`) as a default reflex rather than a
  deliberate, confirmed-safe choice.
- Widening file permissions to fix a build permission error instead of
  running the specific step as the correct user.

## Related references

- dependency-and-lockfile-errors (knowledge)
- missing-headers-and-permissions (knowledge)
