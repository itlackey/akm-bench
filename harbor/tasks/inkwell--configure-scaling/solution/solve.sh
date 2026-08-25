#!/bin/bash
set -euo pipefail
cat > service.yaml <<'YAML'
apiVersion: inkwell/v2
kind: Service
metadata:
  name: worker-pool
spec:
  runtime:
    image: worker:v3.0.1
    port: 8080
  scaling:
    min: 2
    max: 20
    metric: rps
    target: 100
YAML
