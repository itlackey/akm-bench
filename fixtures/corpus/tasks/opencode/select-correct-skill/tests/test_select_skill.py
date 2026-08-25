"""Legacy-corpus verifier for opencode/select-correct-skill.

GRADED ARTIFACT: workspace/agent-guidance.md, NOT workspace/AGENTS.md. The
legacy TS driver spawns the agent -- opencode itself -- with cwd = the
workspace copy (src/driver.ts `cwd: options.workspace`), and opencode loads
project INSTRUCTION files by walking UP from cwd over the names
["AGENTS.md","CLAUDE.md","CONTEXT.md"], splicing what it finds verbatim into
the system prompt of the agent under test. A file at the workspace root named
AGENTS.md is therefore this task's graded deliverable AND the agent's own
instructions in the same trial -- a feedback loop, and one that lands on
exactly what this task scores (which skill the guidance is scoped to). No
other filename is matched. Kept in lockstep with the ported Harbor task at
harbor/tasks/opencode--select-correct-skill, whose
tests/test_select_skill.py carries the full rationale and the empirical
evidence. Both assertions below are unchanged.
"""

import pathlib

AGENTS = pathlib.Path(__file__).parent.parent / "workspace" / "agent-guidance.md"

def test_has_akm_search():
    text = AGENTS.read_text()
    assert "akm search" in text.lower() or "akm search" in text, "agent-guidance.md must contain akm search guidance"

def test_no_docker_guidance():
    text = AGENTS.read_text().lower()
    assert "docker run" not in text and "docker compose" not in text, "Should not contain docker-specific guidance"
