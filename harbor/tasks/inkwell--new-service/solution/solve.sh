#!/bin/bash
set -euo pipefail
cat > service.yaml <<'YAML'
apiVersion: inkwell/v2
kind: Service
metadata:
  name: api-gateway
spec:
  runtime:
    image: gateway:v2
    port: 8080
YAML
