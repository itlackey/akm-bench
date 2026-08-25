#!/usr/bin/env bash
# Graded artifact: agent-guidance.md -- i.e. /app/agent-guidance.md, NOT
# /app/AGENTS.md. (The task's id still says "agents-md"; that is a stable
# identifier for slice membership and cross-run comparability, not a path.)
#
# DO NOT rename this back to AGENTS.md. The benchmark agent under test IS
# opencode, and it runs with cwd = /app (task.toml [environment].workdir).
# opencode resolves PROJECT INSTRUCTION FILES by walking UP from cwd --
# `Instruction.systemPaths` in opencode 1.18.x tries the names
# ["AGENTS.md", "CLAUDE.md", "CONTEXT.md"] with
# findUp(name, directory, worktree) -- and splices whatever it finds
# VERBATIM into the system prompt of the agent under test, prefixed
# `Instructions from: <path>`.
#
# This task's deliverable IS such a file. At the old path the model's own
# graded output therefore became the model's own instructions mid-trial: a
# feedback loop, not merely a mutation of the input. That is worse than the
# opencode.json defect fixed in 3c3543d / 0b3507e, where the artifact was
# only read and rewritten as config.
#
# OPENCODE_DISABLE_PROJECT_CONFIG does NOT mitigate it: that flag gates
# project CONFIG discovery, while this file is loaded as INSTRUCTIONS.
#
# findUp only ever joins those three names onto ANCESTOR directories, and it
# only matches those three names, so any other filename is out of reach.
# Verified empirically in a container at the pinned opencode-ai@1.18.21, with
# a harness-shaped run (`opencode --model=<p>/<m> run --format=json
# --thinking --dangerously-skip-permissions -- ...` and a harness-shaped
# global config at ~/.config/opencode/opencode.json) whose model endpoint
# pointed at a listener that logged every outbound request body.
#
# (a) which names opencode claims -- same marker file, one path per run:
#       /app/AGENTS.md  /app/CLAUDE.md  /app/CONTEXT.md   -> spliced into the
#                                                            system prompt
#       /app/docs/AGENTS.md  /app/agent-guidance.md       -> absent from it
#
# (b) task-faithful: this task's own solution/solve.sh, with the OLD path as
#     the positive control in the same container, 9 outbound requests each:
#       /app/AGENTS.md            185256 B   graded text in prompt x6, and
#                                             `Instructions from: /app/AGENTS.md`
#       /app/agent-guidance.md    184110 B   0 hits, no `Instructions from:`
#       (empty /app, baseline)    184110 B
#     i.e. under the new name the request the agent sends is BYTE-IDENTICAL
#     to the baseline with no graded file present at all.
#
# Every file was left byte-identical by the run: instruction files are read,
# not rewritten, so the injection -- not a mutation -- is the whole defect.
#
# What this task measures is unchanged by the rename: the agent must author a
# guidance file containing the literal string `akm search`. Same literal,
# same single check, same difficulty -- the file is created at the workspace
# root either way, so the rename costs no step (no mkdir, no new directory).
set -euo pipefail

if [[ ! -f agent-guidance.md ]]; then
  echo "agent-guidance.md missing"
  exit 1
fi

if grep -q 'akm search' agent-guidance.md; then
  echo "ok"
  exit 0
fi

echo "agent-guidance.md did not mention 'akm search'"
exit 1
