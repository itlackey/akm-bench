FROM python:3.12-slim

WORKDIR /app

RUN pip install --no-cache-dir pytest==8.4.1 pytest-json-ctrf==0.3.5 pyyaml

# This task is create-shaped on purpose (issue #6): the agent must produce
# `service.yaml` from nothing, so there is no environment/workspace/ to COPY
# in here. See docs/corpus-conversion.md §2.
