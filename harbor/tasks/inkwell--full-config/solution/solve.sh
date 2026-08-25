#!/bin/bash
set -euo pipefail
cat > service.yaml <<'YAML'
apiVersion: inkwell/v2
kind: Service
metadata:
  name: web-app
spec:
  runtime:
    image: webapp:v2.1.0
    port: 3000
  scaling:
    min: 2
    max: 10
    metric: rps
    target: 150
  healthcheck:
    path: /health
    interval: 15
    threshold: 3
  limits:
    rps: 200
    burst: 400
YAML
