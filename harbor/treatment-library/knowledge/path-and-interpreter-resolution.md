---
name: path-and-interpreter-resolution
description: Diagnose PATH, PYTHONPATH, and interpreter resolution problems — wrong python or node picked up, ModuleNotFoundError/ImportError despite the package being installed, virtualenv not actually active, command not found despite being installed, and how which/type/command -v find the real answer.
tags: [path, pythonpath, sys.path, environment-variable, virtualenv, venv, interpreter, which, shell, ModuleNotFoundError, ImportError, relative-import]
searchHints:
  - "why is the wrong version of python being used"
  - "why does it say command not found when it is installed"
  - "wrong python interpreter being used"
  - "virtualenv active but wrong package version"
  - "command not found but it is installed"
  - "which python am I actually running"
  - "path environment variable not picking up the right binary"
  - "node version mismatch nvm not switching"
  - "ModuleNotFoundError no module named"
  - "ImportError cannot import name"
  - "python can't find my package even though it's installed"
  - "attempted relative import with no known parent package"
when_to_use: "A command runs the wrong binary/version, a Python import fails despite the package apparently being installed, or something works in one shell/terminal but not in a script, CI step, or subprocess."
---

# PATH and interpreter resolution

Most "it works when I run it manually but not from X" and "wrong
version got picked up" problems are PATH resolution problems: the shell
found a DIFFERENT binary than the one you expected, earlier in `$PATH`.

## How to find out what's actually running

- `which python` / `which node` / `which <command>` — the first match in
  `$PATH`, in order. This is what will actually run when you type the bare
  command.
- `which -a python` — ALL matches in `$PATH`, in order — shows you exactly
  what's shadowing what.
- `type python` — like `which`, but also reports shell builtins, aliases,
  and functions (`which` alone can miss these, especially for shell
  builtins or an alias that isn't a real binary at all).
- `command -v python` — POSIX-portable equivalent of `which`, prefer this
  in scripts.
- `echo $PATH` — print the search order directly; read it left to right,
  the first directory containing a matching binary wins.
- Confirm the VERSION of what you found: `python --version`,
  `python -c "import sys; print(sys.executable)"` (prints the actual
  interpreter binary path being used, which is the ground truth — more
  reliable than trusting `which` alone in edge cases involving shell
  functions/wrappers).

## Virtualenv "active" but wrong package / wrong python

- Confirm the venv is ACTUALLY active: `echo $VIRTUAL_ENV` should print
  the venv's path; if empty, activation didn't take (wrong shell, sourced
  in the wrong shell/subshell, or activation script failed silently).
- `which python` after activating should point INSIDE the venv directory
  (e.g. `.venv/bin/python`) — if it still points at a system path, the
  venv's `bin/` directory isn't actually first in `$PATH`, often because
  something later in your shell rc file re-prepends a different path after
  activation.
- Installing with `pip install X` while the venv is NOT active silently
  installs into the system/user site-packages instead — always confirm
  `which pip` (or `python -m pip`) points into the venv immediately before
  installing.
- A background process (an IDE's integrated terminal, a subprocess spawned
  by a script, a systemd service) often does NOT inherit your interactive
  shell's activated venv — it needs the venv's `bin/` explicitly on its
  `PATH`, or needs to be invoked with the venv's python binary directly
  (`/path/to/.venv/bin/python script.py`) rather than relying on
  activation.
- Prefer `python -m pip install ...` over a bare `pip install ...` when in
  doubt — it uses whichever `python` is currently first on `PATH`, making
  the target interpreter explicit and removing one layer of ambiguity.

## `ModuleNotFoundError` / `ImportError` — Python's own resolution path

`PATH` finds the `python` BINARY; it has no bearing on which Python
MODULES that interpreter can then import. That is a completely separate
search, `sys.path`, and it is the more common source of "installed but not
found" for Python specifically:

- `python -c "import sys; print(sys.path)"` shows the exact search order
  for `import` statements in that interpreter — read it in order, the same
  as `$PATH` for binaries.
- `PYTHONPATH` (an env var) is PREPENDED to `sys.path`, ahead of the
  interpreter's own standard library and site-packages search — a stale or
  unintentionally-set `PYTHONPATH` (inherited from a parent shell, a CI
  step, a wrapper script) can shadow the real installed package with an
  unrelated same-named directory, or vice versa.
- `pip install X` installs into the CURRENT interpreter's site-packages
  (see the virtualenv section above for confirming which interpreter that
  is) — installing with one Python and running with another reproduces
  `ModuleNotFoundError` even though "it's installed" is true for a
  DIFFERENT interpreter.
- `pip install -e .` (editable/development install) makes a package
  importable from its SOURCE checkout without a full install-and-copy —
  but only takes effect for interpreters/environments it was run against,
  and a subsequent `pip install .` (non-editable) or a fresh venv will not
  automatically pick it back up; re-run `-e .` in the new environment if
  edits stop being reflected.
- **Running a script directly vs. as a module changes `sys.path`.**
  `python path/to/script.py` puts that script's OWN directory first on
  `sys.path`; `python -m package.module` puts the CURRENT WORKING
  DIRECTORY first instead. A package that imports fine one way and raises
  `ModuleNotFoundError` the other way is almost always this distinction,
  not a broken install.
- `ImportError: attempted relative import with no known parent package` —
  a relative import (`from . import foo`) was used in a file executed
  directly as a script rather than imported as part of a package; run it
  with `python -m package.module` instead, or restructure the entry point
  to import the package properly rather than running the file path
  directly.
- `ModuleNotFoundError` for a package that IS in `requirements.txt` /
  `pyproject.toml`: confirm the install actually ran against the
  interpreter you're now using (see the virtualenv section above) before
  assuming the dependency declaration itself is wrong.

## Node version resolution (nvm and friends)

- `which node` / `node --version` — same idea as Python: confirm what's
  actually first in `PATH`.
- `nvm` (and similar version managers) work by PREPENDING the selected
  version's `bin/` directory to `PATH` in your shell rc file — a NEW
  terminal, a non-interactive shell (many CI runners, some IDE task
  runners, cron), or a script invoked without sourcing your rc file will
  NOT have nvm's PATH modification applied, and will fall back to whatever
  `node` (if any) is otherwise on `PATH`.
- `.nvmrc` in a project directory only auto-switches versions if your
  shell is configured to read it (an rc-file hook, or you explicitly run
  `nvm use`) — it is not automatic by default.
- If a script/CI step needs a specific Node version reliably, source nvm
  and run `nvm use` (or invoke the version manager's equivalent)
  explicitly at the top of that script, rather than assuming the
  interactive shell's state carries over.

## "Command not found" despite being installed

1. Confirm it's actually on disk somewhere: `find / -name "toolname"
   -type f 2>/dev/null` (slow but definitive) or check the package
   manager's install location convention directly (e.g.
   `~/.local/bin`, `/usr/local/bin`, a language-specific bin dir like
   `~/go/bin` or `~/.cargo/bin`).
2. Once found, confirm its directory is actually IN `$PATH`:
   `echo $PATH | tr ':' '\n' | grep <dir>`.
3. If it's not, the install put the binary somewhere your shell doesn't
   search — add that directory to `PATH` in your shell rc file (and open a
   NEW shell/terminal to pick up the change — editing an rc file does not
   affect already-running shells).
4. Watch for install-time PATH advice that's specific to a shell you don't
   use (a tool's installer appending to `~/.bashrc` when your login shell
   is actually zsh, fish, etc.) — check `echo $SHELL` and edit the RIGHT
   rc file.

## Why "it works in my terminal but not in the script/CI"

The most common cause: your INTERACTIVE shell sources an rc file
(`.bashrc`, `.zshrc`) that sets up `PATH`/nvm/pyenv/etc., but a
non-interactive script, cron job, or CI step runs with a different,
minimal environment that never sources that file. Fix by making the
script/CI step set up its own environment explicitly (source the version
manager, or use absolute paths / explicit `PATH` exports) rather than
assuming it inherits your interactive shell's setup.
