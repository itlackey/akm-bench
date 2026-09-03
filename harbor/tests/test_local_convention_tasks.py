"""LC2/LC5 regression tests for the local-convention task class.

See ``docs/task-class-local-convention.md``. A task in this class is only
discriminating while BOTH of these hold:

* **LC2** — the confident, publicly-correct answer FAILS the verifier. If it
  ever starts passing, the task has silently stopped measuring anything and
  every aggregate that includes it is diluted.
* **LC5** — the documented local form PASSES, and near-miss forms (a missing
  policy flag, a wrong token, an undocumented extra flag) do not.

These run the real ``tests/verify.sh`` against real ``commands.txt`` files in a
tmpdir. No container, no model, no network — so they are cheap enough to be a
permanent guard rather than a one-off authoring check, which matters because
LC7 requires re-checking this class whenever the model changes.
"""

from __future__ import annotations

import re
import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
TASKS_DIR = REPO_ROOT / "harbor" / "tasks"


def local_convention_tasks() -> list[Path]:
    return sorted(
        d
        for d in TASKS_DIR.iterdir()
        if d.is_dir()
        and (d / "task.toml").is_file()
        and 'memory_ability = "local_convention_override"' in (d / "task.toml").read_text()
    )


TASKS = local_convention_tasks()


def run_verifier(task_dir: Path, commands: str, tmp_path: Path) -> int:
    (tmp_path / "commands.txt").write_text(commands if commands.endswith("\n") else commands + "\n")
    return subprocess.run(
        ["bash", str(task_dir / "tests" / "verify.sh")],
        cwd=tmp_path,
        capture_output=True,
        text=True,
        timeout=60,
    ).returncode


def gold_command(task_dir: Path) -> str:
    # solve.sh is `echo "<command>" >> commands.txt`
    line = (task_dir / "solution" / "solve.sh").read_text().strip().splitlines()[-1]
    return line.split('"', 1)[1].rsplit('"', 1)[0]


def public_default(task_dir: Path) -> str:
    lines = (task_dir / "solution" / "public-default.txt").read_text().splitlines()
    return "\n".join(l for l in lines if l.strip() and not l.startswith("#"))


def test_the_class_is_not_empty():
    # A silent zero here would make every test below vacuously pass.
    assert TASKS, "no tasks carry memory_ability = local_convention_override"


@pytest.mark.parametrize("task_dir", TASKS, ids=lambda d: d.name)
def test_gold_solution_passes(task_dir: Path, tmp_path: Path):
    assert run_verifier(task_dir, gold_command(task_dir), tmp_path) == 0, (
        f"{task_dir.name}: the documented local form was REJECTED by its own verifier"
    )


@pytest.mark.parametrize("task_dir", TASKS, ids=lambda d: d.name)
def test_public_default_fails(task_dir: Path, tmp_path: Path):
    """LC2. This is the test that decides whether the task measures anything."""
    assert run_verifier(task_dir, public_default(task_dir), tmp_path) != 0, (
        f"{task_dir.name}: the PUBLIC DEFAULT answer passed. The task no longer "
        "creates a knowledge gap and must be re-authored (LC7)."
    )


@pytest.mark.parametrize("task_dir", TASKS, ids=lambda d: d.name)
def test_empty_and_absent_input_fail(task_dir: Path, tmp_path: Path):
    assert run_verifier(task_dir, "", tmp_path) != 0, f"{task_dir.name}: empty commands.txt passed"
    empty_dir = tmp_path / "absent"
    empty_dir.mkdir()
    result = subprocess.run(
        ["bash", str(task_dir / "tests" / "verify.sh")],
        cwd=empty_dir,
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert result.returncode != 0, f"{task_dir.name}: missing commands.txt passed"


@pytest.mark.parametrize("task_dir", TASKS, ids=lambda d: d.name)
def test_an_undocumented_extra_flag_is_rejected(task_dir: Path, tmp_path: Path):
    """LC5. Exact-form matching, not 'contains the right tokens'."""
    assert run_verifier(task_dir, gold_command(task_dir) + " --yes", tmp_path) != 0, (
        f"{task_dir.name}: gold form plus an undocumented flag was accepted"
    )


@pytest.mark.parametrize("task_dir", TASKS, ids=lambda d: d.name)
def declared_convention_tokens(task_dir: Path) -> list[str]:
    for line in (task_dir / "task.toml").read_text().splitlines():
        if line.startswith("convention_tokens = ["):
            inner = line[line.index("[") + 1 : line.rindex("]")]
            return [t.strip().strip('"') for t in inner.split(",") if t.strip()]
    return []


@pytest.mark.parametrize("task_dir", TASKS, ids=lambda d: d.name)
def test_convention_tokens_are_declared(task_dir: Path):
    assert declared_convention_tokens(task_dir), (
        f"{task_dir.name}: no convention_tokens in task.toml, so LC4 cannot be checked"
    )


@pytest.mark.parametrize("task_dir", TASKS, ids=lambda d: d.name)
def test_convention_tokens_live_in_the_stash(task_dir: Path):
    """LC4, first half: the stash really is a source of truth for the token."""
    stash = REPO_ROOT / "harbor" / "stashes" / "northwind-platform"
    corpus = "".join(f.read_text() for f in stash.rglob("*.md") if f.is_file())
    for token in declared_convention_tokens(task_dir):
        assert token in corpus, (
            f"{task_dir.name}: {token!r} is not in the northwind-platform stash, so the "
            "task is unanswerable even WITH akm"
        )


@pytest.mark.parametrize("task_dir", TASKS, ids=lambda d: d.name)
def test_convention_tokens_are_not_visible_to_the_agent(task_dir: Path):
    """LC4, second half: the stash is the SOLE source.

    Only declared convention tokens are checked. Values the prompt supplies as
    task input (a resource-group name, the secret name, the container name) are
    given, not looked up, and listing them here would make the check unsatisfiable
    for any task that names its own subject.
    """
    visible = (task_dir / "instruction.md").read_text()
    for f in (task_dir / "environment" / "workspace").rglob("*"):
        if f.is_file():
            visible += f.read_text()

    for token in declared_convention_tokens(task_dir):
        assert token not in visible, (
            f"{task_dir.name}: convention token {token!r} appears in agent-visible text; "
            "the task can be solved without consulting akm"
        )
