#!/usr/bin/env bash
# Deterministic verifier for repeated-fail-storage-lifecycle-eval.
#
# Eval variant: measures transfer after train variants A and B trigger
# the reflect/distill workflow.
set -euo pipefail

if [[ ! -f commands.txt ]]; then
  echo "commands.txt missing"
  exit 1
fi

if ! grep -qE 'az storage account management-policy create' commands.txt; then
  echo "commands.txt missing 'az storage account management-policy create'"
  exit 1
fi

if ! grep -qE -- '--account-name[[:space:]]+storagelogs' commands.txt; then
  echo "commands.txt missing --account-name storagelogs"
  exit 1
fi

if ! grep -qE -- '(-g|--resource-group)[[:space:]]+ops-rg' commands.txt; then
  echo "commands.txt missing --resource-group ops-rg"
  exit 1
fi

if ! grep -qE 'blockBlob' commands.txt; then
  echo "commands.txt missing blob-type qualifier"
  exit 1
fi

if ! grep -qE 'daysAfterModificationGreaterThan' commands.txt; then
  echo "commands.txt missing modification-age action key"
  exit 1
fi

if ! grep -qE 'expire-90d' commands.txt; then
  echo "commands.txt missing rule name expire-90d"
  exit 1
fi

if ! grep -qE 'logs-archive' commands.txt; then
  echo "commands.txt missing container logs-archive"
  exit 1
fi

echo "ok"
exit 0
