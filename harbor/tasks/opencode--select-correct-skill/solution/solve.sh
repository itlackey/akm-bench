#!/bin/bash
# Path note: the graded file is agent-guidance.md, NOT AGENTS.md. See
# tests/test_select_skill.py for why -- do not "tidy" the name back.
cat > agent-guidance.md <<'DOC'
# Agent Guidelines

This workspace uses the opencode skill only.

1. Run `akm search` to find the opencode skill before making changes.
2. Apply the opencode-specific guidance you find.
DOC
