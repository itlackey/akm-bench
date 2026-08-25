#!/bin/bash
set -euo pipefail
echo 'az resource list --tag env=prod --tag tier=data --query "[].{name:name,type:type,location:location}" -o tsv' >> commands.txt
