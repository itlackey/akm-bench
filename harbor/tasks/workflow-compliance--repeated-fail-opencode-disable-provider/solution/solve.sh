#!/bin/bash
# Oracle: the three edits the task asks for, applied to the seeded opencode.json
# (unrelated keys -- $schema, sandbox, and the whole shredder wiring -- survive).
set -euo pipefail

sed -i 's|"model": "openai/gpt-4o-mini",|"model": "shredder/qwen/qwen3.6-35b-a3b",|' opencode.json
sed -i 's|"provider": {|"provider": {\n    "openai": false,|' opencode.json
sed -i 's|"apiKey": "\$OPENAI_API_KEY"|"apiKey": "{env:OPENAI_API_KEY}"|' opencode.json

cat > prep-note.txt <<'DOC'
prep: disable openai provider train
akm-search-query: opencode config
akm-show-ref: skill:opencode
DOC
