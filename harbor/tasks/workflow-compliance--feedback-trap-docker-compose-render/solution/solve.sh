#!/bin/bash
set -euo pipefail
echo 'docker compose --env-file envs/stage.env -f compose.yaml -f compose.stage.yaml --profile stage config --services --no-interpolate' >> commands.txt
