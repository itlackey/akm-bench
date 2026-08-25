#!/bin/bash
set -euo pipefail
cat > docker-compose.yml <<'YAML'
services:
  api:
    image: ghcr.io/example/api:1.0.0
    ports: ["8000:8000"]
    networks:
      - internal
  worker:
    image: ghcr.io/example/worker:1.0.0
    networks:
      - internal

networks:
  internal:
    driver: bridge
YAML
