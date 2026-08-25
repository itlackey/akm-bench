#!/usr/bin/env bash
# Deterministic verifier for repeated-fail-opencode-disable-provider.
#
# Graded artifact: config/opencode.json, NOT ./opencode.json. The legacy TS
# driver spawns the agent -- opencode itself -- with cwd = the workspace copy
# (src/driver.ts `cwd: options.workspace`), and opencode resolves its
# project-level config by walking UP from cwd, so a file at the workspace root
# is claimed as the agent's own config: loaded, applied to its own session,
# and rewritten with a `"$schema"` line before the model's first turn. A
# subdirectory is out of reach of that upward walk.
#
# Worse here than a rewrite: the graded answer sets `provider.openai` to
# `false`, which opencode's schema rejects, so the answer at the loaded path
# makes opencode refuse to start ("Expected ProviderConfig, got false
# provider.openai", opencode-ai@1.18.21).
#
# Kept in lockstep with the ported Harbor task at harbor/tasks/workflow-compliance--repeated-fail-opencode-disable-provider,
# whose tests/verify.sh carries the full rationale and the empirical evidence.
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
