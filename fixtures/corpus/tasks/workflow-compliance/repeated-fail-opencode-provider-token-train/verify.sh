#!/usr/bin/env bash
# Deterministic verifier for repeated-fail-opencode-provider-token-train.
#
# Graded artifact: config/opencode.json, NOT ./opencode.json. The legacy TS
# driver spawns the agent -- opencode itself -- with cwd = the workspace copy
# (src/driver.ts `cwd: options.workspace`), and opencode resolves its
# project-level config by walking UP from cwd, so a file at the workspace root
# is claimed as the agent's own config: loaded, applied to its own session,
# and rewritten with a `"$schema"` line before the model's first turn. A
# subdirectory is out of reach of that upward walk.
#
# Worse here than a rewrite: the graded answer is a provider CREDENTIAL, so
# at the loaded path it hijacks the agent's own API key -- verified against
# opencode-ai@1.18.21, the outbound request carried the value the fixture's
# `{env:ANTHROPIC_API_KEY}` resolved to instead of the agent's own.
#
# Kept in lockstep with the ported Harbor task at harbor/tasks/workflow-compliance--repeated-fail-opencode-provider-token-train,
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

if ! grep -qx 'prep: anthropic provider token train' prep-note.txt; then
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

if ! grep -qE '"model"[[:space:]]*:[[:space:]]*"anthropic/claude-opus-4-7"' config/opencode.json; then
  echo "config/opencode.json missing anthropic model pin"
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
