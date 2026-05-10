#!/usr/bin/env bash
# Deterministic verifier for repeated-fail-opencode-provider-token-train.
set -euo pipefail

if [[ ! -f opencode.json ]]; then
  echo "opencode.json missing"
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

if ! grep -qE '"model"[[:space:]]*:[[:space:]]*"anthropic/claude-opus-4-7"' opencode.json; then
  echo "opencode.json missing anthropic model pin"
  exit 1
fi

if ! grep -qE '"provider"[[:space:]]*:[[:space:]]*\{' opencode.json; then
  echo "opencode.json missing provider block"
  exit 1
fi

if ! grep -qE '"anthropic"[[:space:]]*:[[:space:]]*\{' opencode.json; then
  echo "opencode.json missing anthropic provider config"
  exit 1
fi

if ! grep -qE '"options"[[:space:]]*:[[:space:]]*\{' opencode.json; then
  echo "opencode.json missing provider options block"
  exit 1
fi

if ! grep -qE '"apiKey"[[:space:]]*:[[:space:]]*"\{env:ANTHROPIC_API_KEY\}"' opencode.json; then
  echo "opencode.json missing anthropic options.apiKey env-ref wiring"
  exit 1
fi

echo "ok"
exit 0
