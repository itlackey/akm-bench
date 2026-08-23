#!/bin/bash
set -euo pipefail
cat > docker-compose.yml <<'YAML'
services:
  redis:
    image: redis:7-alpine
    ports: ["6379:6379"]
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 3s
      retries: 5
YAML
