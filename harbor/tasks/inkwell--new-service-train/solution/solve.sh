#!/bin/bash
set -euo pipefail
cat > service.yaml <<'YAML'
apiVersion: inkwell/v2
kind: Service
metadata:
  name: auth-proxy
spec:
  runtime:
    image: proxy:v1
    port: 9090
YAML
