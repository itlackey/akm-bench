#!/bin/bash
set -euo pipefail
cat > service.yaml <<'YAML'
apiVersion: inkwell/v2
kind: Service
metadata:
  name: data-api
spec:
  runtime:
    image: data-api:v2.1.0
    port: 9000
  scaling:
    min: 2
    max: 10
    metric: cpu
    target: 70
  limits:
    rps: 500
    burst: 1000
YAML
