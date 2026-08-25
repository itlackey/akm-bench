#!/usr/bin/env bash
# Graded artifact: config/opencode.json, NOT ./opencode.json. The legacy TS
# driver spawns the agent -- opencode itself -- with cwd = the workspace copy
# (src/driver.ts `cwd: options.workspace`), and opencode resolves its
# project-level config by walking UP from cwd, so a file at the workspace root
# is claimed as the agent's own config: loaded, applied to its own session,
# and rewritten with a `"$schema"` line before the model's first turn. A
# subdirectory is out of reach of that upward walk. Kept in lockstep with the
# ported Harbor task at harbor/tasks/opencode--opencode-config-model, whose
# tests/verify.sh carries the full rationale and the empirical evidence.
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
