FROM ubuntu:24.04

WORKDIR /app
COPY workspace/ /app/

# NOTE: the legacy fixture's workspace/AGENTS.md already recommended running
# `akm search ...` as its first step -- i.e. the pristine workspace already
# satisfied tests/verify.sh's `grep -q 'akm search' AGENTS.md` check with
# zero agent action (confirmed by running verify.sh against the pristine
# legacy workspace: exit 0). Dropping AGENTS.md is also required by the
# arm-neutrality/scaffolding-stripping rule (docs/corpus-conversion.md §2),
# but doing so has the added effect of fixing this no-op-pass: the agent must
# now create AGENTS.md itself, which is the task's actual deliverable. Only
# workspace/README.md is copied in.
