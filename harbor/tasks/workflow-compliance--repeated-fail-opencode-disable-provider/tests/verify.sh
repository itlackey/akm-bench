#!/usr/bin/env bash
# Deterministic verifier for repeated-fail-opencode-disable-provider.
set -euo pipefail

if [[ ! -f opencode.json ]]; then
  echo "opencode.json missing"
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

if ! grep -qE '"model"[[:space:]]*:[[:space:]]*"shredder/qwen/qwen3.6-35b-a3b"' opencode.json; then
  echo "opencode.json missing shredder default model"
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

if ! grep -qE '"shredder"[[:space:]]*:[[:space:]]*\{' opencode.json; then
  echo "opencode.json missing shredder provider"
  exit 1
fi

if ! grep -qE '"options"[[:space:]]*:[[:space:]]*\{' opencode.json; then
  echo "opencode.json missing provider options block"
  exit 1
fi

if ! grep -qE '"apiKey"[[:space:]]*:[[:space:]]*"\{env:OPENAI_API_KEY\}"' opencode.json; then
  echo "opencode.json missing shredder options.apiKey env-ref wiring"
  exit 1
fi

echo "ok"
exit 0
