import pathlib

# Fixed for Harbor's /tests + /app split layout (docs/corpus-conversion.md
# §2 __file__-path caveat): the legacy fixture resolved this path relative
# to the sibling `workspace/` dir, which does not exist under Harbor. The
# verifier's cwd is /app (task.toml [environment].workdir), so a plain
# relative path is correct here.
AGENTS = pathlib.Path("AGENTS.md")

def test_has_akm_search():
    text = AGENTS.read_text()
    assert "akm search" in text.lower() or "akm search" in text, "AGENTS.md must contain akm search guidance"

def test_no_docker_guidance():
    text = AGENTS.read_text().lower()
    assert "docker run" not in text and "docker compose" not in text, "Should not contain docker-specific guidance"
