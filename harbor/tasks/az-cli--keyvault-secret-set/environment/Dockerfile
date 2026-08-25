FROM ubuntu:24.04

WORKDIR /app
COPY workspace/ /app/

# NOTE: the legacy fixture shipped workspace/commands.txt PRE-FILLED with the
# exact command tests/verify.sh greps for -- i.e. the pristine workspace scored
# reward 1 with zero agent action (confirmed by running the ported verifier
# against the untouched legacy workspace: exit 0), so the task carried no
# signal. The other four az-cli tasks in this domain all ship an EMPTY
# commands.txt and the instruction says "append to commands.txt", so this
# conversion ships commands.txt empty to match that corpus-wide convention.
# The file is still created (the instruction says "append", not "create").
