FROM ubuntu:24.04

RUN apt-get update \
    && apt-get install -y --no-install-recommends jq \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY workspace/ /app/

# The graded artifact is /app/config/opencode.json, NOT /app/opencode.json --
# tests/verify.sh carries the full rationale. Pre-create the directory so the
# relocation costs the agent nothing the original task did not already ask
# for: writing to cwd needed no mkdir, so writing to config/ must not either.
RUN mkdir -p /app/config
