#!/bin/bash
# Path note: the graded file is config/opencode.json, NOT ./opencode.json.
# See tests/verify.sh for why -- do not "tidy" it back to the workspace root.
mkdir -p config
cat > config/opencode.json <<'DOC'
{
  "model": "anthropic/claude-opus-4-7"
}
DOC
