#!/bin/bash
# Path note: the graded file is config/opencode.json, NOT ./opencode.json.
# See tests/verify.sh for why -- do not "tidy" it back to the workspace root.
set -euo pipefail
mkdir -p config
cat > config/opencode.json <<'JSON'
{
  "$schema": "https://opencode.ai/config.json",
  "model": "anthropic/claude-3-5-sonnet",
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
prep: anthropic provider token eval
akm-search-query: opencode config
akm-show-ref: skill:opencode
NOTE
