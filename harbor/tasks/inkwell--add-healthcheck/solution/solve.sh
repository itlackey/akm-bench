#!/bin/bash
set -euo pipefail
cat > service.yaml <<'YAML'
apiVersion: inkwell/v2
kind: Service
metadata:
  name: web-frontend
spec:
  runtime:
    image: frontend:v1.4.0
    port: 3000
  healthcheck:
    path: /health
    interval: 10
    threshold: 3
YAML
