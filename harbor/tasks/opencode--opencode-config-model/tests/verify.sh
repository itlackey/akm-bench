#!/usr/bin/env bash
# Graded artifact: config/opencode.json -- i.e. /app/config/opencode.json,
# NOT /app/opencode.json.
#
# DO NOT "tidy" this back to the workspace root. The benchmark agent under
# test IS opencode, and it runs with cwd = /app (task.toml
# [environment].workdir). At session start opencode resolves its
# project-level config by walking UP from cwd -- `findUp(["opencode.json",
# "opencode.jsonc"], cwd, ..., {rootFirst:true})` in opencode 1.18.x -- so a
# file at /app/opencode.json is claimed as the AGENT'S OWN config. opencode
# then loads it, applies it to its own session, and writes it back with a
# `"$schema": "https://opencode.ai/config.json"` line added, all before the
# model's first turn. That is a benchmark-integrity defect twice over: the
# input the model sees is not the input this task shipped, and the
# manufactured `$schema` is a format declaration that trips the akm-opencode
# write gate on a task whose measurement cell must stay at 0%.
#
# `findUp` only ever joins those filenames onto ANCESTOR directories; it never
# descends. A subdirectory is therefore out of reach. Verified empirically
# against opencode 1.18.11: a real `opencode run` in a directory holding
# `config/opencode.json` left the file byte-identical, while the same run with
# the same content at `./opencode.json` rewrote it with `$schema` (and applied
# the fixture's bogus `opencode/bigpickle` model to its own session, failing
# the run).
#
# The task's measurement is unchanged by the move: valid JSON, top-level
# `model` == `anthropic/claude-opus-4-7`.
set -euo pipefail

if [[ ! -f config/opencode.json ]]; then
  echo "config/opencode.json missing"
  exit 1
fi

if jq -e '.model == "anthropic/claude-opus-4-7"' config/opencode.json >/dev/null; then
  echo "ok"
  exit 0
fi

echo "config/opencode.json did not pin model to anthropic/claude-opus-4-7"
exit 1
