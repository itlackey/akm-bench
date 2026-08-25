#!/bin/bash
# Path note: the graded file is agent-guidance.md, NOT AGENTS.md. See
# tests/verify.sh for why -- do not "tidy" the name back.
cat > agent-guidance.md <<'DOC'
# Agent Guidelines

Before writing any code, call `akm search` to look up relevant skills and
knowledge for this workspace, then apply what you find.
DOC
