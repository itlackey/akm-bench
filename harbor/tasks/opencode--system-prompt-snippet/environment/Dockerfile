FROM ubuntu:24.04

WORKDIR /app
COPY workspace/ /app/

# NOTE: the legacy fixture shipped workspace/system.txt PRE-FILLED with a
# snippet that already satisfied tests/verify.sh -- the pristine workspace
# scored reward 1 with zero agent action, so the task carried no signal. The
# instruction (and the legacy README) say "Create a file `system.txt`", which
# presumes it does not exist, so this conversion does not ship it. Only
# workspace/README.md is copied in; the agent must create system.txt itself.
