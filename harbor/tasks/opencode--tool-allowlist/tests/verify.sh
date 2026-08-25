#!/usr/bin/env bash
# Graded artifact: config/opencode.json -- i.e. /app/config/opencode.json,
# NOT /app/opencode.json.
#
# DO NOT "tidy" this back to the workspace root. The benchmark agent under
# test IS opencode, and it runs with cwd = /app (task.toml
# [environment].workdir). At session start opencode resolves its
# project-level config by walking UP from cwd --
# `findUp(["opencode.json","opencode.jsonc"], cwd, ..., {rootFirst:true})` --
# so a file at /app/opencode.json is claimed as the AGENT'S OWN config:
# loaded, applied to its own session, and rewritten with a
# `"$schema": "https://opencode.ai/config.json"` line, all before the model's
# first turn. `findUp` only ever joins those filenames onto ANCESTOR
# directories and never descends, so a subdirectory is out of reach.
#
# For THIS task the consequence was not a stray rewrite, it was a hard brick:
# opencode's own `tools` key is a `Record<string, boolean>`, and this task's
# CORRECT answer spells it as an ARRAY. Writing the graded answer at
# /app/opencode.json therefore makes opencode refuse to start. Reproduced
# against the pinned opencode-ai@1.18.21, harness-shaped run
# (`opencode --model=<p>/<m> run --format=json --thinking
# --dangerously-skip-permissions -- ...`):
#
#   ./opencode.json        = {"tools":["bash","edit","read"]}
#     -> exit 1, no session, stderr:
#        Error: Configuration is invalid at /app/opencode.json
#        ↳ Expected object | undefined, got ["bash","edit","read"] tools
#
#   config/opencode.json   = same bytes
#     -> opencode starts, session created, reaches the model endpoint;
#        file byte-identical afterwards (sha256 unchanged)
#
# i.e. the oracle answer bricked the agent that was being graded on producing
# it. Moving the artifact is the fix; the ANSWER is deliberately unchanged,
# because the array spelling is what this task measures.
#
# The task's measurement is unchanged by the move: valid JSON, top-level
# `tools` sorted == ["bash","edit","read"].
set -euo pipefail

if [[ ! -f config/opencode.json ]]; then
  echo "config/opencode.json missing"
  exit 1
fi

if jq -e '(.tools | sort) == ["bash","edit","read"]' config/opencode.json >/dev/null; then
  echo "ok"
  exit 0
fi

echo "config/opencode.json tools did not equal [bash, edit, read]"
exit 1
