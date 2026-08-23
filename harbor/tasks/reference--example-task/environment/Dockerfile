FROM ubuntu:24.04

WORKDIR /app

# This task's legacy workspace/ contained only a .gitkeep placeholder (no
# real fixture files), so there is nothing to COPY in here. See
# docs/corpus-conversion.md for the general rule: when a converted task's
# workspace/ has real content, it is copied to environment/workspace/ and
# this Dockerfile gets `COPY workspace/ /app/` right after WORKDIR.
