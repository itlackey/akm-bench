#!/bin/bash
# Harbor entry point: copied to /tests/test.sh and run from the container's
# working directory (task.toml [environment].workdir = "/app"). Wraps the
# ported legacy `verify.sh` (also copied verbatim into tests/) and reduces
# its exit code to the single reward.txt signal Harbor's viewer/aggregator
# reads. See docs/corpus-conversion.md "script verifier template".
set -uo pipefail

mkdir -p /logs/verifier /logs/artifacts

bash /tests/verify.sh >/logs/artifacts/verify-stdout.txt 2>&1
status=$?

if [ "$status" -eq 0 ]; then
  echo 1 >/logs/verifier/reward.txt
else
  echo 0 >/logs/verifier/reward.txt
fi

cat /logs/artifacts/verify-stdout.txt
