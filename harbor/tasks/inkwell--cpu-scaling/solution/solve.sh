#!/bin/bash
set -euo pipefail
cat > service.yaml <<'YAML'
apiVersion: inkwell/v2
kind: Service
metadata:
  name: batch-processor
spec:
  runtime:
    image: batch:v1.0.0
    port: 7070
  scaling:
    min: 1
    max: 8
    metric: cpu
    target: 65
YAML
