#!/bin/bash
set -euo pipefail
cat > service.yaml <<'YAML'
apiVersion: inkwell/v2
kind: Service
metadata:
  name: data-ingest
spec:
  runtime:
    image: ingest:v2.1.0
    port: 7000
  healthcheck:
    path: /readyz
    interval: 15
    threshold: 2
YAML
