FROM ubuntu:24.04

WORKDIR /app

COPY workspace/ /app/

# NOTE: the legacy fixture shipped workspace/commands.txt PRE-FILLED with the
# exact `az resource list ...` command tests/verify.sh greps for -- i.e. the
# pristine workspace scored reward 1 with zero agent action (confirmed by
# running the ported verifier against the untouched legacy workspace: exit
# 0), so the task carried no signal. This conversion ships commands.txt
# empty; the instruction says "append to commands.txt", so the file is still
# created, just without the pre-solved answer.
