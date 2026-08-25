#!/bin/bash
set -euo pipefail
cat > service.yaml <<'YAML'
apiVersion: inkwell/v2
kind: Service
metadata:
  name: inkwell-app
spec:
  runtime:
    image: inkwell:v1.0.0
    port: 8080
  scaling:
    min: 2
    max: 20
    metric: rps
    target: 100
YAML
