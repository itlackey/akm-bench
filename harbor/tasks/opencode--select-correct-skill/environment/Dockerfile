FROM python:3.12-slim

WORKDIR /app

RUN pip install --no-cache-dir pytest==8.4.1 pytest-json-ctrf==0.3.5 pyyaml

COPY workspace/ /app/

# NOTE: the legacy fixture ships a pre-written guidance file in its workspace
# (`workspace/agent-guidance.md`; it was named `AGENTS.md` before the rename
# described in tests/test_select_skill.py) that already told the agent to use
# ONLY the opencode skill and never mentioned "docker run" / "docker compose"
# literally -- i.e. the pristine workspace already satisfied both
# tests/test_select_skill.py assertions with zero agent action (confirmed by
# running pytest against the pristine legacy workspace: exit 0). Dropping that
# file is also required by the arm-neutrality/scaffolding-stripping rule
# (docs/corpus-conversion.md §2), but it changes what this task measures: the
# legacy file handed the agent the disambiguation between the `multi-domain`
# stash's several skills (docker/k8s/terraform/az/opencode) outright; now the
# agent must independently land on "opencode only" itself.
# `memory_ability: conflict_resolution` (task.toml) still describes the
# retrieval-side challenge -- the stash still holds multiple candidate
# skills -- but the task no longer additionally tests "read and follow
# stated disambiguation instructions." Only workspace/README.md is copied
# in.
#
# No `mkdir` line is needed here and none should be added: the graded file
# lives at the workspace root (/app/agent-guidance.md), exactly as it did
# under its old name, so the rename costs the agent no step.
