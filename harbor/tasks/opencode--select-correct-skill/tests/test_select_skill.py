"""Verifier for opencode--select-correct-skill.

GRADED ARTIFACT: agent-guidance.md -- i.e. /app/agent-guidance.md, NOT
/app/AGENTS.md. DO NOT rename it back.

The benchmark agent under test IS opencode, and it runs with cwd = /app
(task.toml [environment].workdir). opencode resolves PROJECT INSTRUCTION
FILES by walking UP from cwd -- `Instruction.systemPaths` in opencode 1.18.x
tries the names ["AGENTS.md", "CLAUDE.md", "CONTEXT.md"] with
findUp(name, directory, worktree) -- and splices whatever it finds VERBATIM
into the system prompt of the agent under test, prefixed
`Instructions from: <path>`.

This task's deliverable IS such a file. Under the old name the model's own
graded output became the model's own instructions mid-trial: a feedback
loop, not merely a mutation of the input. It hits this task twice over,
because what is scored here is precisely which skill the guidance is scoped
to -- a half-written "use the docker skill" line would have been fed back to
the agent as its own standing instruction before it finished deciding.
`select-correct-skill` is also the task the P0 milestone was validated on.

OPENCODE_DISABLE_PROJECT_CONFIG does NOT mitigate it: that flag gates
project CONFIG discovery, while this file is loaded as INSTRUCTIONS.

findUp only ever joins those three names onto ANCESTOR directories, and it
only matches those three names, so any other filename is out of reach.
Verified empirically in a container at the pinned opencode-ai@1.18.21, with
a harness-shaped run (`opencode --model=<p>/<m> run --format=json --thinking
--dangerously-skip-permissions -- ...` and a harness-shaped global config at
~/.config/opencode/opencode.json) whose model endpoint pointed at a listener
that logged every outbound request body.

(a) which names opencode claims -- same marker file, one path per run:
      /app/AGENTS.md  /app/CLAUDE.md  /app/CONTEXT.md  -> spliced into the
                                                          system prompt
      /app/docs/AGENTS.md  /app/agent-guidance.md      -> absent from it

(b) task-faithful: this task's own solution/solve.sh, with the OLD path as
    the positive control in the same container, 9 outbound requests each:
      /app/AGENTS.md            185484 B  graded text in prompt x6, and
                                          `Instructions from: /app/AGENTS.md`
      /app/agent-guidance.md    184110 B  0 hits, no `Instructions from:`
      (empty /app, baseline)    184110 B
    i.e. under the new name the request the agent sends is BYTE-IDENTICAL to
    the baseline with no graded file present at all.

Every file was left byte-identical by the run: instruction files are read,
not rewritten, so the injection -- not a mutation -- is the whole defect.

What this task measures is unchanged by the rename: both assertions below
are byte-for-byte the ones that shipped -- the same `akm search` literal and
the same docker-leakage check on the same two substrings. The file is still
created at the workspace root, so the rename costs no step (no mkdir, no new
directory) and the difficulty is unchanged.

Path form: fixed for Harbor's /tests + /app split layout
(docs/corpus-conversion.md §2 __file__-path caveat) -- the legacy fixture
resolved this path relative to the sibling `workspace/` dir, which does not
exist under Harbor. The verifier's cwd is /app (task.toml
[environment].workdir), so a plain relative path is correct here.
"""

import pathlib

AGENTS = pathlib.Path("agent-guidance.md")

def test_has_akm_search():
    text = AGENTS.read_text()
    assert "akm search" in text.lower() or "akm search" in text, "agent-guidance.md must contain akm search guidance"

def test_no_docker_guidance():
    text = AGENTS.read_text().lower()
    assert "docker run" not in text and "docker compose" not in text, "Should not contain docker-specific guidance"
