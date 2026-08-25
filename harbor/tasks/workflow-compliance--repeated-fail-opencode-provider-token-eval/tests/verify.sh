#!/usr/bin/env bash
# Deterministic verifier for repeated-fail-opencode-provider-token-eval.
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
# For THIS task the consequence is the worst of the family: the graded answer
# is an anthropic PROVIDER CREDENTIAL, so writing it at the loaded path
# HIJACKS THE AGENT'S OWN API KEY. Reproduced against the pinned
# opencode-ai@1.18.21 with a harness-shaped run
# (`opencode --model=anthropic/<m> run --format=json --thinking
# --dangerously-skip-permissions -- ...`), the agent's real credential set in
# its GLOBAL config (~/.config/opencode/opencode.json,
# provider.anthropic.options.apiKey = "sk-REAL-AGENT-CREDENTIAL") and a
# DIFFERENT value in the container env (ANTHROPIC_API_KEY =
# "sk-TASK-CONTAINER-ENV-VALUE"), with the model endpoint pointed at a local
# listener that logs the auth header it receives:
#
#   ./opencode.json        = the oracle answer
#                            (provider.anthropic.options.apiKey =
#                             "{env:ANTHROPIC_API_KEY}")
#     -> outbound request carries x-api-key: sk-TASK-CONTAINER-ENV-VALUE
#        i.e. the graded artifact replaced the agent's own credential
#
#   config/opencode.json   = same bytes
#     -> outbound request carries x-api-key: sk-REAL-AGENT-CREDENTIAL
#        i.e. the agent keeps its own credential
#
# The graded artifact must not be able to reach into the session that is being
# scored on producing it. Moving the file is the fix; the ANSWER is
# deliberately unchanged, because the `{env:NAME}` env-ref form is exactly
# what this task measures.
#
# Nothing else about the task moves: the same ten checks below, the same
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

if ! grep -qx 'prep: anthropic provider token eval' prep-note.txt; then
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

if ! grep -qE '"model"[[:space:]]*:[[:space:]]*"anthropic/claude-3-5-sonnet"' config/opencode.json; then
  echo "config/opencode.json missing anthropic default model"
  exit 1
fi

if ! grep -qE '"provider"[[:space:]]*:[[:space:]]*\{' config/opencode.json; then
  echo "config/opencode.json missing provider block"
  exit 1
fi

if ! grep -qE '"anthropic"[[:space:]]*:[[:space:]]*\{' config/opencode.json; then
  echo "config/opencode.json missing anthropic provider config"
  exit 1
fi

if ! grep -qE '"options"[[:space:]]*:[[:space:]]*\{' config/opencode.json; then
  echo "config/opencode.json missing provider options block"
  exit 1
fi

if ! grep -qE '"apiKey"[[:space:]]*:[[:space:]]*"\{env:ANTHROPIC_API_KEY\}"' config/opencode.json; then
  echo "config/opencode.json missing anthropic options.apiKey env-ref wiring"
  exit 1
fi

echo "ok"
exit 0
