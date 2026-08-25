#!/usr/bin/env bash
# Deterministic verifier for feedback-trap-docker-compose-render.
set -euo pipefail

if [[ ! -f commands.txt ]]; then
  echo "commands.txt missing"
  exit 1
fi

if ! grep -qE 'docker compose' commands.txt; then
  echo "commands.txt missing 'docker compose'"
  exit 1
fi

if ! grep -qE -- '--env-file[[:space:]]+envs/stage.env' commands.txt; then
  echo "commands.txt missing --env-file envs/stage.env"
  exit 1
fi

if ! grep -qE -- '-f[[:space:]]+compose.yaml' commands.txt; then
  echo "commands.txt missing -f compose.yaml"
  exit 1
fi

if ! grep -qE -- '-f[[:space:]]+compose.stage.yaml' commands.txt; then
  echo "commands.txt missing -f compose.stage.yaml"
  exit 1
fi

if ! grep -qE -- '--profile[[:space:]]+stage' commands.txt; then
  echo "commands.txt missing --profile stage"
  exit 1
fi

if ! grep -qE -- 'config' commands.txt; then
  echo "commands.txt missing config subcommand"
  exit 1
fi

if ! grep -qE -- '--services' commands.txt; then
  echo "commands.txt missing --services"
  exit 1
fi

if ! grep -qE -- '--no-interpolate' commands.txt; then
  echo "commands.txt missing --no-interpolate"
  exit 1
fi

echo "ok"
exit 0
