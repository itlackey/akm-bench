#!/bin/bash
set -euo pipefail
cat > docker-compose.yml <<'YAML'
services:
  app:
    image: ghcr.io/example/app:1.0.0
    ports: ["3000:3000"]
    env_file: app.env
YAML
