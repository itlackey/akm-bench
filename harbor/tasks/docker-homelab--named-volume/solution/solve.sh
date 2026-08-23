#!/bin/bash
set -euo pipefail
cat > docker-compose.yml <<'YAML'
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_PASSWORD: example
    ports: ["5432:5432"]
    volumes:
      - pgdata:/var/lib/postgresql/data

volumes:
  pgdata:
YAML
