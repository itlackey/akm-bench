#!/bin/bash
set -euo pipefail
cat > docker-compose.yml <<'YAML'
version: "3.8"
services:
  web:
    image: nginx:1.27-alpine
    ports: ["80:80"]
YAML
