#!/bin/bash
# Harbor entry point. pytest and pytest-json-ctrf are already on PATH —
# installed at image build time (environment/Dockerfile), not here, so this
# script has no network dependency. See docs/corpus-conversion.md "pytest
# verifier template".
set -uo pipefail

mkdir -p /logs/verifier /logs/artifacts

pytest -q --tb=line --ctrf /logs/verifier/ctrf.json /tests -rA \
  >/logs/artifacts/pytest-stdout.txt 2>&1
status=$?

if [ "$status" -eq 0 ]; then
  echo 1 >/logs/verifier/reward.txt
else
  echo 0 >/logs/verifier/reward.txt
fi

cat /logs/artifacts/pytest-stdout.txt
