#!/bin/bash
# Oracle: the three edits the task asks for, applied to the seeded
# config/opencode.json (unrelated keys -- $schema, sandbox, and the whole
# shredder wiring -- survive).
#
# Path note: the graded file is config/opencode.json, NOT ./opencode.json.
# See tests/verify.sh for why -- do not "tidy" it back to the workspace root.
set -euo pipefail

sed -i 's|"model": "openai/gpt-4o-mini",|"model": "shredder/qwen/qwen3.6-35b-a3b",|' config/opencode.json
sed -i 's|"provider": {|"provider": {\n    "openai": false,|' config/opencode.json
sed -i 's|"apiKey": "\$OPENAI_API_KEY"|"apiKey": "{env:OPENAI_API_KEY}"|' config/opencode.json

cat > prep-note.txt <<'DOC'
prep: disable openai provider train
akm-search-query: opencode config
akm-show-ref: skill:opencode
DOC
