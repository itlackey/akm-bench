FROM ubuntu:24.04

WORKDIR /app
COPY workspace/ /app/

# NOTE: the legacy fixture ships a pre-written guidance file in its workspace
# (`workspace/agent-guidance.md`; it was named `AGENTS.md` before the rename
# described in tests/verify.sh) that already recommended running
# `akm search ...` as its first step -- i.e. the pristine workspace already
# satisfied the verifier's `grep -q 'akm search'` check with zero agent action
# (confirmed by running verify.sh against the pristine legacy workspace:
# exit 0). Dropping that file is also required by the
# arm-neutrality/scaffolding-stripping rule (docs/corpus-conversion.md §2),
# but doing so has the added effect of fixing this no-op-pass: the agent must
# now create the guidance file itself, which is the task's actual deliverable.
# Only workspace/README.md is copied in.
#
# No `mkdir` line is needed here and none should be added: the graded file
# lives at the workspace root (/app/agent-guidance.md), exactly as it did
# under its old name, so the rename costs the agent no step.
