#!/bin/bash
set -euo pipefail
cat > docker-compose.yml <<'YAML'
services:
  web:
    image: nginx:1.27-alpine
    ports:
      - "8080:80"
YAML
