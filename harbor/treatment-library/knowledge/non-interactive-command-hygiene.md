---
name: non-interactive-command-hygiene
description: Run git, apt, and other CLI tools in a non-interactive shell without hanging — pagers, confirmation prompts, and commands that silently wait on stdin forever with no error and no timeout.
tags: [non-interactive, pager, hang, timeout, prompt, stdin, apt, git-pager, DEBIAN_FRONTEND, no-pager]
searchHints:
  - "command hangs and never returns"
  - "git command opens a pager and hangs"
  - "apt install prompts for confirmation and hangs"
  - "how do I run apt without a confirmation prompt"
  - "process waiting on stdin forever"
  - "command seems stuck no output no error"
  - "how do I disable a pager for a cli tool"
  - "avoid interactive prompts in a script"
when_to_use: "Before running a command that might open a pager, ask for confirmation, or wait on stdin, in a context with no human to answer — or when a command has already stopped producing output and appears stuck."
---

# Non-interactive command hygiene

Many everyday CLI tools assume an interactive terminal with a human
available to page through output or answer a prompt. In a non-interactive
context (a script, an automated session with no human watching) the same
command doesn't fail — it silently WAITS, often with no output and no error
message, until something external kills it. This is one of the most
common causes of an apparently "stuck" command that isn't actually broken.

## Commands that open a pager by default

- `git log`, `git diff`, `git show`, `git branch` (with no args) and
  several other git subcommands pipe their output through `$PAGER`
  (usually `less`) when stdout is a terminal — and `less` waits for input
  to scroll or quit.
- Fix: `git --no-pager log`, or set `git config --global core.pager cat`
  once for the whole session, or pipe explicitly (`git log | cat`) which
  makes git detect a non-terminal stdout and skip the pager on its own in
  most configurations.
- `man`, `psql`, `mysql`, `kubectl explain`, and many other tools have the
  same pager-by-default behavior — the general fix is the same: an
  explicit `--no-pager`/`--pager=cat` flag where available, or pipe to
  `cat`/redirect to a file to make the tool detect non-interactive output.

## Package managers prompting for confirmation

- `apt`/`apt-get install` (Debian/Ubuntu) prompts `Do you want to
  continue? [Y/n]` by default — use `apt-get install -y` (assume yes) and
  set `DEBIAN_FRONTEND=noninteractive` in the environment to also suppress
  debconf prompts (a service restart question, a config-file-conflict
  prompt) that `-y` alone does not cover.
- `yum`/`dnf install -y` — same idea, `-y` assumes yes to the main prompt.
- `npm install` generally does not prompt in modern versions, but
  `npm init` does — use `npm init -y` for defaults.
- A prompt that repeats even with `-y` passed is usually a DIFFERENT
  prompt than the one `-y` covers (a debconf question, a license
  acceptance, an interactive config merge) — read what the prompt is
  actually asking rather than assuming `-y` should have silenced it, and
  look for that specific tool's non-interactive flag or env var.

## Commands that wait on stdin with no prompt text at all

Some commands wait for stdin input with NO visible prompt — the process
just appears to hang with no output and no error, which is easy to
misdiagnose as "frozen" or "crashed" rather than "waiting":

- Any command run with no input redirection that internally calls
  `read`/`input()`/`Scanner` equivalents on stdin.
- `xargs` with no arguments after a pipe that produced zero lines can
  still invoke the command once with no input, and that invocation may
  then wait on ITS OWN stdin if the command itself reads from it.
- A REPL invoked by mistake (running `python` instead of `python script.py`
  drops into the interactive interpreter, which waits on stdin
  indefinitely) — a command that produces no output and no error, ever, is
  more likely to be waiting on input than to be doing silent work; check
  what was actually invoked before assuming it's just slow.
- Fix generally: redirect stdin explicitly (`< /dev/null`) when running a
  command whose interactivity is uncertain, so it fails fast or falls back
  to a default instead of hanging; or use `yes | command` to auto-answer a
  prompt that expects repeated confirmation.

## General non-interactive defaults worth setting up front

- `git --no-pager` (or the config equivalent) for any git command whose
  output you intend to read programmatically or that runs unattended.
- `DEBIAN_FRONTEND=noninteractive` before any `apt`/`apt-get` call in a
  non-interactive context.
- Prefer a command's own `--yes`/`-y`/`--non-interactive` flag over piping
  `yes |` in front of it when one exists — it's more precise about which
  prompts it answers and less likely to silently answer a DIFFERENT,
  unexpected prompt affirmatively.
- When a command genuinely might hang and no non-interactive flag is
  known, wrap it with a `timeout` (`timeout 30 command`) so a stuck
  process surfaces as a clear timeout failure instead of consuming the
  rest of the available time silently.

## Diagnosing a command that already appears stuck

1. Check whether it's actually waiting on stdin vs. genuinely running:
   for a long-running process, checking its state (blocked on a read vs.
   consuming CPU) distinguishes "waiting for input that will never come"
   from "legitimately slow" — see process-port-and-disk-triage for the
   general process-inspection commands.
2. If it's a git/pager-style command, the fix is almost always
   `--no-pager` on a re-run, not waiting longer.
3. If it's a package manager, re-run with the non-interactive flag/env var
   for that specific tool rather than guessing `-y` covers everything.
