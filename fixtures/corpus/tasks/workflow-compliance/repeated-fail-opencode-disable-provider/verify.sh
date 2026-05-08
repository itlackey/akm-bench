#!/usr/bin/env bash
# Deterministic verifier for repeated-fail-opencode-disable-provider.
set -euo pipefail

if [[ ! -f opencode.json ]]; then
  echo "opencode.json missing"
  exit 1
fi

if ! grep -qE '"model"[[:space:]]*:[[:space:]]*"anthropic/claude-3-5-sonnet"' opencode.json; then
  echo "opencode.json missing anthropic sonnet default model"
  exit 1
fi

if ! grep -qE '"provider"[[:space:]]*:[[:space:]]*\{' opencode.json; then
  echo "opencode.json missing provider block"
  exit 1
fi

if ! grep -qE '"openai"[[:space:]]*:[[:space:]]*false' opencode.json; then
  echo "opencode.json missing openai disable flag"
  exit 1
fi

if ! grep -qE '"anthropic"[[:space:]]*:[[:space:]]*\{' opencode.json; then
  echo "opencode.json missing anthropic provider"
  exit 1
fi

if ! grep -qE '"env"[[:space:]]*:[[:space:]]*\{' opencode.json; then
  echo "opencode.json missing env map"
  exit 1
fi

if ! grep -qE '"ANTHROPIC_API_KEY"[[:space:]]*:[[:space:]]*"\$\{ANTHROPIC_API_KEY\}"' opencode.json; then
  echo "opencode.json missing ANTHROPIC_API_KEY env wiring"
  exit 1
fi

echo "ok"
exit 0
