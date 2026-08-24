#!/bin/bash
set -euo pipefail
cat > service.yaml <<'YAML'
apiVersion: inkwell/v2
kind: Service
metadata:
  name: report-renderer
spec:
  runtime:
    image: renderer:v4.2.1
    port: 6060
  scaling:
    min: 2
    max: 12
    metric: rps
    target: 250
  limits:
    rps: 300
    burst: 600
YAML
