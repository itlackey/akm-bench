#!/bin/bash
set -euo pipefail
sed -i \
  -e 's/--type edge/--tier edge/' \
  -e 's/--region us-west-2/--region az-west/' \
  runbook.txt
