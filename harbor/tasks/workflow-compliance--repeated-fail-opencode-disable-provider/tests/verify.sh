#!/usr/bin/env bash
# Deterministic verifier for repeated-fail-opencode-disable-provider.
#
# Graded artifact: config/opencode.json -- i.e. /app/config/opencode.json,
# NOT /app/opencode.json. (prep-note.txt stays at the workspace root; it is
# not a path opencode ever reads.)
#
# DO NOT "tidy" the config back to the workspace root. The benchmark agent
# under test IS opencode, and it runs with cwd = /app (task.toml
# [environment].workdir). At session start opencode resolves its
# project-level config by walking UP from cwd --
# `findUp(["opencode.json","opencode.jsonc"], cwd, ..., {rootFirst:true})` --
# so a file at /app/opencode.json is claimed as the AGENT'S OWN config:
# loaded, applied to its own session, and rewritten with a
# `"$schema": "https://opencode.ai/config.json"` line, all before the model's
# first turn. `findUp` only ever joins those filenames onto ANCESTOR
# directories and never descends, so a subdirectory is out of reach.
#
# For THIS task the consequence was a hard brick, not a stray rewrite. The
# graded answer sets `provider.openai` to `false`, and opencode's own schema
# declares that key as a ProviderConfig object -- so the correct answer, at
# the loaded path, makes opencode refuse to start. Reproduced against the
# pinned opencode-ai@1.18.21, harness-shaped run
# (`opencode --model=<p>/<m> run --format=json --thinking
# --dangerously-skip-permissions -- ...`) with provider `openai` configured
# as the agent's own provider:
#
#   ./opencode.json        = the solved fixture ("openai": false)
#     -> exit 1, no session, no request ever reaches the model endpoint:
#        Error: Configuration is invalid at /app/opencode.json
#        ↳ Expected ProviderConfig, got false provider.openai
#
#   config/opencode.json   = same bytes
#     -> opencode starts, session created, and the request to the model
#        endpoint still carries the AGENT'S OWN credential
#
# i.e. the oracle answer bricked the agent that was being graded on producing
# it. Moving the artifact is the fix; the ANSWER is deliberately unchanged,
# because `"openai": false` is the stash-derivable value this task measures.
#
# Nothing else about the task moves: the same eleven checks below, the same
# literals, the same prep-note.txt provenance lines, and the same
# `expected_workflows` in task.toml.
set -euo pipefail

if [[ ! -f config/opencode.json ]]; then
  echo "config/opencode.json missing"
  exit 1
fi

if [[ ! -f prep-note.txt ]]; then
  echo "prep-note.txt missing"
  exit 1
fi

if ! grep -qx 'prep: disable openai provider train' prep-note.txt; then
  echo "prep-note.txt missing required prep line"
  exit 1
fi

if ! grep -qx 'akm-search-query: opencode config' prep-note.txt; then
  echo "prep-note.txt missing akm-search-query provenance line"
  exit 1
fi

if ! grep -qx 'akm-show-ref: skill:opencode' prep-note.txt; then
  echo "prep-note.txt missing akm-show-ref provenance line"
  exit 1
fi

if ! grep -qE '"model"[[:space:]]*:[[:space:]]*"shredder/qwen/qwen3.6-35b-a3b"' config/opencode.json; then
  echo "config/opencode.json missing shredder default model"
  exit 1
fi

if ! grep -qE '"provider"[[:space:]]*:[[:space:]]*\{' config/opencode.json; then
  echo "config/opencode.json missing provider block"
  exit 1
fi

if ! grep -qE '"openai"[[:space:]]*:[[:space:]]*false' config/opencode.json; then
  echo "config/opencode.json missing openai disable flag"
  exit 1
fi

if ! grep -qE '"shredder"[[:space:]]*:[[:space:]]*\{' config/opencode.json; then
  echo "config/opencode.json missing shredder provider"
  exit 1
fi

if ! grep -qE '"options"[[:space:]]*:[[:space:]]*\{' config/opencode.json; then
  echo "config/opencode.json missing provider options block"
  exit 1
fi

if ! grep -qE '"apiKey"[[:space:]]*:[[:space:]]*"\{env:OPENAI_API_KEY\}"' config/opencode.json; then
  echo "config/opencode.json missing shredder options.apiKey env-ref wiring"
  exit 1
fi

echo "ok"
exit 0
