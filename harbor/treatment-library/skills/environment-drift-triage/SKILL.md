---
name: environment-drift-triage
description: Diagnose "works on my machine" and broken-toolchain problems systematically — check PATH/interpreter resolution, virtualenv or node_modules state, and permissions in that order before touching application code.
tags: [environment, works-on-my-machine, path, virtualenv, node-modules, permissions, triage]
searchHints:
  - "why does it work on my machine but not in ci"
  - "why is my environment behaving differently"
  - "works on my machine but not elsewhere"
  - "environment is broken don't know why"
  - "toolchain acting weird after setup"
  - "diagnose environment before debugging code"
  - "different behavior on different machines"
  - "works locally but not in ci"
---

# Environment drift triage

When something fails in one environment (a teammate's machine, CI, a
container, after a fresh clone) but works in another, resist debugging the
APPLICATION CODE first. Confirm the environment is actually equivalent
before assuming the code has a bug — a large fraction of these reports are
environment drift, not logic errors.

## Triage order

1. **Interpreter/binary identity.** Is the SAME version of the language
   runtime actually running in both places? `python --version` /
   `python -c "import sys; print(sys.executable)"`, `node --version`,
   `which <tool>` in both environments — see path-and-interpreter-resolution
   for the full diagnostic recipe. A silently different interpreter
   version is the single most common cause of "works here, not there."
2. **Dependency state.** Does the failing environment actually have the
   SAME installed dependency versions as the working one? Compare lockfile
   hashes/versions, not just "I ran install" — a stale `node_modules`, a
   venv installed before a manifest change, or a `pip install` that ran
   outside the intended venv all produce silent drift. See
   dependency-and-lockfile-errors.
3. **Environment variables and config.** Diff the actual env vars between
   the two environments (`env | sort` in both, diff the output) rather than
   assuming they match because "the .env file is the same" — shell rc
   files, CI secrets, and container defaults all inject or override vars
   outside that file.
4. **Permissions and filesystem state.** Confirm the failing environment
   isn't hitting a permission error masquerading as something else (a
   read-only mount, a file owned by the wrong user after a Docker bind
   mount) — see missing-headers-and-permissions.
5. **Only after 1–4 check out**, treat it as a genuine code/logic
   difference and debug it as a normal bug (systematic-debugging).

## Fast environment-equivalence check

Before deep diagnosis, run a small set of commands in BOTH environments and
diff the output directly — this is usually faster than reasoning about what
COULD differ:

```
echo "interpreter: $(which python || which node || which <tool>)"
<tool> --version
env | sort
<tool> -m pip freeze 2>/dev/null || npm ls --depth=0 2>/dev/null
```

A diff of this output against the working environment usually points
straight at the drifted variable, version, or missing dependency.

## Common root causes, ranked by frequency

1. Different dependency versions (stale lockfile, `node_modules` not
   reinstalled after a manifest change, a venv built before a requirements
   update).
2. Different interpreter/runtime version (a version manager not switching
   as expected in a non-interactive shell — see path-and-interpreter-resolution).
3. Missing or differently-valued environment variable (a secret or config
   value present locally via a personal shell rc file, absent in CI/a
   teammate's fresh setup).
4. Different OS/platform behavior (a path separator, a case-sensitivity
   difference, a locale/timezone default) — most common in
   "works on my Mac, fails in Linux CI" reports.
5. Permission/ownership difference (a file created as root inside a
   container, a read-only CI checkout).

## Related references

- path-and-interpreter-resolution (knowledge)
- dependency-and-lockfile-errors (knowledge)
- missing-headers-and-permissions (knowledge)
- diagnosing-flaky-tests (knowledge) — for the specific "only fails in CI"
  test case, which overlaps with but is not identical to general
  environment drift.
