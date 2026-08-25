FROM ubuntu:24.04

WORKDIR /app

COPY workspace/ /app/

# NOTE: the legacy fixture's workspace/haiku.txt already contained a
# complete, valid three-line haiku -- i.e. the starting workspace already
# satisfied tests/verify.sh with zero agent action (confirmed by running
# verify.sh against the pristine legacy workspace: exit 0). That defeats
# this task's purpose (measuring whether the agent searches before writing
# and avoids loading the irrelevant `minimal` stash). This conversion
# deliberately does NOT ship that pre-filled haiku.txt -- see
# docs/corpus-conversion.md's workflow-compliance notes / the conversion
# report for the full rationale and evidence. Only workspace/README.md is
# copied in; the agent must create haiku.txt itself.
