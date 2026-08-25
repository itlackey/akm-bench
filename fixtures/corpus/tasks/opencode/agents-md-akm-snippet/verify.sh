#!/usr/bin/env bash
# Graded artifact: agent-guidance.md, NOT AGENTS.md. The legacy TS driver
# spawns the agent -- opencode itself -- with cwd = the workspace copy
# (src/driver.ts `cwd: options.workspace`), and opencode loads project
# INSTRUCTION files by walking UP from cwd over the names
# ["AGENTS.md","CLAUDE.md","CONTEXT.md"], splicing what it finds verbatim
# into the system prompt of the agent under test. A file at the workspace
# root named AGENTS.md is therefore this task's graded deliverable AND the
# agent's own instructions in the same trial -- a feedback loop. No other
# filename is matched. Kept in lockstep with the ported Harbor task at
# harbor/tasks/opencode--agents-md-akm-snippet, whose tests/verify.sh
# carries the full rationale and the empirical evidence.
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
