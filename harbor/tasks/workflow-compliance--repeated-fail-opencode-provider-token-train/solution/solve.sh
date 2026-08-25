#!/bin/bash
set -euo pipefail
cat > opencode.json <<'JSON'
{
  "$schema": "https://opencode.ai/config.json",
  "model": "anthropic/claude-opus-4-7",
  "provider": {
    "anthropic": {
      "options": {
        "apiKey": "{env:ANTHROPIC_API_KEY}"
      }
    }
  }
}
JSON
cat > prep-note.txt <<NOTE
prep: anthropic provider token train
akm-search-query: opencode config
akm-show-ref: skill:opencode
NOTE
