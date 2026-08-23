"""Unit tests for the AkmOpenCode Harbor agent.

No Docker daemon, no network, no model credentials: every container
interaction goes through a recording fake, and the install() sequence is
asserted as a list of shell command strings.

Run with::

    PYTHONPATH="$(pwd)" pytest harbor/tests/test_akm_opencode.py

Harbor itself must be installed (``uv tool install harbor`` or
``pip install harbor``); the module is skipped with a clear message
otherwise rather than failing collection.
"""

from __future__ import annotations

import asyncio
import inspect
import json
import os
import re
import shlex
import subprocess
from pathlib import Path

import pytest

pytest.importorskip(
    "harbor.agents.installed.opencode",
    reason="Harbor is not installed; install it to run the AkmOpenCode tests.",
)

import yaml  # noqa: E402  (after importorskip, by design)
from harbor.agents.installed.opencode import OpenCode  # noqa: E402
from harbor.environments.base import ExecResult  # noqa: E402
from harbor.models.agent.context import AgentContext  # noqa: E402

import harbor.akm_opencode as akm_opencode  # noqa: E402  (module, for monkeypatching)
from harbor.akm_opencode import (  # noqa: E402
    AKM_ACCUMULATING_ARM_NAME,
    AKM_ARM_NAME,
    AKM_BUNDLE_DIR,
    AKM_CLI_SPEC,
    AKM_CLI_VERSION,
    AKM_PLUGIN_SPEC,
    AKM_PLUGIN_VERSION,
    AKM_ROOT,
    AKM_SEED_DIR,
    AKM_STASH_ROOT_DIR,
    AKM_TOOLS,
    DEFAULT_SEED_LIBRARY_DIR,
    OPENCODE_VERSION,
    PLUGIN_FAILED_MARKER,
    PLUGIN_RESOLVED_MARKER,
    RUN_LOG_RELDIR,
    RUN_XDG_DATA_HOME,
    SEED_EXPECTED_BY_TYPE,
    SHARED_PERMISSIONS,
    AkmOpenCode,
    AkmPluginNotLoadedError,
    derive_seed_expectations,
)

#: The complete `permission` key set opencode 1.18.21 declares, transcribed
#: from @opencode-ai/sdk@1.18.21 dist/gen/types.gen.d.ts:1161-1169. Anything
#: outside this set is a key opencode does not implement, so writing it grants
#: nothing and only looks like a grant.
OPENCODE_DECLARED_PERMISSION_KEYS = frozenset(
    {"edit", "bash", "webfetch", "doom_loop", "external_directory"}
)

REPO_ROOT = Path(__file__).resolve().parents[2]
JOB_CONFIG_PATH = REPO_ROOT / "harbor" / "jobs" / "p0-smoke.yaml"
SEED_LIBRARY_DIR = REPO_ROOT / "harbor" / "seed-library"


@pytest.fixture(autouse=True)
def isolate_default_stash_root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """No test may depend on whether harbor/stashes/ happens to exist.

    Another workflow may be concurrently populating harbor/stashes/ in this
    same tree (see docs/plans/benchmark-harness-decisions.md D7 and the P0
    doc), so its presence or absence on disk is not something this suite can
    treat as stable. Pinning DEFAULT_STASH_ROOT to a guaranteed-nonexistent
    path for every test -- unless a test explicitly overrides it -- is what
    makes "the default agent has no stash configured" a fact about the code
    instead of a fact about the checkout's current directory listing.
    """
    monkeypatch.setattr(
        akm_opencode, "DEFAULT_STASH_ROOT", tmp_path / "unused-default-stash-root"
    )


def run_shell(
    script: str, extra_env: dict[str, str] | None = None
) -> subprocess.CompletedProcess[str]:
    """Run a generated shell fragment through a REAL bash, no container.

    Used only for the stash-selection logic: a purely textual assertion
    ("the string 'printenv AKM_TASK_STASH' appears somewhere") cannot prove
    the `[ -d ... ]` / `if` branching actually resolves to the right
    directory or actually exits non-zero on an unknown stash -- exactly the
    "fails loudly, never silently" contract this exists to guarantee. PATH is
    inherited (for bash/node itself); no other ambient env leaks in, so a
    stray AKM_TASK_STASH in the invoking shell can never contaminate a test.
    """
    env = {"PATH": os.environ.get("PATH", "")}
    env.update(extra_env or {})
    return subprocess.run(
        ["bash", "-c", script],
        env=env,
        capture_output=True,
        text=True,
        timeout=10,
    )


# --------------------------------------------------------------------------
# Fakes
# --------------------------------------------------------------------------


class FakeEnvironment:
    """Records every exec and upload instead of touching a container.

    Duck-typed rather than a BaseEnvironment subclass: the agent only ever
    calls ``exec()``, ``upload_dir()`` and reads ``default_user``, and
    BaseEnvironment is an ABC with a large abstract surface that would add
    noise without adding coverage.
    """

    #: What the real container prints for _build_resolve_binaries_command().
    RESOLVED_BINARIES = "AKM_BIN=/opt/node/bin/akm\nNODE_BIN=/opt/node/bin/node\n"

    def __init__(
        self,
        default_user: str = "agent",
        return_code: int = 0,
        resolved_binaries: str | None = None,
    ):
        self.default_user = default_user
        self._return_code = return_code
        # install() reads this back to build root's `ln`, so the fake has to
        # answer that one probe like a container would.
        self._resolved_binaries = (
            self.RESOLVED_BINARIES if resolved_binaries is None else resolved_binaries
        )
        self.execs: list[dict] = []
        self.uploads: list[tuple[str, str]] = []

    async def exec(
        self,
        command: str,
        user: str | int | None = None,
        env: dict[str, str] | None = None,
        cwd: str | None = None,
        timeout_sec: int | None = None,
    ) -> ExecResult:
        self.execs.append(
            {"command": command, "user": user, "env": dict(env or {}), "cwd": cwd}
        )
        stdout = self._resolved_binaries if "AKM_BIN=" in command else ""
        return ExecResult(stdout=stdout, stderr="", return_code=self._return_code)

    async def upload_dir(self, source_dir, target_dir: str) -> None:
        self.uploads.append((str(source_dir), target_dir))

    # convenience views ----------------------------------------------------

    @property
    def commands(self) -> list[str]:
        return [entry["command"] for entry in self.execs]

    @property
    def all_commands_text(self) -> str:
        return "\n".join(self.commands)

    def commands_for_user(self, user: str | None) -> list[str]:
        return [entry["command"] for entry in self.execs if entry["user"] == user]


@pytest.fixture
def agent(tmp_path: Path) -> AkmOpenCode:
    return AkmOpenCode(
        logs_dir=tmp_path / "logs", model_name="anthropic/claude-sonnet-4-5"
    )


def make_agent(tmp_path: Path, **kwargs) -> AkmOpenCode:
    kwargs.setdefault("model_name", "anthropic/claude-sonnet-4-5")
    return AkmOpenCode(logs_dir=tmp_path / "logs", **kwargs)


# --------------------------------------------------------------------------
# Identity
# --------------------------------------------------------------------------


def test_subclasses_opencode():
    assert issubclass(AkmOpenCode, OpenCode)


def test_name_is_a_distinct_ab_arm_label():
    # Inheriting OpenCode.name() would collapse this agent into the control arm.
    assert AkmOpenCode.name() == "akm-opencode"
    assert AkmOpenCode.name() != OpenCode.name()


def test_name_stays_callable_on_the_CLASS():
    # BaseAgent.handoff() is a classmethod that calls cls.name(); turning
    # name() into an instance method would make that raise TypeError instead
    # of the intended NotImplementedError.
    assert isinstance(inspect.getattr_static(AkmOpenCode, "name"), staticmethod)


def test_arm_name_separates_static_from_accumulating(tmp_path: Path):
    """Decision D7: the two akm arms must never share an identity.

    Harbor's agent identity is (AgentInfo.name, AgentInfo.version) and
    nothing else -- not the class, not the import path, not the kwargs. Both
    akm arms are this same class at the same pins, so version() is identical
    on both; the NAME is the only field left that can keep them apart in
    result.json. Without this, every grouping keyed off agent_info (Harbor's
    own evals key, JobStatistics, the viewer grid, the D4 pass_at_k
    cross-check) silently merges them into one bucket.
    """
    static = make_agent(tmp_path)
    accumulating = make_agent(tmp_path, shared_bundle_path="/shared/akm-bundle")

    assert static.arm_name() == AKM_ARM_NAME
    assert accumulating.arm_name() == AKM_ACCUMULATING_ARM_NAME
    assert static.arm_name() != accumulating.arm_name()

    # ...and version() genuinely cannot do this job on its own.
    assert static.version() == accumulating.version()


def test_agent_info_carries_the_per_arm_name(tmp_path: Path):
    """AgentInfo is the ONLY agent identity that reaches result.json."""
    static = make_agent(tmp_path).to_agent_info()
    accumulating = make_agent(
        tmp_path, shared_bundle_path="/shared/akm-bundle"
    ).to_agent_info()

    assert static.name == AKM_ARM_NAME
    assert accumulating.name == AKM_ACCUMULATING_ARM_NAME
    assert (static.name, static.version) != (
        accumulating.name,
        accumulating.version,
    )


def test_agent_info_model_info_is_split_the_way_harbor_splits_it(tmp_path: Path):
    """The bare model in .name, the provider in .provider -- never joined.

    analysis/src/loader.ts rebuilds `provider/name` from these two fields;
    an analysis fixture that puts the joined form in .name would agree with a
    shape Harbor never writes.
    """
    info = make_agent(tmp_path, model_name="anthropic/claude-sonnet-4-5").to_agent_info()
    assert info.model_info is not None
    assert info.model_info.name == "claude-sonnet-4-5"
    assert info.model_info.provider == "anthropic"


def test_import_path_matches_the_job_config(agent: AkmOpenCode):
    assert agent.import_path() == "harbor.akm_opencode:AkmOpenCode"


def test_version_reports_both_pins(agent: AkmOpenCode):
    version = agent.version()
    assert version is not None
    # The opencode pin is applied by default so the arm is never unpinned.
    assert version.startswith(OPENCODE_VERSION)
    assert AKM_PLUGIN_SPEC in version


def test_opencode_version_pin_is_applied_by_default(tmp_path: Path):
    assert make_agent(tmp_path)._version == OPENCODE_VERSION


def test_job_supplied_opencode_version_still_wins(tmp_path: Path):
    assert make_agent(tmp_path, version="9.9.9")._version == "9.9.9"


def test_inherited_class_attributes_are_untouched():
    # Changing any of these breaks ATIF reporting, resume, provider auth or
    # the hardcoded `tee /logs/agent/opencode.txt` in run().
    assert AkmOpenCode.SUPPORTS_ATIF is True
    assert AkmOpenCode.SUPPORTS_RESUME is True
    assert AkmOpenCode.MODEL_CONNECTION is OpenCode.MODEL_CONNECTION
    assert AkmOpenCode._OUTPUT_FILENAME == "opencode.txt"
    assert AkmOpenCode.CLI_FLAGS == OpenCode.CLI_FLAGS


# --------------------------------------------------------------------------
# Forced config injection
# --------------------------------------------------------------------------


def test_forced_config_carries_the_pinned_plugin(agent: AkmOpenCode):
    assert agent._opencode_config["plugin"] == [AKM_PLUGIN_SPEC]
    assert AKM_PLUGIN_VERSION in AKM_PLUGIN_SPEC
    # A bare package name would resolve `latest` at every session start.
    assert "@" in AKM_PLUGIN_SPEC


def test_forced_config_permission_block_only_uses_declared_keys(agent: AkmOpenCode):
    """opencode's Config.permission declares five keys and no more.

    An invented key (read/write/grep/glob/list/patch, or an akm_* tool name) is
    not a stricter setting -- it is config opencode does not implement, so it
    grants nothing while reading like a grant that was made.
    """
    permission = agent._opencode_config["permission"]
    assert set(permission) == OPENCODE_DECLARED_PERMISSION_KEYS
    assert set(SHARED_PERMISSIONS) == OPENCODE_DECLARED_PERMISSION_KEYS
    for key, grant in SHARED_PERMISSIONS.items():
        assert permission[key] == grant


def test_no_akm_tool_appears_under_permission(agent: AkmOpenCode):
    """The regression this file exists to prevent.

    akm_* under `permission` is silently ignored by opencode, which would leave
    the treatment arm's tools ungoverned and the block misleading.
    """
    permission = agent._opencode_config["permission"]
    assert not [key for key in permission if key.startswith("akm_")]
    rendered = agent._build_register_config_command() or ""
    permission_block = rendered.split('"permission"', 1)[1].split("}", 1)[0]
    assert "akm_" not in permission_block


def test_forced_config_enables_the_akm_tools_through_the_tools_map(agent: AkmOpenCode):
    """`tools` is the schema-supported lever for per-tool enablement.

    @opencode-ai/sdk@1.18.21 types.gen.d.ts:1170-1173 -- a separate top-level
    `tools?: {[key: string]: boolean}` map, not part of `permission`.
    """
    tools = agent._opencode_config["tools"]
    assert set(AKM_TOOLS) == {
        "akm_search",
        "akm_show",
        "akm_curate",
        "akm_feedback",
        "akm_remember",
    }
    for tool in AKM_TOOLS:
        assert tools[tool] is True
    # Booleans, not permission strings: a string here is a schema violation.
    assert all(isinstance(value, bool) for value in tools.values())


def test_forced_config_survives_an_empty_job_config(tmp_path: Path):
    agent = make_agent(tmp_path, opencode_config={})
    assert agent._opencode_config["plugin"] == [AKM_PLUGIN_SPEC]
    assert agent._opencode_config["permission"]["bash"] == "allow"
    assert agent._opencode_config["tools"]["akm_search"] is True


def test_forced_config_does_not_alias_the_class_attributes(tmp_path: Path):
    """_FORCED_CONFIG is a class attribute; assigning it by reference would let
    one agent's config mutation leak into every later instance."""
    first = make_agent(tmp_path, opencode_config={})
    first._opencode_config["tools"]["akm_search"] = False
    first._opencode_config["permission"]["bash"] = "deny"

    second = make_agent(tmp_path, opencode_config={})
    assert second._opencode_config["tools"]["akm_search"] is True
    assert second._opencode_config["permission"]["bash"] == "allow"


def test_forced_config_survives_a_job_config_that_omits_the_plugin(tmp_path: Path):
    # The whole point: a job config that forgets the plugin must NOT silently
    # degrade this arm into a no-plugin run.
    agent = make_agent(
        tmp_path,
        opencode_config={
            "permission": {"bash": "deny"},
            "plugin": [],
            "tools": {"akm_search": False},
        },
    )
    assert agent._opencode_config["plugin"] == [AKM_PLUGIN_SPEC]
    assert agent._opencode_config["permission"]["bash"] == "allow"
    # A job cannot quietly measure a half-disabled treatment arm either.
    assert agent._opencode_config["tools"]["akm_search"] is True


def test_merge_preserves_operator_supplied_keys(tmp_path: Path):
    agent = make_agent(
        tmp_path,
        opencode_config={
            "experimental": {"continue_loop_on_deny": True},
            "autoupdate": True,
            "permission": {"bash": "ask"},
            "tools": {"webfetch": False},
            "plugin": ["some-other-plugin@1.0.0"],
        },
    )
    config = agent._opencode_config

    # Unrelated top-level keys untouched.
    assert config["experimental"] == {"continue_loop_on_deny": True}
    assert config["autoupdate"] is True

    # Forced keys win, which is what "force" means...
    assert config["permission"]["bash"] == "allow"
    assert config["tools"]["akm_search"] is True
    # ...while operator entries we do not force survive alongside them.
    assert config["tools"]["webfetch"] is False

    # Operator plugins survive; the akm plugin is prepended.
    assert config["plugin"] == [AKM_PLUGIN_SPEC, "some-other-plugin@1.0.0"]


def test_plugin_list_is_not_duplicated(tmp_path: Path):
    agent = make_agent(tmp_path, opencode_config={"plugin": [AKM_PLUGIN_SPEC]})
    assert agent._opencode_config["plugin"] == [AKM_PLUGIN_SPEC]


def test_custom_plugin_spec_is_honoured(tmp_path: Path):
    agent = make_agent(tmp_path, akm_plugin_spec="akm-opencode@9.9.9")
    assert agent._opencode_config["plugin"] == ["akm-opencode@9.9.9"]
    assert "akm-opencode@9.9.9" in (agent.version() or "")


def test_rendered_opencode_json_contains_plugin_and_permissions(agent: AkmOpenCode):
    """End-to-end through Harbor's own config builder.

    This is the assertion that actually proves the override point works: it
    exercises OpenCode._build_register_config_command(), whose final merge
    layer is self._opencode_config.
    """
    command = agent._build_register_config_command()
    assert command is not None
    assert "~/.config/opencode/opencode.json" in command
    assert AKM_PLUGIN_SPEC in command
    for tool in AKM_TOOLS:
        assert f'"{tool}": true' in command
    # Harbor's auto-generated provider block must still be there.
    assert "anthropic" in command


def test_rendered_opencode_json_defaults_are_overridable(tmp_path: Path):
    """_DEFAULT_CONFIG is the low-precedence layer, unlike _FORCED_CONFIG."""
    default_agent = make_agent(tmp_path)
    assert '"autoupdate": false' in (
        default_agent._build_register_config_command() or ""
    )

    override_agent = make_agent(tmp_path, opencode_config={"autoupdate": True})
    assert '"autoupdate": true' in (
        override_agent._build_register_config_command() or ""
    )


# --------------------------------------------------------------------------
# Environment injection
# --------------------------------------------------------------------------


def test_akm_env_pins_all_five_directories(agent: AkmOpenCode):
    # AKM_DATA_DIR in particular is mandatory: Harbor's run() sets
    # XDG_DATA_HOME=/logs/agent/opencode/xdg-data, so without the pin the
    # index built at install time is a different database at run time, and
    # the failure is silent (zero results, no error).
    for key in (
        "AKM_BUNDLE_DIR",
        "AKM_CONFIG_DIR",
        "AKM_DATA_DIR",
        "AKM_CACHE_DIR",
        "AKM_STATE_DIR",
    ):
        assert agent._akm_env[key].startswith(AKM_ROOT)
    # Never under /tmp: akm silently redirects config/cache for /tmp bundles.
    assert not agent._akm_env["AKM_BUNDLE_DIR"].startswith("/tmp")


def test_akm_env_never_pins_path(agent: AkmOpenCode):
    """A PATH here REPLACES the image's PATH, and only on this arm.

    Harbor emits every env entry as `docker exec -e KEY=VALUE` and runs a
    non-login `bash -c`, so nothing restores the image PATH. A task image whose
    toolchain lives in a venv / conda / ~/.local/bin / cargo / go would lose it
    in the treatment arm only, and "python: not found" would score as akm
    making the agent worse. `akm` is reachable via the /usr/local/bin symlinks
    instead.
    """
    assert "PATH" not in agent._akm_env
    env = FakeEnvironment()
    asyncio.run(agent.exec_as_agent(env, command="true"))
    assert "PATH" not in env.execs[0]["env"]


def test_akm_env_sets_the_determinism_kill_switches(agent: AkmOpenCode):
    assert agent._akm_env["AKM_AUTO_MEMORY"] == "0"
    assert agent._akm_env["AKM_INDEX_ON_SESSION_END"] == "0"
    assert agent._akm_env["AKM_EMBED_DETERMINISTIC"] == "1"
    # Curation and hints ARE the treatment; they must stay on.
    assert agent._akm_env["AKM_AUTO_CURATE"] == "1"
    assert agent._akm_env["AKM_AUTO_HINTS"] == "1"


def test_measured_process_reports_user_event_source(tmp_path: Path):
    # The opencode process is the signal being measured...
    agent = make_agent(tmp_path)
    assert agent._akm_env["AKM_EVENT_SOURCE"] == "user"
    env = FakeEnvironment()
    asyncio.run(agent.exec_as_agent(env, command="true"))
    assert env.execs[0]["env"]["AKM_EVENT_SOURCE"] == "user"


def test_install_phase_execs_report_audit_event_source(tmp_path: Path):
    # ...while harness scaffolding is excluded from demand and utility scoring.
    agent = make_agent(tmp_path)
    env = FakeEnvironment()
    asyncio.run(agent.install(env))
    assert agent._install_phase is False  # reset even though install succeeded
    asyncio.run(agent.exec_as_agent(env, command="after-install"))
    assert env.execs[-1]["env"]["AKM_EVENT_SOURCE"] == "user"


def test_akm_env_kwarg_overrides_defaults(tmp_path: Path):
    agent = make_agent(tmp_path, akm_env={"AKM_AUTO_CURATE": "0"})
    assert agent._akm_env["AKM_AUTO_CURATE"] == "0"
    assert agent._akm_env["AKM_AUTO_MEMORY"] == "0"  # other defaults intact


def test_akm_bundle_dir_kwarg_overrides_the_default(tmp_path: Path):
    agent = make_agent(tmp_path, akm_bundle_dir="/srv/library")
    assert agent._akm_env["AKM_BUNDLE_DIR"] == "/srv/library"


def test_exec_as_agent_merges_akm_env_under_caller_env(tmp_path: Path):
    agent = make_agent(tmp_path)
    env = FakeEnvironment()
    asyncio.run(
        agent.exec_as_agent(
            env,
            command="true",
            # Mirrors what run() passes: XDG overrides plus credentials.
            env={"XDG_DATA_HOME": "/logs/agent/opencode/xdg-data", "AKM_AUTO_HINTS": "0"},
        )
    )
    exec_env = env.execs[0]["env"]
    # Caller keys win...
    assert exec_env["XDG_DATA_HOME"] == "/logs/agent/opencode/xdg-data"
    assert exec_env["AKM_AUTO_HINTS"] == "0"
    # ...and every other AKM_* default still reaches the process.
    assert exec_env["AKM_BUNDLE_DIR"] == AKM_BUNDLE_DIR
    assert exec_env["AKM_AUTO_MEMORY"] == "0"


# --------------------------------------------------------------------------
# install()
# --------------------------------------------------------------------------


@pytest.fixture
def installed(tmp_path: Path) -> tuple[AkmOpenCode, FakeEnvironment]:
    agent = make_agent(tmp_path)
    env = FakeEnvironment()
    asyncio.run(agent.install(env))
    return agent, env


def test_install_pins_every_npm_package(installed):
    _, env = installed
    text = env.all_commands_text
    # Chained through super().install(), which renders self._version.
    assert f"npm i -g opencode-ai@{OPENCODE_VERSION}" in text
    # Installed directly by this class.
    assert f"npm i -g {AKM_CLI_SPEC}" in text
    assert AKM_CLI_VERSION in AKM_CLI_SPEC
    # The plugin pin reaches the container through the warm-cache config.
    assert AKM_PLUGIN_SPEC in text


def test_install_chains_the_base_install_first(installed):
    _, env = installed
    commands = env.commands
    opencode_index = next(
        i for i, c in enumerate(commands) if "npm i -g opencode-ai@" in c
    )
    akm_index = next(i for i, c in enumerate(commands) if "npm i -g akm-cli@" in c)
    assert opencode_index < akm_index


def test_install_asserts_the_node_major_before_installing_akm(installed):
    _, env = installed
    cli_command = next(c for c in env.commands if "npm i -g akm-cli@" in c)
    assert "process.versions.node" in cli_command
    assert cli_command.index("NODE_MAJOR") < cli_command.index("npm i -g akm-cli@")
    # nvm prelude, or the global bin is not on PATH on glibc images.
    assert "nvm.sh" in cli_command


def test_install_creates_and_chowns_the_akm_root_as_root(installed):
    _, env = installed
    root_commands = "\n".join(env.commands_for_user("root"))
    assert f"install -d -m 0755 {AKM_ROOT}" in root_commands
    assert f"chown -R agent {AKM_ROOT}" in root_commands


def test_install_symlinks_akm_and_node_onto_path(installed):
    _, env = installed
    root_commands = "\n".join(env.commands_for_user("root"))
    # The absolute paths come from the agent-user probe, not from a nested su.
    assert "ln -sf /opt/node/bin/akm /usr/local/bin/akm" in root_commands
    # The dist/akm launcher is `#!/usr/bin/env node`, so node must be linked too.
    assert "ln -sf /opt/node/bin/node /usr/local/bin/node" in root_commands
    # A dangling symlink must fail setup, not degrade the plugin at run time.
    assert "test -x /usr/local/bin/akm" in root_commands


def test_install_resolves_binaries_as_the_agent_user_not_via_su(installed):
    """`su - <owner>` was treatment-only and fragile three ways.

    It dies when the agent user's shell is /usr/sbin/nologin, when `su` is
    absent from a minimal image, and when AgentConfig.user is an int UID (`su -
    1000` looks up a user literally named "1000"). exec_as_agent already runs
    as the right user.
    """
    _, env = installed
    assert "su -" not in env.all_commands_text
    probe = next(c for c in env.commands_for_user(None) if "AKM_BIN=" in c)
    assert "command -v akm" in probe
    assert "readlink -f" in probe
    # `$(command -v akm)` alone aborts silently under `set -e`.
    assert "command -v akm || true" in probe


def test_resolved_binaries_parser_accepts_the_probe_output():
    akm, node = AkmOpenCode._parse_resolved_binaries(
        "AKM_BIN=/opt/node/bin/akm\nNODE_BIN=/opt/node/bin/node\n"
    )
    assert (akm, node) == ("/opt/node/bin/akm", "/opt/node/bin/node")


@pytest.mark.parametrize(
    "stdout",
    [
        "",
        "AKM_BIN=\nNODE_BIN=/opt/node/bin/node",
        "AKM_BIN=/opt/node/bin/akm",
        "AKM_BIN=akm\nNODE_BIN=node",  # relative: `ln -sf akm` links garbage
    ],
)
def test_resolved_binaries_parser_refuses_anything_unusable(stdout: str):
    # `ln -sf "" /usr/local/bin/akm` succeeds and leaves a dangling link, which
    # would resurface as the plugin's silent WARN during the measured run.
    with pytest.raises(RuntimeError, match="AKM-BOOTSTRAP FATAL"):
        AkmOpenCode._parse_resolved_binaries(stdout)


def test_install_fails_when_the_container_cannot_resolve_akm(tmp_path: Path):
    agent = make_agent(tmp_path)
    env = FakeEnvironment(resolved_binaries="")
    with pytest.raises(RuntimeError, match="AKM-BOOTSTRAP FATAL"):
        asyncio.run(agent.install(env))
    # No symlink was attempted against an empty path.
    assert "ln -sf" not in env.all_commands_text


def test_install_uploads_the_seed_library(installed):
    agent, env = installed
    assert env.uploads == [(str(agent._seed_library_dir), AKM_SEED_DIR)]
    root_commands = "\n".join(env.commands_for_user("root"))
    # docker cp needs the destination to exist and lands files root-owned.
    assert f"mkdir -p {AKM_SEED_DIR}" in root_commands
    assert f"chown -R agent {AKM_SEED_DIR}" in root_commands


def test_install_seeds_the_bundle_without_akm_setup(installed):
    _, env = installed
    seed_command = next(c for c in env.commands if "akm bundle create" in c)
    # `akm setup` hard-fails on a non-TTY without --yes.
    assert "akm setup" not in env.all_commands_text
    # --set-default is required or the default-bundle pointer is untouched.
    assert f"akm bundle create --dir {AKM_BUNDLE_DIR} --set-default" in seed_command
    assert "akm index --full" in seed_command
    # Only type subdirectories are copied, which keeps the seed README out.
    assert f"for d in {AKM_SEED_DIR}/*/" in seed_command


def test_install_warms_both_opencode_plugin_caches(installed):
    agent, env = installed
    warm_command = next(c for c in env.commands if "warmup" in c)
    assert AKM_PLUGIN_SPEC in warm_command
    # A real boot is what materialises ~/.cache/opencode AND
    # ~/.config/opencode/node_modules.
    assert "~/.config/opencode" in warm_command
    assert f"opencode --model={agent.model_name} run" in warm_command


def test_warm_boot_writes_the_same_config_the_measured_run_writes(tmp_path: Path):
    """The install-time boot must not be a softer test than the real one.

    It used to write only {$schema, autoupdate, plugin} and boot
    `--model=warmup/warmup`, so a config opencode REJECTS -- an unknown
    permission key, a malformed provider block, a bad baseURL -- could only
    surface during the paid run, as a silently akm-free trial. Rendering the
    exact same command makes that a setup failure: a rejected config takes the
    plugin down, and the self-check's log grep fails this step.
    """
    agent = make_agent(tmp_path)
    config_command = agent._build_register_config_command()
    assert config_command is not None
    assert config_command in agent._build_warm_caches_command()
    # No placeholder model, and the same permission-skipping flag run() uses.
    warm = agent._build_warm_caches_command()
    assert "warmup/warmup" not in warm
    assert "--dangerously-skip-permissions" in warm


def test_warm_boot_refuses_a_model_name_opencode_would_reject(tmp_path: Path):
    # OpenCode.run() raises on this later; failing at setup is cheaper.
    agent = make_agent(tmp_path, model_name="claude-sonnet-4-5")
    with pytest.raises(RuntimeError, match="provider/model"):
        agent._build_warm_caches_command()


# --------------------------------------------------------------------------
# npm-overrides pin fix (closes the in-process akm-cli hole)
#
# Two independent mechanisms, tested separately below:
#   * _build_write_npm_overrides_command() -- writes an npm `overrides` pin
#     into ~/.config/opencode/package.json before the warm boot. VERIFIED
#     (see that method's docstring) inert against opencode 1.18.21's actual
#     plugin-install root; kept as harmless forward-looking insurance for the
#     plugin's exec-path candidate 2.
#   * _build_align_hoisted_akm_cli_command() -- the mechanism VERIFIED to
#     actually close the hole: force-realigns the akm-cli copy hoisted
#     beside the plugin (the root the in-process akm_search/show/curate
#     tools import from) after the warm boot creates it.
# --------------------------------------------------------------------------


def test_npm_overrides_file_pins_akm_cli_to_the_version_constant(agent: AkmOpenCode):
    command = agent._build_write_npm_overrides_command()
    assert "~/.config/opencode/package.json" in command
    assert "install -d -m 0755 ~/.config/opencode" in command
    # The payload must be valid JSON carrying the exact pin, not a range.
    match = re.search(r"echo (.*) > ~/\.config/opencode/package\.json", command)
    assert match is not None
    payload = json.loads(shlex.split(match.group(1))[0])
    assert payload["overrides"] == {"akm-cli": AKM_CLI_VERSION}
    assert payload["dependencies"] == {}


def test_npm_overrides_command_actually_writes_a_valid_overrides_file(
    tmp_path: Path,
):
    """Not just textual: run the real command through real bash and confirm
    the file that lands on disk is parseable JSON carrying the pin -- the
    same shape a real `npm install` reads its root manifest's `overrides`
    from.
    """
    agent = make_agent(tmp_path)
    fake_home = tmp_path / "fake-home"
    fake_home.mkdir()
    result = run_shell(
        agent._build_write_npm_overrides_command(),
        extra_env={"HOME": str(fake_home)},
    )
    assert result.returncode == 0, result.stderr

    written = fake_home / ".config" / "opencode" / "package.json"
    assert written.is_file()
    payload = json.loads(written.read_text())
    assert payload["overrides"] == {"akm-cli": AKM_CLI_VERSION}


def test_align_hoisted_akm_cli_command_targets_the_pin(agent: AkmOpenCode):
    command = agent._build_align_hoisted_akm_cli_command()
    # Same discovery glob as self-check probe 7 -- the location this method
    # exists to protect is the one probe 7 already trusts.
    assert "*/node_modules/akm-cli/package.json" in command
    assert "npm install --prefix" in command
    assert f"akm-cli@{AKM_CLI_VERSION}" in command
    # Matches Npm.add()'s own ignoreScripts:true (packages/core/src/npm.ts),
    # so this does not newly run a postinstall opencode's own install
    # would not itself have run.
    assert "--ignore-scripts" in command
    # Never rewrites the plugin's own package.json/lock bookkeeping.
    assert "--no-save" in command
    assert "AKM-BOOTSTRAP FATAL" in command
    assert "did not take" in command


def test_install_writes_overrides_before_warm_boot_and_aligns_after(installed):
    """Ordering is load-bearing: the overrides file must exist before
    opencode's first plugin resolution (the warm boot), and the hoisted
    copy cannot be realigned until AFTER that resolution has created it.
    """
    _, env = installed
    commands = env.commands
    overrides_index = next(
        i for i, c in enumerate(commands) if "~/.config/opencode/package.json" in c
    )
    warm_index = next(i for i, c in enumerate(commands) if "warmup" in c)
    align_index = next(
        i
        for i, c in enumerate(commands)
        if "node_modules/akm-cli/package.json" in c and "npm install --prefix" in c
    )
    self_check_index = len(commands) - 1

    assert overrides_index < warm_index < align_index < self_check_index
    assert "AKM-BOOTSTRAP FATAL" in commands[self_check_index]


def test_align_hoisted_akm_cli_runs_for_the_accumulating_arm_too(tmp_path: Path):
    """The pin-bypass hole is about opencode's own plugin cache, not the akm
    bundle -- both arms share the same exposure, so both must get the fix,
    and (since it never touches the shared bundle mount) neither needs the
    accumulating arm's flock wrapping.
    """
    agent = make_agent(tmp_path, shared_bundle_path="/mnt/shared/bundle")
    env = FakeEnvironment()
    asyncio.run(agent.install(env))
    align_command = next(
        c
        for c in env.commands
        if "node_modules/akm-cli/package.json" in c and "npm install --prefix" in c
    )
    assert "flock " not in align_command


def test_align_hoisted_akm_cli_skips_reinstall_when_already_pinned(tmp_path: Path):
    """Real bash + real node, no network: prove the fast path is genuinely
    a no-op when the hoisted copy already matches the pin. A poisoned `npm`
    stub sits ahead of the real PATH on purpose -- if the "already pinned"
    fast exit did not fire, the script would invoke it and this test would
    catch that instead of silently passing.
    """
    agent = make_agent(tmp_path)
    fake_home = tmp_path / "fake-home"
    pkg_dir = (
        fake_home
        / ".cache"
        / "opencode"
        / "packages"
        / "akm-opencode@pin"
        / "node_modules"
        / "akm-cli"
    )
    pkg_dir.mkdir(parents=True)
    pkg_json = pkg_dir / "package.json"
    pkg_json.write_text(json.dumps({"name": "akm-cli", "version": AKM_CLI_VERSION}))

    poison_bin = tmp_path / "poison-bin"
    poison_bin.mkdir()
    poison_marker = tmp_path / "npm-was-called"
    poison_npm = poison_bin / "npm"
    poison_npm.write_text(
        f"#!/bin/sh\ntouch {shlex.quote(str(poison_marker))}\nexit 1\n"
    )
    poison_npm.chmod(0o755)

    real_path = os.environ.get("PATH", "")
    result = run_shell(
        agent._build_align_hoisted_akm_cli_command(),
        extra_env={
            "HOME": str(fake_home),
            "PATH": f"{poison_bin}{os.pathsep}{real_path}",
        },
    )
    assert result.returncode == 0, result.stderr
    assert "already at the pin" in result.stdout
    assert not poison_marker.exists(), "the fast path invoked npm anyway"
    # Untouched: still exactly what was written above.
    assert json.loads(pkg_json.read_text())["version"] == AKM_CLI_VERSION


def test_align_hoisted_akm_cli_exits_cleanly_when_nothing_is_hoisted_yet(
    tmp_path: Path,
):
    agent = make_agent(tmp_path)
    fake_home = tmp_path / "fake-home"
    fake_home.mkdir()
    result = run_shell(
        agent._build_align_hoisted_akm_cli_command(),
        extra_env={"HOME": str(fake_home)},
    )
    assert result.returncode == 0, result.stderr
    assert "no hoisted akm-cli yet" in result.stdout


def test_align_hoisted_akm_cli_realigns_a_drifted_copy(tmp_path: Path):
    """Real bash + a FAKE npm stub (no network): simulate the exact threat
    this method exists for -- the plugin's own `^0.9.0` range naturally
    resolving to something newer than our pin -- and prove the on-disk
    package.json is rewritten to the pin.
    """
    agent = make_agent(tmp_path)
    fake_home = tmp_path / "fake-home"
    pkg_dir = (
        fake_home
        / ".cache"
        / "opencode"
        / "packages"
        / "akm-opencode@pin"
        / "node_modules"
        / "akm-cli"
    )
    pkg_dir.mkdir(parents=True)
    pkg_json = pkg_dir / "package.json"
    pkg_json.write_text(json.dumps({"name": "akm-cli", "version": "9.9.9-drifted"}))

    fake_bin = tmp_path / "fake-bin"
    fake_bin.mkdir()
    fake_npm = fake_bin / "npm"
    marker = tmp_path / "npm-was-called"
    # A stub that behaves like `npm install --prefix <dir> akm-cli@<pin> ...`:
    # rewrite the SAME package.json to the requested version. Proves the
    # command's shell plumbing (argument shape, --prefix resolution from
    # AKM_HOISTED_PKG) is correct without touching the real registry.
    fake_npm.write_text(
        "#!/bin/sh\n"
        f'touch {shlex.quote(str(marker))}\n'
        'while [ "$#" -gt 0 ]; do\n'
        '  case "$1" in\n'
        '    --prefix) PREFIX="$2"; shift 2 ;;\n'
        '    akm-cli@*) PINSPEC="$1"; shift ;;\n'
        "    *) shift ;;\n"
        "  esac\n"
        "done\n"
        'PIN="${PINSPEC#akm-cli@}"\n'
        'node -e \'const fs=require("fs");const p=process.argv[1];const v=process.argv[2];'
        'const j=JSON.parse(fs.readFileSync(p));j.version=v;'
        'fs.writeFileSync(p,JSON.stringify(j));\' '
        '"$PREFIX/node_modules/akm-cli/package.json" "$PIN"\n'
    )
    fake_npm.chmod(0o755)

    real_path = os.environ.get("PATH", "")
    result = run_shell(
        agent._build_align_hoisted_akm_cli_command(),
        extra_env={"HOME": str(fake_home), "PATH": f"{fake_bin}{os.pathsep}{real_path}"},
    )
    assert result.returncode == 0, result.stderr
    assert marker.is_file(), "the realignment branch never invoked npm"
    assert json.loads(pkg_json.read_text())["version"] == AKM_CLI_VERSION


def test_align_hoisted_akm_cli_fails_loudly_if_realignment_does_not_take(
    tmp_path: Path,
):
    """`npm install` can exit 0 without producing the expected content (a
    stub that misbehaves, a real npm hitting an edge case). The post-check
    must catch that rather than reporting success on faith.
    """
    agent = make_agent(tmp_path)
    fake_home = tmp_path / "fake-home"
    pkg_dir = (
        fake_home
        / ".cache"
        / "opencode"
        / "packages"
        / "akm-opencode@pin"
        / "node_modules"
        / "akm-cli"
    )
    pkg_dir.mkdir(parents=True)
    pkg_json = pkg_dir / "package.json"
    pkg_json.write_text(json.dumps({"name": "akm-cli", "version": "9.9.9-drifted"}))

    fake_bin = tmp_path / "fake-bin"
    fake_bin.mkdir()
    fake_npm = fake_bin / "npm"
    # Exits 0 but does nothing -- the version stays drifted.
    fake_npm.write_text("#!/bin/sh\nexit 0\n")
    fake_npm.chmod(0o755)

    real_path = os.environ.get("PATH", "")
    result = run_shell(
        agent._build_align_hoisted_akm_cli_command(),
        extra_env={"HOME": str(fake_home), "PATH": f"{fake_bin}{os.pathsep}{real_path}"},
    )
    assert result.returncode != 0
    assert "AKM-BOOTSTRAP FATAL" in result.stderr
    assert "did not take" in result.stderr


def test_align_hoisted_akm_cli_realigns_every_hoisted_copy_found(tmp_path: Path):
    """`find ... -print -quit` (first match) would realign an ARBITRARY one
    of several hoisted akm-cli copies and leave any other unpinned and
    unchecked -- silently reintroducing the drift this method exists to
    close. Two independent hoisted trees, both drifted: both must end up at
    the pin, proving the command enumerates every match rather than stopping
    at the first.
    """
    agent = make_agent(tmp_path)
    fake_home = tmp_path / "fake-home"

    def make_hoisted(name: str, version: str) -> Path:
        pkg_dir = (
            fake_home
            / ".cache"
            / "opencode"
            / "packages"
            / name
            / "node_modules"
            / "akm-cli"
        )
        pkg_dir.mkdir(parents=True)
        pkg_json = pkg_dir / "package.json"
        pkg_json.write_text(json.dumps({"name": "akm-cli", "version": version}))
        return pkg_json

    # One already at the pin, one drifted -- and in an order `find` is likely
    # to visit the drifted one second, which is exactly the case a
    # first-match `-quit` would get wrong.
    pinned_pkg = make_hoisted("akm-opencode@pin-a", AKM_CLI_VERSION)
    drifted_pkg = make_hoisted("akm-opencode@pin-b", "9.9.9-drifted")

    fake_bin = tmp_path / "fake-bin"
    fake_bin.mkdir()
    fake_npm = fake_bin / "npm"
    marker = tmp_path / "npm-was-called"
    fake_npm.write_text(
        "#!/bin/sh\n"
        f'touch {shlex.quote(str(marker))}\n'
        'while [ "$#" -gt 0 ]; do\n'
        '  case "$1" in\n'
        '    --prefix) PREFIX="$2"; shift 2 ;;\n'
        '    akm-cli@*) PINSPEC="$1"; shift ;;\n'
        "    *) shift ;;\n"
        "  esac\n"
        "done\n"
        'PIN="${PINSPEC#akm-cli@}"\n'
        'node -e \'const fs=require("fs");const p=process.argv[1];const v=process.argv[2];'
        'const j=JSON.parse(fs.readFileSync(p));j.version=v;'
        'fs.writeFileSync(p,JSON.stringify(j));\' '
        '"$PREFIX/node_modules/akm-cli/package.json" "$PIN"\n'
    )
    fake_npm.chmod(0o755)

    real_path = os.environ.get("PATH", "")
    result = run_shell(
        agent._build_align_hoisted_akm_cli_command(),
        extra_env={"HOME": str(fake_home), "PATH": f"{fake_bin}{os.pathsep}{real_path}"},
    )
    assert result.returncode == 0, result.stderr
    assert marker.is_file(), "npm was never invoked for the drifted copy"
    # The already-pinned copy was left alone (no spurious reinstall)...
    assert json.loads(pinned_pkg.read_text())["version"] == AKM_CLI_VERSION
    # ...and the drifted copy -- found second, which a `-quit` first-match
    # would have missed entirely -- was realigned to the pin too.
    assert json.loads(drifted_pkg.read_text())["version"] == AKM_CLI_VERSION
    assert result.stdout.count("realigning") == 1


def test_self_check_probes_the_config_dir_akm_cli_package_json(tmp_path: Path):
    """Probe 7c: complements 7b (which shells out to the .bin shim) by
    reading node_modules/akm-cli/package.json directly, catching a package
    present with no working bin shim. Same directory as 7b -- the plugin's
    exec-path candidate 2 -- not the in-process-import root (that one is
    covered by _build_align_hoisted_akm_cli_command(), run one install step
    earlier).
    """
    command = make_agent(tmp_path)._build_self_check_command()
    assert "$HOME/.config/opencode/node_modules/akm-cli/package.json" in command
    assert "pin bypass (package.json)" in command
    assert f'[ "$CFG_PKG_VER" = "{AKM_CLI_VERSION}" ] || fail' in command
    # Absent must fall through, not abort: the guard is -f, not a hard
    # existence assertion.
    assert 'if [ -f "$CFG_AKM_PKG" ]; then' in command


def _probe_7c_fragment(agent: AkmOpenCode) -> str:
    """Slice just probe 7c's shell out of the full self-check command.

    The full command needs a real akm/node/seed bundle to reach probe 7c at
    all; this extracts only that probe's own fragment (bounded by its
    distinctive start and its closing `fi;`) so it can be run standalone
    against a fabricated ``$HOME/.config/opencode`` with a plain `fail()`
    preamble -- real bash, real node, no container.
    """
    command = agent._build_self_check_command()
    start = command.index('CFG_AKM_PKG="$HOME/.config/opencode')
    end = command.index("fi; ", start) + len("fi; ")
    fragment = command[start:end]
    assert fragment.startswith('CFG_AKM_PKG="$HOME/.config/opencode')
    assert fragment.rstrip().endswith("fi;")
    return fragment


def test_self_check_probe_7c_passes_through_when_the_config_dir_is_absent(
    tmp_path: Path,
):
    """Real bash + real node: nothing lives at
    $HOME/.config/opencode/node_modules/akm-cli today (see the module's own
    docstring on where opencode 1.18.21 actually installs plugins), and
    absence must fall through to a healthy exit, not abort setup.
    """
    agent = make_agent(tmp_path)
    fake_home = tmp_path / "fake-home"
    fake_home.mkdir()
    script = (
        'set -euo pipefail; fail(){ echo "AKM-BOOTSTRAP FATAL: $*" >&2; exit 1; }; '
        + _probe_7c_fragment(agent)
        + ' echo "probe 7c: passed"'
    )
    result = run_shell(script, extra_env={"HOME": str(fake_home)})
    assert result.returncode == 0, result.stderr
    assert "probe 7c: passed" in result.stdout


def test_self_check_probe_7c_passes_when_the_config_dir_copy_matches_the_pin(
    tmp_path: Path,
):
    agent = make_agent(tmp_path)
    fake_home = tmp_path / "fake-home"
    pkg_dir = fake_home / ".config" / "opencode" / "node_modules" / "akm-cli"
    pkg_dir.mkdir(parents=True)
    (pkg_dir / "package.json").write_text(
        json.dumps({"name": "akm-cli", "version": AKM_CLI_VERSION})
    )
    script = (
        'set -euo pipefail; fail(){ echo "AKM-BOOTSTRAP FATAL: $*" >&2; exit 1; }; '
        + _probe_7c_fragment(agent)
        + ' echo "probe 7c: passed"'
    )
    result = run_shell(script, extra_env={"HOME": str(fake_home)})
    assert result.returncode == 0, result.stderr
    assert "probe 7c: passed" in result.stdout


def test_self_check_probe_7c_aborts_on_a_version_mismatch(tmp_path: Path):
    """The branch the string-only assertions above cannot prove by
    themselves: a present-but-wrong-version package.json in
    ~/.config/opencode/node_modules/akm-cli must actually abort setup, not
    just contain the right substrings in the source.
    """
    agent = make_agent(tmp_path)
    fake_home = tmp_path / "fake-home"
    pkg_dir = fake_home / ".config" / "opencode" / "node_modules" / "akm-cli"
    pkg_dir.mkdir(parents=True)
    (pkg_dir / "package.json").write_text(
        json.dumps({"name": "akm-cli", "version": "9.9.9-bypass"})
    )
    script = (
        'set -euo pipefail; fail(){ echo "AKM-BOOTSTRAP FATAL: $*" >&2; exit 1; }; '
        + _probe_7c_fragment(agent)
        + ' echo "probe 7c: passed"'
    )
    result = run_shell(script, extra_env={"HOME": str(fake_home)})
    assert result.returncode != 0
    assert "probe 7c: passed" not in result.stdout
    assert "AKM-BOOTSTRAP FATAL" in result.stderr
    assert "pin bypass (package.json)" in result.stderr
    assert "9.9.9-bypass" in result.stderr


def test_install_runs_the_self_check_last(installed):
    _, env = installed
    assert "AKM-BOOTSTRAP FATAL" in env.commands[-1]
    self_check = env.commands[-1]
    for probe in (
        "command -v akm",
        "akm info --format json",
        "akm curate",
        "akm feedback",
        PLUGIN_RESOLVED_MARKER,
        PLUGIN_FAILED_MARKER,
    ):
        assert probe in self_check
    # FTS does not stem, so the read-path probe must be prefix enumeration.
    assert "akm search knowledge/" in self_check
    assert "akm search deploy" not in self_check


def test_self_check_proves_akm_works_without_nvm_or_a_path_pin(installed):
    """The only probe that actually exercises the /usr/local/bin symlinks.

    Every other akm invocation in the self-check runs after the nvm prelude,
    which would mask a broken symlink. This one matters because AKM_ENV
    deliberately does not pin PATH (pinning it on one arm is a confound) and
    the plugin spawns a bare `akm` via execFileSync with the opencode process
    env -- no shell, no nvm.
    """
    _, env = installed
    self_check = env.commands[-1]
    assert "( PATH=/usr/local/bin:/usr/bin:/bin;" in self_check
    # `akm --version` also proves the `#!/usr/bin/env node` shebang resolves.
    assert "akm --version >/dev/null ) ||" in self_check


def test_self_check_receives_the_seed_expectations(installed):
    _, env = installed
    self_check_env = env.execs[-1]["env"]
    assert self_check_env["AKM_SEED_MIN_ENTRIES"] == str(
        sum(SEED_EXPECTED_BY_TYPE.values())
    )
    assert "knowledge" in self_check_env["AKM_SEED_EXPECTED_BY_TYPE"]
    assert self_check_env["AKM_EVENT_SOURCE"] == "audit"


def test_install_marks_every_agent_shell_as_audit_traffic(installed):
    """Structural, not per-call-site.

    The exec issued by super().install() carries no env of its own, so without
    a phase-scoped default it would leak into akm's usage events as "user"
    traffic and perturb the rankings the trial then measures.
    """
    _, env = installed
    agent_execs = [e for e in env.execs if e["user"] != "root"]
    assert agent_execs, "install() issued no agent-user execs"
    for entry in agent_execs:
        assert entry["env"]["AKM_EVENT_SOURCE"] == "audit", entry["command"][:80]


def test_install_phase_flag_is_reset_after_a_failure(tmp_path: Path):
    agent = make_agent(tmp_path, seed_library_dir=tmp_path / "not-here")
    with pytest.raises(RuntimeError):
        asyncio.run(agent.install(FakeEnvironment()))
    assert agent._install_phase is False


def test_install_fails_fast_when_the_seed_library_is_missing(tmp_path: Path):
    agent = make_agent(tmp_path, seed_library_dir=tmp_path / "not-here")
    with pytest.raises(RuntimeError, match="seed library not found"):
        asyncio.run(agent.install(FakeEnvironment()))


# --------------------------------------------------------------------------
# Stash selection (cross-workflow contract with the corpus workflow)
# --------------------------------------------------------------------------


def test_stash_root_defaults_to_none_when_the_default_dir_is_absent(
    agent: AkmOpenCode,
):
    # isolate_default_stash_root pins DEFAULT_STASH_ROOT to a path that does
    # not exist, so the default agent -- no stash_root kwarg -- must resolve
    # to no stash configured at all, exactly like every pre-stash-selection
    # test in this file.
    assert agent._stash_root is None


def test_stash_root_default_resolution_picks_up_an_existing_default_dir(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    default_root = tmp_path / "harbor-stashes"
    default_root.mkdir()
    monkeypatch.setattr(akm_opencode, "DEFAULT_STASH_ROOT", default_root)

    agent = make_agent(tmp_path)  # no stash_root kwarg: pure default resolution
    assert agent._stash_root == default_root


def test_stash_root_explicit_kwarg_wins_over_the_default(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    default_root = tmp_path / "default-stashes"
    default_root.mkdir()
    monkeypatch.setattr(akm_opencode, "DEFAULT_STASH_ROOT", default_root)

    explicit_root = tmp_path / "explicit-stashes"
    agent = make_agent(tmp_path, stash_root=explicit_root)
    assert agent._stash_root == explicit_root
    assert agent._stash_root != default_root


def test_install_uploads_the_stash_root_once_when_configured(tmp_path: Path):
    stash_root = tmp_path / "stashes"
    (stash_root / "az-cli").mkdir(parents=True)
    agent = make_agent(tmp_path, stash_root=stash_root)
    env = FakeEnvironment()
    asyncio.run(agent.install(env))

    assert (str(stash_root), AKM_STASH_ROOT_DIR) in env.uploads
    # Uploaded exactly once, not once per potential stash inside it.
    assert env.uploads.count((str(stash_root), AKM_STASH_ROOT_DIR)) == 1
    root_commands = "\n".join(env.commands_for_user("root"))
    assert f"mkdir -p {AKM_STASH_ROOT_DIR}" in root_commands
    assert f"chown -R agent {AKM_STASH_ROOT_DIR}" in root_commands


def test_install_uploads_no_stash_root_when_not_configured(installed):
    # The default (isolated) agent: no upload targets AKM_STASH_ROOT_DIR at
    # all -- not even an empty one -- when stash_root was never configured.
    _, env = installed
    assert all(target != AKM_STASH_ROOT_DIR for _, target in env.uploads)


def test_install_fails_fast_when_a_configured_stash_root_is_missing(tmp_path: Path):
    agent = make_agent(tmp_path, stash_root=tmp_path / "does-not-exist")
    with pytest.raises(RuntimeError, match="stash root not found"):
        asyncio.run(agent.install(FakeEnvironment()))


def test_seed_bundle_command_matches_the_original_exactly_when_no_stash_root(
    tmp_path: Path,
):
    """The default-fallback path: byte-identical to the pre-stash-selection
    command, with zero container-side branching, when stash_root is None."""
    agent = make_agent(tmp_path)
    assert agent._stash_root is None
    command = agent._build_seed_bundle_command()

    assert "printenv AKM_TASK_STASH" not in command
    assert "AKM_TASK_STASH" not in command
    assert AKM_STASH_ROOT_DIR not in command
    assert (
        "set -euo pipefail; [ -f ~/.nvm/nvm.sh ] && . ~/.nvm/nvm.sh; "
        f"akm bundle create --dir {AKM_BUNDLE_DIR} --set-default && "
        f'for d in {AKM_SEED_DIR}/*/; do [ -d "$d" ] || continue; '
        f'cp -a "$d" {AKM_BUNDLE_DIR}/; done && '
        f"for d in {AKM_BUNDLE_DIR}/env {AKM_BUNDLE_DIR}/secrets; do "
        '[ -d "$d" ] && chmod 700 "$d"; done; '
        "akm index --full"
    ) == command


def test_seed_bundle_command_embeds_stash_selection_when_configured(tmp_path: Path):
    stash_root = tmp_path / "stashes"
    stash_root.mkdir()
    agent = make_agent(tmp_path, stash_root=stash_root)
    command = agent._build_seed_bundle_command()

    assert "printenv AKM_TASK_STASH" in command
    assert AKM_STASH_ROOT_DIR in command
    assert "AKM-BOOTSTRAP FATAL" in command
    # Seeds from the resolved variable, not the literal default dir, once
    # selection is in play.
    assert '"$AKM_SEED_SRC"/*/' in command
    assert f"for d in {AKM_SEED_DIR}/*/" not in command


# -- real-bash execution of the selection logic --------------------------
#
# A textual "the string 'printenv AKM_TASK_STASH' appears" assertion cannot
# prove the `[ -d ... ]` / `if` branching actually resolves the right
# directory, or actually fails loudly on an unknown one. These run the
# generated fragment through a real bash against real tmp directories.


def test_stash_select_falls_back_to_the_seed_dir_when_akm_task_stash_is_unset(
    tmp_path: Path,
):
    seed_dir = tmp_path / "seed"
    stash_root = tmp_path / "stashes"
    seed_dir.mkdir()
    stash_root.mkdir()
    script = AkmOpenCode._build_stash_select_command(str(seed_dir), str(stash_root))

    result = run_shell(script + '; echo "RESOLVED=$AKM_SEED_SRC"')
    assert result.returncode == 0, result.stderr
    assert f"RESOLVED={seed_dir}" in result.stdout


def test_stash_select_falls_back_when_akm_task_stash_is_the_empty_string(
    tmp_path: Path,
):
    seed_dir = tmp_path / "seed"
    stash_root = tmp_path / "stashes"
    seed_dir.mkdir()
    stash_root.mkdir()
    script = AkmOpenCode._build_stash_select_command(str(seed_dir), str(stash_root))

    result = run_shell(
        script + '; echo "RESOLVED=$AKM_SEED_SRC"', extra_env={"AKM_TASK_STASH": ""}
    )
    assert result.returncode == 0, result.stderr
    assert f"RESOLVED={seed_dir}" in result.stdout


def test_stash_select_uses_the_named_stash_when_present_under_the_root(
    tmp_path: Path,
):
    seed_dir = tmp_path / "seed"
    stash_root = tmp_path / "stashes"
    seed_dir.mkdir()
    (stash_root / "az-cli").mkdir(parents=True)
    script = AkmOpenCode._build_stash_select_command(str(seed_dir), str(stash_root))

    result = run_shell(
        script + '; echo "RESOLVED=$AKM_SEED_SRC"',
        extra_env={"AKM_TASK_STASH": "az-cli"},
    )
    assert result.returncode == 0, result.stderr
    assert f"RESOLVED={stash_root / 'az-cli'}" in result.stdout


def test_stash_select_fails_loudly_for_a_stash_not_in_the_uploaded_root(
    tmp_path: Path,
):
    """The core cross-workflow guarantee: never silently fall back.

    An AKM_TASK_STASH naming a stash absent from the uploaded root must abort
    setup, not quietly seed a different (default or wrong-task) library --
    that would corrupt the arm by measuring against the wrong knowledge base
    while result.json still claims the requested stash.
    """
    seed_dir = tmp_path / "seed"
    stash_root = tmp_path / "stashes"
    seed_dir.mkdir()
    stash_root.mkdir()
    (stash_root / "az-cli").mkdir()  # a real stash exists, just not this one
    script = AkmOpenCode._build_stash_select_command(str(seed_dir), str(stash_root))

    result = run_shell(script, extra_env={"AKM_TASK_STASH": "does-not-exist"})
    assert result.returncode == 1
    assert "AKM-BOOTSTRAP FATAL" in result.stderr
    assert "AKM_TASK_STASH=does-not-exist" in result.stderr
    assert "not found under" in result.stderr
    assert str(stash_root) in result.stderr


# --------------------------------------------------------------------------
# The accumulating arm (shared_bundle_path, decision D7)
# --------------------------------------------------------------------------


def test_shared_bundle_path_sets_akm_bundle_dir(tmp_path: Path):
    agent = make_agent(tmp_path, shared_bundle_path="/mnt/shared/bundle")
    assert agent._akm_env["AKM_BUNDLE_DIR"] == "/mnt/shared/bundle"


def test_shared_bundle_path_wins_over_the_akm_bundle_dir_kwarg(tmp_path: Path):
    agent = make_agent(
        tmp_path,
        akm_bundle_dir="/srv/library",
        shared_bundle_path="/mnt/shared/bundle",
    )
    assert agent._akm_env["AKM_BUNDLE_DIR"] == "/mnt/shared/bundle"


def test_shared_bundle_path_skips_the_seed_library_precondition(tmp_path: Path):
    # The static arm's precondition (seed_library_dir must exist) has nothing
    # to do with this arm, which never reads it.
    agent = make_agent(
        tmp_path,
        shared_bundle_path="/mnt/shared/bundle",
        seed_library_dir=tmp_path / "does-not-exist",
    )
    env = FakeEnvironment()
    asyncio.run(agent.install(env))  # must not raise
    assert env.uploads == []


def test_shared_bundle_path_uploads_nothing_and_never_seeds(tmp_path: Path):
    agent = make_agent(tmp_path, shared_bundle_path="/mnt/shared/bundle")
    env = FakeEnvironment()
    asyncio.run(agent.install(env))

    assert env.uploads == []
    text = env.all_commands_text
    assert "akm bundle create" not in text
    assert "cp -a" not in text
    assert "akm index --full" not in text


def test_shared_bundle_path_indexes_only_when_the_bundle_has_no_index_yet(
    tmp_path: Path,
):
    agent = make_agent(tmp_path, shared_bundle_path="/mnt/shared/bundle")
    env = FakeEnvironment()
    asyncio.run(agent.install(env))

    index_command = next(c for c in env.commands if "akm info --format json" in c)
    assert "akm info --format json -q > /tmp/akm-shared-info.json" in index_command
    assert "HAS_INDEX" in index_command
    assert 'if [ "$HAS_INDEX" != "1" ]; then akm index; fi' in index_command
    # Bare `akm index`, never the seeding arm's `--full` sweep.
    assert "akm index --full" not in index_command


def test_shared_bundle_index_command_runs_index_when_entry_count_is_zero(
    tmp_path: Path,
):
    """Real bash + a fake akm on PATH: proves the conditional actually fires,
    not just that its text is present."""
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    called_log = tmp_path / "index-called.log"
    fake_akm = fake_bin / "akm"
    fake_akm.write_text(
        "#!/bin/sh\n"
        'if [ "$1" = "info" ]; then echo \'{"indexStats":{"entryCount":0}}\'; '
        f'elif [ "$1" = "index" ]; then echo called >> {called_log}; fi\n'
    )
    fake_akm.chmod(0o755)

    script = AkmOpenCode._build_shared_bundle_index_command()
    result = run_shell(script, extra_env={"PATH": f"{fake_bin}:{os.environ['PATH']}"})
    assert result.returncode == 0, result.stderr
    assert called_log.exists()


def test_shared_bundle_index_command_skips_index_when_already_indexed(tmp_path: Path):
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    called_log = tmp_path / "index-called.log"
    fake_akm = fake_bin / "akm"
    fake_akm.write_text(
        "#!/bin/sh\n"
        'if [ "$1" = "info" ]; then echo \'{"indexStats":{"entryCount":42}}\'; '
        f'elif [ "$1" = "index" ]; then echo called >> {called_log}; fi\n'
    )
    fake_akm.chmod(0o755)

    script = AkmOpenCode._build_shared_bundle_index_command()
    result = run_shell(script, extra_env={"PATH": f"{fake_bin}:{os.environ['PATH']}"})
    assert result.returncode == 0, result.stderr
    assert not called_log.exists()


def test_shared_bundle_path_self_check_skips_the_per_type_seed_count_probe(tmp_path: Path):
    """The accumulating arm skips the STATIC arm's per-type seed-count
    assertions (which describe a fixture it never writes) but still gets a
    lighter, arm-appropriate probe: AKM_BUNDLE_DIR resolved to the shared
    mount, and a non-empty index (S8 fix -- previously this arm's self-check
    proved nothing at all about whether the bundle resolved)."""
    agent = make_agent(tmp_path, shared_bundle_path="/mnt/shared/bundle")
    self_check = agent._build_self_check_command()

    assert "AKM_SEED_MIN_ENTRIES" not in self_check
    assert "AKM_SEED_EXPECTED_BY_TYPE" not in self_check
    assert "defaultBundle" not in self_check
    # The lighter probe IS present:
    assert "akm info assertions failed" in self_check
    assert "/tmp/akm-info.json" in self_check
    assert "akm info OK (accumulating)" in self_check
    assert "entryCount=\"+n+\" (want >0)" in self_check


def test_shared_bundle_path_self_check_keeps_every_plugin_and_pin_probe(
    tmp_path: Path,
):
    agent = make_agent(tmp_path, shared_bundle_path="/mnt/shared/bundle")
    self_check = agent._build_self_check_command()

    for probe in (
        "command -v akm",  # 1 / 1b
        "akm search knowledge/",  # 3
        "akm curate",  # 4
        "akm feedback",  # 5
        "akm-opencode is not in the opencode",  # 6
        "akm-cli version skew",  # 7
        "pin bypass",  # 7b
        PLUGIN_RESOLVED_MARKER,  # 8
        PLUGIN_FAILED_MARKER,  # 8
    ):
        assert probe in self_check


def test_default_arm_self_check_still_includes_the_seed_count_probe(
    agent: AkmOpenCode,
):
    # Pins the other side of the branch: nothing about adding the
    # accumulating arm may weaken the static arm's self-check.
    self_check = agent._build_self_check_command()
    assert "AKM_SEED_MIN_ENTRIES" in self_check
    assert "AKM_SEED_EXPECTED_BY_TYPE" in self_check
    assert "akm info assertions failed" in self_check


# --------------------------------------------------------------------------
# Run-phase proof (the plugin was actually live during the MEASURED run)
# --------------------------------------------------------------------------


def write_run_log(agent: AkmOpenCode, text: str, name: str = "2026-01-01.log") -> Path:
    """Put *text* where Harbor's synced run-phase opencode log lands."""
    log_dir = agent.logs_dir / RUN_LOG_RELDIR
    log_dir.mkdir(parents=True, exist_ok=True)
    path = log_dir / name
    path.write_text(text)
    return path


def test_run_log_path_matches_the_xdg_home_harbor_actually_exports():
    """Couples RUN_LOG_RELDIR to Harbor rather than to a memory of Harbor.

    OpenCode.run() hardcodes the XDG_DATA_HOME; if a Harbor upgrade moves it,
    the proof would look at an empty directory and error every treatment trial.
    """
    run_source = inspect.getsource(OpenCode.run)
    assert f'"XDG_DATA_HOME"] = "{RUN_XDG_DATA_HOME}"' in run_source
    # /logs/agent is the container side of logs_dir, and opencode writes to
    # $XDG_DATA_HOME/opencode/log.
    assert RUN_XDG_DATA_HOME == "/logs/agent/opencode/xdg-data"
    assert RUN_LOG_RELDIR == "opencode/xdg-data/opencode/log"


def test_proof_passes_when_the_plugin_resolved(agent: AkmOpenCode):
    write_run_log(
        agent, f"INFO service=akm {PLUGIN_RESOLVED_MARKER} path=/usr/local/bin/akm\n"
    )
    agent.populate_context_post_run(AgentContext())
    assert agent._proof_checked is True


def test_proof_errors_when_the_plugin_never_loaded(agent: AkmOpenCode):
    """The single most dangerous defect this guards.

    A run with no plugin completes green with zero akm_* calls, which is
    byte-for-byte what "the model chose not to use akm" looks like.
    """
    write_run_log(agent, "INFO service=default started\nINFO service=session idle\n")
    with pytest.raises(AkmPluginNotLoadedError) as excinfo:
        agent.populate_context_post_run(AgentContext())
    message = str(excinfo.value)
    assert PLUGIN_RESOLVED_MARKER in message
    assert str(agent.logs_dir / RUN_LOG_RELDIR) in message
    assert AKM_PLUGIN_SPEC in message


def test_proof_errors_when_the_plugin_degraded(agent: AkmOpenCode):
    # The plugin logs this at WARN and keeps going: tools stay registered,
    # every call fails, exit code 0.
    log = write_run_log(
        agent, f"WARN service=akm {PLUGIN_FAILED_MARKER} tried=/usr/local/bin/akm\n"
    )
    with pytest.raises(AkmPluginNotLoadedError) as excinfo:
        agent.populate_context_post_run(AgentContext())
    message = str(excinfo.value)
    assert PLUGIN_FAILED_MARKER in message
    assert str(log) in message


def test_proof_errors_when_a_resolved_line_is_followed_by_a_failure(agent: AkmOpenCode):
    write_run_log(
        agent,
        f"INFO {PLUGIN_RESOLVED_MARKER}\nWARN {PLUGIN_FAILED_MARKER}\n",
    )
    with pytest.raises(AkmPluginNotLoadedError):
        agent.populate_context_post_run(AgentContext())


def test_proof_errors_when_the_log_was_never_synced(agent: AkmOpenCode):
    """No log = no evidence, and exclude_logs is the usual cause."""
    with pytest.raises(AkmPluginNotLoadedError) as excinfo:
        agent.populate_context_post_run(AgentContext())
    message = str(excinfo.value)
    assert "exclude_logs" in message
    assert RUN_XDG_DATA_HOME in message


def test_proof_scans_every_log_file(agent: AkmOpenCode):
    write_run_log(agent, "INFO service=default started\n", name="a.log")
    write_run_log(agent, f"INFO {PLUGIN_RESOLVED_MARKER}\n", name="b.log")
    agent.populate_context_post_run(AgentContext())


def test_proof_raises_only_once(agent: AkmOpenCode):
    """Trial.run() reaches this hook again from _recover_outputs().

    Raising there too would escape Trial.run() itself instead of leaving a
    cleanly errored trial with exception_info recorded.
    """
    with pytest.raises(AkmPluginNotLoadedError):
        agent.populate_context_post_run(AgentContext())
    agent.populate_context_post_run(AgentContext())  # must not raise


def test_proof_runs_after_super_populated_the_context(agent: AkmOpenCode, monkeypatch):
    """Accounting first: an invalidated trial still cost money, and that cost
    belongs in results.json. It also makes the second hook call a no-op,
    because Trial._populate_agent_context() only calls it while is_empty()."""
    calls: list[str] = []
    monkeypatch.setattr(
        OpenCode,
        "populate_context_post_run",
        lambda self, context: calls.append("super"),
    )
    with pytest.raises(AkmPluginNotLoadedError):
        agent.populate_context_post_run(AgentContext())
    assert calls == ["super"]


def test_proof_is_a_distinct_greppable_exception_type():
    # exception_info.exception_type in results.json is how these trials get
    # filtered out of an analysis.
    assert issubclass(AkmPluginNotLoadedError, RuntimeError)
    assert AkmPluginNotLoadedError.__name__ == "AkmPluginNotLoadedError"


# --------------------------------------------------------------------------
# Trajectory labelling
# --------------------------------------------------------------------------


def test_trajectory_is_relabelled_to_this_arm(agent: AkmOpenCode):
    events = [
        {
            "type": "step_start",
            "part": {"type": "step-start"},
            "sessionID": "session-1",
        },
        {"type": "text", "part": {"type": "text", "text": "hello"}},
        {
            "type": "step_finish",
            "part": {"type": "step-finish"},
            "tokens": {"input": 1, "output": 1},
            "cost": 0.0,
        },
    ]
    trajectory = agent._convert_events_to_trajectory(events)
    if trajectory is None:
        pytest.skip("OpenCode's parser produced no trajectory for this event shape")
    # OpenCode hardcodes Agent(name="opencode") regardless of subclass.
    assert trajectory.agent.name == "akm-opencode"


# --------------------------------------------------------------------------
# Seed library on disk
# --------------------------------------------------------------------------


def test_seed_library_ships_next_to_the_module():
    assert DEFAULT_SEED_LIBRARY_DIR == SEED_LIBRARY_DIR
    assert SEED_LIBRARY_DIR.is_dir()


@pytest.mark.parametrize(
    ("type_dir", "expected"),
    [
        ("knowledge", 4),
        ("skills", 3),
        ("commands", 3),
        ("agents", 2),
        ("scripts", 2),
        ("lessons", 1),
    ],
)
def test_seed_library_asset_counts_match_the_self_check(type_dir: str, expected: int):
    """Keep the on-disk fixture and SEED_EXPECTED_BY_TYPE in lockstep.

    The install-time self-check asserts these counts inside the container. If
    they drift, the trial fails during setup with a confusing message instead
    of here.
    """
    files = [p for p in (SEED_LIBRARY_DIR / type_dir).rglob("*") if p.is_file()]
    assert len(files) == expected
    # akm's index type names are singular; the directories are plural.
    singular = {"skills": "skill", "commands": "command", "agents": "agent"}.get(
        type_dir, type_dir.rstrip("s") if type_dir != "knowledge" else "knowledge"
    )
    assert SEED_EXPECTED_BY_TYPE[singular] == expected


def test_seed_library_carries_no_credential_shaped_material():
    assert not (SEED_LIBRARY_DIR / "secrets").exists()
    assert not (SEED_LIBRARY_DIR / "env").exists()


def test_seed_library_readme_is_not_a_bundle_asset():
    # It sits at the seed root, and install() copies only `seed/*/`.
    assert (SEED_LIBRARY_DIR / "README.md").is_file()
    assert not list(SEED_LIBRARY_DIR.glob("*/README.md"))


# --------------------------------------------------------------------------
# A/B hygiene: the job config and this module must agree
# --------------------------------------------------------------------------


@pytest.fixture(scope="module")
def job_config() -> dict:
    return yaml.safe_load(JOB_CONFIG_PATH.read_text())


@pytest.fixture(scope="module")
def arms(job_config: dict) -> tuple[dict, dict]:
    agents = job_config["agents"]
    control = next(a for a in agents if a.get("name") == "opencode")
    treatment = next(a for a in agents if a.get("import_path"))
    return control, treatment


def test_job_config_runs_both_arms(arms):
    control, treatment = arms
    assert control["name"] == "opencode"
    assert treatment["import_path"] == "harbor.akm_opencode:AkmOpenCode"


def test_job_config_pins_the_same_opencode_for_both_arms(arms):
    control, treatment = arms
    assert control["kwargs"]["version"] == OPENCODE_VERSION
    assert treatment["kwargs"]["version"] == OPENCODE_VERSION


def test_job_config_control_arm_gets_the_shared_permission_block(arms):
    """The A/B's central hygiene rule.

    Harbor already passes --dangerously-skip-permissions, so this block gates
    nothing today; it is belt-and-braces against a Harbor upgrade that drops
    that flag. Belt-and-braces on ONE arm is still a confound, so the control
    arm has to spell out byte-for-byte what the class force-injects.
    """
    control, _ = arms
    assert control["kwargs"]["opencode_config"]["permission"] == SHARED_PERMISSIONS


def test_job_config_control_arm_permission_block_only_uses_declared_keys(arms):
    control, _ = arms
    permission = control["kwargs"]["opencode_config"]["permission"]
    assert set(permission) == OPENCODE_DECLARED_PERMISSION_KEYS


def test_job_config_control_arm_has_no_akm_surface(arms):
    control, _ = arms
    control_config = control["kwargs"]["opencode_config"]
    assert "plugin" not in control_config
    # `tools` is the treatment arm's lever; the control arm must not have it.
    assert "tools" not in control_config
    for akm_tool in AKM_TOOLS:
        assert akm_tool not in control_config["permission"]


def test_job_config_control_arm_mirrors_the_treatment_defaults(arms):
    """Stock OpenCode's _DEFAULT_CONFIG is empty, so the control arm has to
    spell out what AkmOpenCode._DEFAULT_CONFIG supplies for free."""
    control, _ = arms
    control_config = control["kwargs"]["opencode_config"]
    for key, value in AkmOpenCode._DEFAULT_CONFIG.items():
        assert control_config[key] == value


def test_job_config_control_arm_disables_opencode_autoupdate_via_env_too(arms):
    """S16 hygiene fix: AkmOpenCode.AKM_ENV sets OPENCODE_DISABLE_AUTOUPDATE
    in the treatment process env as a SECOND mechanism alongside
    opencode_config.autoupdate=false; without the same env var on the
    control arm, only the treatment arm would be protected if the config key
    ever proved weaker than the env var in a given opencode release -- a
    confound (a network call and latency difference), not a convenience.
    """
    control, _ = arms
    assert control.get("env", {}).get("OPENCODE_DISABLE_AUTOUPDATE") == "true"
    assert AkmOpenCode.AKM_ENV["OPENCODE_DISABLE_AUTOUPDATE"] == "true"


def test_job_config_arms_share_model_network_and_timeouts(arms):
    control, treatment = arms
    assert control["model_name"] == treatment["model_name"]
    assert control["extra_allowed_hosts"] == treatment["extra_allowed_hosts"]
    assert (
        control["override_setup_timeout_sec"] == treatment["override_setup_timeout_sec"]
    )
    # 360s is Harbor's default and is not enough for the treatment arm's setup.
    assert treatment["override_setup_timeout_sec"] > 360


def test_job_config_arms_share_an_explicit_agent_phase_timeout(arms):
    """Without an override the AGENT budget comes from the task's [agent]
    timeout_sec -- 120s for harbor's hello-world -- and the treatment arm has
    to fit plugin session-start work into it that the control arm never pays.
    A treatment-only AgentTimeoutError would score as "akm failed the task"."""
    control, treatment = arms
    assert "override_timeout_sec" in control
    assert "override_timeout_sec" in treatment
    assert control["override_timeout_sec"] == treatment["override_timeout_sec"]
    # Generous relative to the 120s hello-world default it replaces.
    assert control["override_timeout_sec"] >= 600


def test_job_config_does_not_scale_one_phase_out_from_under_the_other(job_config: dict):
    # A multiplier applies to whatever base each arm resolves, so parity has to
    # come from the explicit per-agent overrides above.
    assert job_config["timeout_multiplier"] == 1.0


def test_job_config_allows_the_npm_registry_for_the_treatment_arm(arms):
    _, treatment = arms
    # opencode installs plugins at SESSION START, under the agent-phase policy.
    assert "registry.npmjs.org" in treatment["extra_allowed_hosts"]


def test_job_config_keeps_the_run_phase_opencode_log(arms):
    """The evidence AkmOpenCode._assert_plugin_ran() reads.

    Excluding "opencode/xdg-data/**" is inert on Docker (mounted environments
    short-circuit log filtering) but deletes the run-phase log -- the
    "AKM CLI resolved" marker and the akm.<surface>.<outcome> lines -- on any
    non-mounted/cloud environment. It cannot be rescued with an include:
    harbor/utils/path_filter.py applies exclude AFTER include, so exclude wins.
    """
    from fnmatch import fnmatch

    evidence = (
        f"{RUN_LOG_RELDIR}/2026-01-01.log",
        "opencode/xdg-state/akm-opencode/events.jsonl",
    )
    for arm in arms:
        for pattern in arm.get("exclude_logs", []):
            for path in evidence:
                assert not fnmatch(path, pattern), (pattern, path)
        includes = arm.get("include_logs", [])
        for path in evidence:
            assert not includes or any(fnmatch(path, p) for p in includes), path


def test_job_config_runs_exactly_one_task(job_config: dict):
    assert job_config["n_attempts"] == 1
    assert len(job_config["datasets"]) == 1
    assert len(job_config["datasets"][0]["task_names"]) == 1


def test_job_config_deletes_containers_between_trials(job_config: dict):
    # The bundle is seeded per container and mutated during a trial; reusing a
    # container would let trials contaminate each other.
    assert job_config["environment"]["delete"] is True


def test_self_check_probes_the_akm_cli_pin_bypass(tmp_path: Path) -> None:
    """The plugin resolves ~/.config/opencode/node_modules/.bin/akm BEFORE the
    pinned ``akm`` on PATH (plugin index.ts:1313-1326), and npm resolves that
    copy from ``akm-cli: ^0.9.0`` independently of our pin. Probe 7 compares a
    different pair of paths (the ~/.cache hoist vs the global), so without this
    probe a newer 0.9.x would silently drive the mutating call path while
    result.json still reported the pin -- a green trial measured against the
    wrong binary. Absent is fine; present-and-different must abort setup.
    """
    command = make_agent(tmp_path)._build_self_check_command()

    assert "$HOME/.config/opencode/node_modules/.bin/akm" in command
    assert "pin bypass" in command
    # The comparison must be against the pin, and must fail loudly.
    assert f'[ "$CFG_VER" = "{AKM_CLI_VERSION}" ] || fail' in command
    # Absent must fall through rather than abort: the guard is -x, not a hard
    # existence assertion.
    assert 'if [ -x "$CFG_AKM" ]; then' in command


def test_stash_select_rejects_a_traversing_stash_name(tmp_path: Path):
    """A name with a `/` must be rejected, not pasted into the path.

    `[ -d "$root/../seed" ]` is TRUE for a directory that is emphatically not
    in the uploaded stash root, so without an explicit guard the one outcome
    the cross-workflow contract forbids -- silently seeding something other
    than the named stash -- is reachable through a traversing name. Here
    `../seed` would have resolved to a real, existing directory.
    """
    seed_dir = tmp_path / "seed"
    stash_root = tmp_path / "stashes"
    seed_dir.mkdir()
    stash_root.mkdir()
    script = AkmOpenCode._build_stash_select_command(str(seed_dir), str(stash_root))

    for name in ("../seed", "/etc", "a/b"):
        result = run_shell(
            script + '; echo "RESOLVED=$AKM_SEED_SRC"',
            extra_env={"AKM_TASK_STASH": name},
        )
        assert result.returncode == 1, f"{name!r} was accepted: {result.stdout}"
        assert "AKM-BOOTSTRAP FATAL" in result.stderr
        assert "not a plain stash name" in result.stderr
        assert "RESOLVED=" not in result.stdout


def test_stash_select_rejects_dot_and_dotdot(tmp_path: Path):
    """`.` and `..` contain no `/`, so the `*/*` traversal guard alone lets
    them through -- and both resolve to REAL, existing directories that are
    not the named stash: `"$root/."` is the stash root itself (the seed loop
    would then merge every stash together), and `"$root/.."` is the stash
    root's PARENT (inside AKM_ROOT, whose subtree includes bundle/, config/,
    data/, state/, cache/, seed/). This is the gap the alphanumeric-first-
    character guard closes, alongside the `*/*` check the previous test
    covers.
    """
    seed_dir = tmp_path / "seed"
    stash_root = tmp_path / "stashes"
    seed_dir.mkdir()
    stash_root.mkdir()
    (stash_root / "real-stash").mkdir()
    script = AkmOpenCode._build_stash_select_command(str(seed_dir), str(stash_root))

    for name in (".", ".."):
        result = run_shell(
            script + '; echo "RESOLVED=$AKM_SEED_SRC"',
            extra_env={"AKM_TASK_STASH": name},
        )
        assert result.returncode == 1, f"{name!r} was accepted: {result.stdout}"
        assert "AKM-BOOTSTRAP FATAL" in result.stderr
        assert "not a plain stash name" in result.stderr
        assert "RESOLVED=" not in result.stdout

    # A genuine stash name starting with a letter/digit is unaffected.
    ok = run_shell(
        script + '; echo "RESOLVED=$AKM_SEED_SRC"',
        extra_env={"AKM_TASK_STASH": "real-stash"},
    )
    assert ok.returncode == 0, ok.stderr
    assert f"RESOLVED={stash_root / 'real-stash'}" in ok.stdout


def test_shared_bundle_path_redirects_data_state_cache_config_dirs(tmp_path: Path):
    """S3/S9 fix: without this, AKM_DATA_DIR stayed container-local, so the
    accumulating arm's ranker state (and the "skip if already indexed" guard
    in _build_shared_bundle_index_command) never actually persisted across
    trials regardless of what the mounted bundle held.
    """
    agent = make_agent(tmp_path, shared_bundle_path="/mnt/shared/bundle")
    assert agent._akm_env["AKM_BUNDLE_DIR"] == "/mnt/shared/bundle"
    assert agent._akm_env["AKM_DATA_DIR"] == "/mnt/shared/bundle/.akm-bench-data"
    assert agent._akm_env["AKM_STATE_DIR"] == "/mnt/shared/bundle/.akm-bench-state"
    assert agent._akm_env["AKM_CACHE_DIR"] == "/mnt/shared/bundle/.akm-bench-cache"
    assert agent._akm_env["AKM_CONFIG_DIR"] == "/mnt/shared/bundle/.akm-bench-config"
    # All four are INSIDE the shared mount (not a sibling outside it, which
    # would not be backed by the host and would not persist).
    for key in ("AKM_DATA_DIR", "AKM_STATE_DIR", "AKM_CACHE_DIR", "AKM_CONFIG_DIR"):
        assert agent._akm_env[key].startswith("/mnt/shared/bundle/")

    dirs_command = agent._build_akm_dirs_command("agent")
    for key in ("AKM_DATA_DIR", "AKM_STATE_DIR", "AKM_CACHE_DIR", "AKM_CONFIG_DIR"):
        assert agent._akm_env[key] in dirs_command
    assert "chown -R agent /mnt/shared/bundle/.akm-bench-data" in dirs_command


def test_shared_bundle_path_trailing_slash_is_normalized(tmp_path: Path):
    agent = make_agent(tmp_path, shared_bundle_path="/mnt/shared/bundle/")
    assert agent._akm_env["AKM_BUNDLE_DIR"] == "/mnt/shared/bundle"
    assert agent._akm_env["AKM_DATA_DIR"] == "/mnt/shared/bundle/.akm-bench-data"


def test_shared_bundle_index_command_fails_loudly_when_a_task_requests_a_stash(
    tmp_path: Path,
):
    """S12 fix: the accumulating arm has ONE shared bundle for every task and
    no per-task stash selection. A task that declares AKM_TASK_STASH must not
    be silently run against whatever the shared bundle happens to contain.
    """
    script = AkmOpenCode._build_shared_bundle_index_command()
    result = run_shell(script, extra_env={"AKM_TASK_STASH": "some-stash"})
    assert result.returncode == 1
    assert "AKM-BOOTSTRAP FATAL" in result.stderr
    assert "AKM_TASK_STASH=some-stash" in result.stderr
    assert "akm-accumulating arm" in result.stderr


def test_shared_bundle_index_command_runs_normally_without_a_stash_request(
    tmp_path: Path,
):
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    fake_akm = fake_bin / "akm"
    fake_akm.write_text('#!/bin/sh\n[ "$1" = "info" ] && echo \'{"indexStats":{"entryCount":1}}\'\n')
    fake_akm.chmod(0o755)

    script = AkmOpenCode._build_shared_bundle_index_command()
    result = run_shell(script, extra_env={"PATH": f"{fake_bin}:{os.environ['PATH']}"})
    assert result.returncode == 0, result.stderr


def test_wrap_shared_lock_uses_a_lock_file_inside_the_shared_mount(tmp_path: Path):
    agent = make_agent(tmp_path, shared_bundle_path="/mnt/shared/bundle")
    wrapped = agent._wrap_shared_lock("echo hi")
    assert wrapped.startswith("flock ")
    assert "/mnt/shared/bundle/.akm-bench-setup.lock" in wrapped
    assert "echo hi" in wrapped


def test_wrap_shared_lock_actually_serializes_concurrent_execs(tmp_path: Path):
    """Not just textual: prove `flock` genuinely excludes a second, concurrent
    execution of the wrapped command from running while the first holds the
    lock -- the actual defect (S4) was that Harbor's `n_concurrent` gates only
    the agent.run() phase, never agent.setup()/install(), so two trials'
    installs could otherwise race on the same shared bundle.
    """
    shared = tmp_path / "shared-bundle"
    shared.mkdir()
    agent = make_agent(tmp_path, shared_bundle_path=str(shared))

    # A "critical section" that is very likely to interleave WITHOUT a lock:
    # read a counter, sleep, increment, write it back. Run it twice
    # concurrently, flock-wrapped; the final value must reflect two
    # serialized increments, never a lost update from an interleaved race.
    counter = shared / "counter"
    counter.write_text("0")
    bump = (
        f"n=$(cat {counter}); sleep 0.2; "
        f"echo $((n + 1)) > {counter}"
    )
    wrapped = agent._wrap_shared_lock(bump)

    import threading

    results = []

    def run_once():
        results.append(run_shell(wrapped))

    threads = [threading.Thread(target=run_once) for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=10)

    for r in results:
        assert r.returncode == 0, r.stderr
    assert counter.read_text().strip() == "2", (
        "expected two serialized increments (flock should have prevented "
        f"the interleaved read-modify-write race); got {counter.read_text()!r}"
    )


def test_install_flock_wraps_the_shared_bundle_steps_only_for_the_accumulating_arm(
    tmp_path: Path,
):
    agent = make_agent(tmp_path, shared_bundle_path="/mnt/shared/bundle")
    env = FakeEnvironment()
    asyncio.run(agent.install(env))

    # Harbor's own exec plumbing prepends `set -o pipefail; ` ahead of
    # whatever command string this agent hands it, so check containment (and
    # that `flock` is the OUTERMOST wrapper of the payload) rather than a
    # literal prefix.
    index_cmd = next(c for c in env.commands if "akm info --format json" in c)
    assert "flock /mnt/shared/bundle/.akm-bench-setup.lock -c " in index_cmd

    self_check_cmd = next(c for c in env.commands if "AKM-BOOTSTRAP FATAL" in c and "akm info" in c)
    assert "flock /mnt/shared/bundle/.akm-bench-setup.lock -c " in self_check_cmd


def test_install_does_not_flock_wrap_the_static_arm(installed):
    _, env = installed
    assert "flock " not in env.all_commands_text


def test_link_binaries_command_refuses_to_overwrite_a_real_pre_existing_file(
    tmp_path: Path,
):
    """S7 fix: `ln -sf` force-replaces whatever is already at the target with
    no check. Simulate `/usr/local/bin` with a tmp dir (never write to the
    real one in a test) by substituting the literal path in the generated
    script -- this still exercises the REAL guard logic the production
    command contains, just against a safe target.
    """
    fake_local_bin = tmp_path / "usr-local-bin"
    fake_local_bin.mkdir()
    akm_src = tmp_path / "akm-real"
    node_src = tmp_path / "node-real"
    akm_src.write_text("#!/bin/sh\n")
    node_src.write_text("#!/bin/sh\n")
    akm_src.chmod(0o755)
    node_src.chmod(0o755)

    script = AkmOpenCode._build_link_binaries_command(str(akm_src), str(node_src))
    templated = script.replace("/usr/local/bin", str(fake_local_bin))

    # Case 1: neither target exists yet -- the common, expected case at this
    # bootstrap step. Must NOT abort (regression guard against the set -e
    # pitfall of a bare `[ -e ] && [ ! -L ] && fail` list).
    ok = run_shell(templated)
    assert ok.returncode == 0, ok.stderr
    assert (fake_local_bin / "akm").is_symlink()
    assert (fake_local_bin / "node").is_symlink()

    # Case 2: a REAL (non-symlink) file already at the node target -- as a
    # task image that ships its own pinned Node toolchain would leave one.
    (fake_local_bin / "akm").unlink()
    (fake_local_bin / "node").unlink()
    (fake_local_bin / "node").write_text("#!/bin/sh\necho pinned-toolchain-node\n")
    (fake_local_bin / "node").chmod(0o755)

    blocked = run_shell(templated)
    assert blocked.returncode == 1
    assert "AKM-BOOTSTRAP FATAL" in blocked.stderr
    assert "already exists and is not a symlink" in blocked.stderr
    # Must not have been silently replaced.
    assert "pinned-toolchain-node" in (fake_local_bin / "node").read_text()


def test_link_binaries_command_allows_overwriting_a_pre_existing_symlink(
    tmp_path: Path,
):
    fake_local_bin = tmp_path / "usr-local-bin"
    fake_local_bin.mkdir()
    akm_src = tmp_path / "akm-real"
    node_src = tmp_path / "node-real"
    akm_src.write_text("#!/bin/sh\n")
    node_src.write_text("#!/bin/sh\n")
    akm_src.chmod(0o755)
    node_src.chmod(0o755)
    (fake_local_bin / "node").symlink_to(tmp_path / "some-older-node")

    script = AkmOpenCode._build_link_binaries_command(str(akm_src), str(node_src))
    templated = script.replace("/usr/local/bin", str(fake_local_bin))

    result = run_shell(templated)
    assert result.returncode == 0, result.stderr
    assert (fake_local_bin / "node").resolve() == node_src.resolve()


def test_seed_bundle_command_uses_the_akm_bundle_dir_override(tmp_path: Path):
    """S19 fix: the seed-bundle command used to hardcode the module-level
    AKM_BUNDLE_DIR constant, so an operator-supplied `akm_bundle_dir` kwarg
    seeded ``/opt/akm/bundle`` while every exec's AKM_BUNDLE_DIR env var
    pointed at the override -- a config the self-check would eventually
    catch, but only as a confusing bundleDir mismatch instead of the seed
    actually landing in the right place.
    """
    agent = make_agent(tmp_path, akm_bundle_dir="/srv/library")
    assert agent._akm_env["AKM_BUNDLE_DIR"] == "/srv/library"
    command = agent._build_seed_bundle_command()
    assert "/srv/library" in command
    assert AKM_BUNDLE_DIR not in command

    dirs_command = agent._build_akm_dirs_command("agent")
    assert "/srv/library" in dirs_command
    assert "chown -R agent /srv/library" in dirs_command


def test_trajectory_is_relabelled_per_arm_not_per_class(tmp_path: Path):
    """The trajectory's agent name must agree with result.json's agent_info.

    `_convert_events_to_trajectory` uses arm_name(), so the accumulating arm's
    trajectory.json says `akm-opencode-accumulating` -- the same label
    `agent_info.name` carries -- rather than the class-wide `akm-opencode`.
    """
    events = [
        {
            "type": "step_start",
            "part": {"type": "step-start"},
            "sessionID": "session-1",
        },
        {"type": "text", "part": {"type": "text", "text": "hello"}},
        {
            "type": "step_finish",
            "part": {"type": "step-finish"},
            "tokens": {"input": 1, "output": 1},
            "cost": 0.0,
        },
    ]
    agent = make_agent(tmp_path, shared_bundle_path="/shared/akm-bundle")
    trajectory = agent._convert_events_to_trajectory(events)
    if trajectory is None:
        pytest.skip("OpenCode's parser produced no trajectory for this event shape")
    assert trajectory.agent.name == AKM_ACCUMULATING_ARM_NAME
    assert trajectory.agent.name == agent.to_agent_info().name


def test_install_purges_non_directories_from_uploaded_stash_root() -> None:
    """The stash root is uploaded verbatim and only the treatment arm gets it,
    so any file at its top level (README, gold-ref map) is an arm-asymmetric
    answer-key channel. install() must scrub non-directories from the uploaded
    root, leaving stash content untouched."""
    source = inspect.getsource(akm_opencode)
    # BOTH uploaded roots carry the purge: the stash root AND the seed
    # library root (the treatment library's README lists the SWE-bench repo
    # names its contamination policy forbids, and only the treatment arm
    # receives the upload).
    purge = "-mindepth 1 -maxdepth 1 ! -type d -exec rm -f {} +"
    assert source.count(purge) == 2
    first = source.index(purge)
    second = source.index(purge, first + 1)
    assert "AKM_SEED_DIR" in source[first - 900 : first]
    assert "AKM_STASH_ROOT_DIR" in source[second - 900 : second]


def test_repo_stash_root_contains_only_directories() -> None:
    """Repo-hygiene twin of the in-container purge: harbor/stashes/ must hold
    stash directories only. Metadata (gold-ref map, README) lives in
    harbor/stashes-meta/, which is never uploaded."""
    stash_root = Path(__file__).resolve().parent.parent / "stashes"
    if not stash_root.is_dir():
        pytest.skip("harbor/stashes not present in this checkout")
    stray = [p.name for p in stash_root.iterdir() if not p.is_dir()]
    assert stray == [], f"non-directory entries at stash root would leak into treatment containers: {stray}"


# --------------------------------------------------------------------------
# Seed expectations follow the CONFIGURED seed library, not the smoke fixture
# --------------------------------------------------------------------------

TREATMENT_LIBRARY_DIR = REPO_ROOT / "harbor" / "treatment-library"

#: What a real akm 0.9.1 `index --full` reports for harbor/treatment-library/
#: when it is seeded through _build_seed_bundle_command()'s exact merge
#: semantics. The library was consolidated (duplicate skill/knowledge/command
#: coverage of the same topic merged into one asset each, the `commands/`
#: type retired in favor of `knowledge/` -- see its README's "Why no
#: commands/" section) and extended with net-new coverage; re-verify this
#: constant with a real hermetic akm index (`derive_seed_expectations()`
#: against the checked-out directory IS that verification, run by the test
#: below) whenever the library's asset set changes.
TREATMENT_EXPECTED_BY_TYPE = {
    "knowledge": 20,
    "skill": 3,
    "lesson": 3,
}


def test_derivation_reproduces_the_smoke_constant():
    """derive_seed_expectations() must agree with the hand-maintained
    SEED_EXPECTED_BY_TYPE for the library that constant documents. This is
    what makes the derivation trustworthy for OTHER libraries."""
    assert derive_seed_expectations(SEED_LIBRARY_DIR) == SEED_EXPECTED_BY_TYPE


def test_derivation_matches_the_treatment_library_index_shape():
    """The D6 library ships no agent, script, or command assets -- retired
    `commands/` in favor of `knowledge/`, which alone gets heading/TOC
    indexing (see the library README). Pinned against the byType a real akm
    0.9.1 index reports for it."""
    if not TREATMENT_LIBRARY_DIR.is_dir():
        pytest.fail(
            "harbor/treatment-library is missing. Both A/B job yamls hard-depend on it "
            "(seed_library_dir: harbor/treatment-library); without it every akm-static-arm "
            "trial aborts at install time. A skip here would let CI go green on exactly "
            "that omission, so this fails instead."
        )
    assert derive_seed_expectations(TREATMENT_LIBRARY_DIR) == TREATMENT_EXPECTED_BY_TYPE
    derived = derive_seed_expectations(TREATMENT_LIBRARY_DIR)
    assert "agent" not in derived and "script" not in derived and "command" not in derived


def test_derivation_skips_readmes_and_unknown_directories(tmp_path: Path):
    lib = tmp_path / "lib"
    (lib / "knowledge").mkdir(parents=True)
    (lib / "knowledge" / "README.md").write_text("not an asset")
    (lib / "knowledge" / "a.md").write_text("---\nname: a\n---\n")
    (lib / "skills" / "s").mkdir(parents=True)
    (lib / "skills" / "s" / "SKILL.md").write_text("---\nname: s\n---\n")
    (lib / "notatype").mkdir()
    (lib / "notatype" / "x.md").write_text("x")
    (lib / "README.md").write_text("library readme")
    assert derive_seed_expectations(lib) == {"knowledge": 1, "skill": 1}


def test_self_check_expectations_follow_the_configured_seed_library(tmp_path: Path):
    """Regression: both A/B job configs seed harbor/treatment-library/, which
    has no agent/script assets. Asserting the smoke fixture's per-type counts
    against it failed probe 2 on every static-arm trial."""
    if not TREATMENT_LIBRARY_DIR.is_dir():
        pytest.fail(
            "harbor/treatment-library is missing. Both A/B job yamls hard-depend on it "
            "(seed_library_dir: harbor/treatment-library); without it every akm-static-arm "
            "trial aborts at install time. A skip here would let CI go green on exactly "
            "that omission, so this fails instead."
        )
    agent = make_agent(tmp_path, seed_library_dir=TREATMENT_LIBRARY_DIR)
    env = FakeEnvironment()
    asyncio.run(agent.install(env))
    self_check = next(
        e for e in env.execs if "AKM_SEED_EXPECTED_BY_TYPE" in e["env"]
    )
    sent = json.loads(self_check["env"]["AKM_SEED_EXPECTED_BY_TYPE"])
    assert sent == TREATMENT_EXPECTED_BY_TYPE
    assert self_check["env"]["AKM_SEED_MIN_ENTRIES"] == str(sum(sent.values()))


def test_self_check_expectations_still_match_the_default_library(installed):
    _, env = installed
    self_check = next(
        e for e in env.execs if "AKM_SEED_EXPECTED_BY_TYPE" in e["env"]
    )
    assert json.loads(self_check["env"]["AKM_SEED_EXPECTED_BY_TYPE"]) == (
        SEED_EXPECTED_BY_TYPE
    )


def test_self_check_does_not_name_a_fixture_asset(tmp_path: Path):
    """Probe 5 mutates a ref taken from probe 3's own enumeration of the live
    bundle. Naming knowledge/deployment-runbook (smoke-fixture only) made it
    exit 1 with ASSET_NOT_FOUND against any other seed library."""
    agent = make_agent(tmp_path, seed_library_dir=TREATMENT_LIBRARY_DIR)
    self_check = agent._build_self_check_command()
    assert "deployment-runbook" not in self_check
    assert 'akm feedback "$AKM_FEEDBACK_REF"' in self_check
    # The ref is read from probe 3's output, so probe 3 must come first.
    assert self_check.index("/tmp/akm-search.json") < self_check.index(
        "AKM_FEEDBACK_REF"
    )


def test_install_rejects_a_seed_library_with_no_asset_directories(tmp_path: Path):
    lib = tmp_path / "empty-lib"
    (lib / "notatype").mkdir(parents=True)
    agent = make_agent(tmp_path, seed_library_dir=lib)
    with pytest.raises(RuntimeError, match="no recognisable asset type"):
        asyncio.run(agent.install(FakeEnvironment()))


def test_overrides_are_written_before_the_warm_boot(installed):
    """The overrides manifest only shapes opencode's config-dir npm install if
    it is on disk before that install runs (the warm boot)."""
    _, env = installed
    commands = env.commands
    overrides = next(
        i
        for i, c in enumerate(commands)
        if ".config/opencode/package.json" in c and "overrides" in c and "echo" in c
    )
    warm = next(i for i, c in enumerate(commands) if "warmup" in c)
    realign = next(i for i, c in enumerate(commands) if "AKM_HOISTED_ROOT" in c)
    # The realign step also carries an AKM-BOOTSTRAP FATAL message, so match
    # the self-check on its `fail()` helper definition instead.
    self_check = next(
        i for i, c in enumerate(commands) if 'fail(){ echo "AKM-BOOTSTRAP FATAL' in c
    )
    assert overrides < warm < realign < self_check


def test_overrides_manifest_is_valid_json_pinning_the_akm_cli_version(agent):
    command = agent._build_write_npm_overrides_command()
    payload = re.search(r"echo '(\{.*\})'", command).group(1)
    assert json.loads(payload)["overrides"] == {"akm-cli": AKM_CLI_VERSION}


# --------------------------------------------------------------------------
# The three-arm A/B job configs (tb2-ab.yaml, swebench-ab.yaml)
#
# Everything above this section that starts with `test_job_config_` reads
# JOB_CONFIG_PATH == harbor/jobs/p0-smoke.yaml ONLY. Neither of the two
# three-arm configs this repo actually ships for the real benchmarks was
# ever parsed by a test, so a desync between the control and static-treatment
# permission blocks in EITHER of them -- the exact confound the p0-smoke
# tests above exist to catch -- could land with CI green. This section
# closes that gap without duplicating every p0-smoke assertion: it covers
# the ones that generalize across a 3-arm config (permission-block parity,
# no akm surface on control, shared model/hosts) and, most importantly,
# would have caught the seed-library/self-check floor mismatch fixed above
# (derive_seed_expectations) before it ever landed in these two files.
# --------------------------------------------------------------------------

AB_JOB_CONFIG_PATHS = {
    "tb2-ab": REPO_ROOT / "harbor" / "jobs" / "tb2-ab.yaml",
    "swebench-ab": REPO_ROOT / "harbor" / "jobs" / "swebench-ab.yaml",
}


@pytest.fixture(params=sorted(AB_JOB_CONFIG_PATHS), scope="module")
def ab_job_name(request) -> str:
    return request.param


@pytest.fixture(scope="module")
def ab_job_config(ab_job_name: str) -> dict:
    return yaml.safe_load(AB_JOB_CONFIG_PATHS[ab_job_name].read_text())


@pytest.fixture(scope="module")
def ab_three_arms(ab_job_config: dict) -> tuple[dict, dict, dict]:
    """(control, akm-static, akm-accumulating), identified the same way
    AkmOpenCode.arm_name() distinguishes them at runtime: by whether
    `shared_bundle_path` is present in kwargs, not by list position."""
    agents = ab_job_config["agents"]
    control = next(a for a in agents if a.get("name") == "opencode")
    treatments = [a for a in agents if a.get("import_path") == "harbor.akm_opencode:AkmOpenCode"]
    assert len(treatments) == 2, "expected exactly two akm arms (static + accumulating)"
    static = next(a for a in treatments if "shared_bundle_path" not in a.get("kwargs", {}))
    accumulating = next(a for a in treatments if "shared_bundle_path" in a.get("kwargs", {}))
    return control, static, accumulating


def test_ab_job_config_runs_three_distinct_arms(ab_three_arms):
    control, static, accumulating = ab_three_arms
    assert control["name"] == "opencode"
    assert static["import_path"] == "harbor.akm_opencode:AkmOpenCode"
    assert accumulating["import_path"] == "harbor.akm_opencode:AkmOpenCode"
    assert "shared_bundle_path" in accumulating["kwargs"]
    assert "shared_bundle_path" not in static["kwargs"]


def test_ab_job_config_pins_the_same_opencode_across_all_three_arms(ab_three_arms):
    for arm in ab_three_arms:
        assert arm["kwargs"]["version"] == OPENCODE_VERSION


def test_ab_job_config_control_arm_gets_the_shared_permission_block(ab_three_arms):
    """Same central hygiene rule as p0-smoke's test of the same name, applied
    to the config that actually ships for the real benchmarks."""
    control, _static, _accumulating = ab_three_arms
    assert control["kwargs"]["opencode_config"]["permission"] == SHARED_PERMISSIONS


def test_ab_job_config_control_arm_permission_block_only_uses_declared_keys(ab_three_arms):
    control, _static, _accumulating = ab_three_arms
    permission = control["kwargs"]["opencode_config"]["permission"]
    assert set(permission) == OPENCODE_DECLARED_PERMISSION_KEYS


def test_ab_job_config_control_arm_has_no_akm_surface(ab_three_arms):
    control, _static, _accumulating = ab_three_arms
    control_config = control["kwargs"]["opencode_config"]
    assert "plugin" not in control_config
    assert "tools" not in control_config
    for akm_tool in AKM_TOOLS:
        assert akm_tool not in control_config["permission"]


def test_ab_job_config_control_arm_mirrors_the_treatment_defaults(ab_three_arms):
    control, _static, _accumulating = ab_three_arms
    control_config = control["kwargs"]["opencode_config"]
    for key, value in AkmOpenCode._DEFAULT_CONFIG.items():
        assert control_config[key] == value


def test_ab_job_config_control_arm_disables_opencode_autoupdate_via_env_too(ab_three_arms):
    control, _static, _accumulating = ab_three_arms
    assert control.get("env", {}).get("OPENCODE_DISABLE_AUTOUPDATE") == "true"


def test_ab_job_config_all_three_arms_share_model_name_and_hosts(ab_three_arms):
    control, static, accumulating = ab_three_arms
    assert control["model_name"] == static["model_name"] == accumulating["model_name"]
    assert (
        control["extra_allowed_hosts"]
        == static["extra_allowed_hosts"]
        == accumulating["extra_allowed_hosts"]
    )


def test_ab_job_config_npm_registry_is_allowed_for_both_akm_arms(ab_three_arms):
    _control, static, accumulating = ab_three_arms
    assert "registry.npmjs.org" in static["extra_allowed_hosts"]
    assert "registry.npmjs.org" in accumulating["extra_allowed_hosts"]


def test_ab_job_config_environment_deletes_containers_between_trials(ab_job_config: dict):
    assert ab_job_config["environment"]["delete"] is True


def test_ab_job_config_static_arm_seed_library_dir_satisfies_the_self_check_floor(
    ab_three_arms,
):
    """The regression this test exists to catch: a job config whose
    `seed_library_dir` kwarg points at a library the install-time self-check
    would reject (derive_seed_expectations() returning {} or a shape the
    seeded bundle cannot actually satisfy) aborts EVERY akm-static trial at
    install time -- silently collapsing the three-arm design to two arms
    while burning the paid container build first. Both shipped configs point
    the static arm at harbor/treatment-library/ (decision D6); this asserts
    that whatever they point it at resolves to a real directory with a
    non-empty per-type floor, so a future edit that repoints
    `seed_library_dir` at something self_check can't satisfy fails an
    ordinary `pytest` run instead of every trial of a live job.
    """
    _control, static, _accumulating = ab_three_arms
    configured = static["kwargs"]["seed_library_dir"]
    seed_dir = (REPO_ROOT / configured).resolve()
    assert seed_dir.is_dir(), f"seed_library_dir {configured!r} does not resolve to a directory"
    expectations = derive_seed_expectations(seed_dir)
    assert expectations, (
        f"derive_seed_expectations({configured!r}) returned {{}} -- this seed "
        "library has no recognisable asset type directories, so every "
        "akm-static trial would abort at install time (see AkmOpenCode.install()'s "
        "'contains no recognisable asset type directories' guard)."
    )
    # Every type the library ships must have at least one asset -- a zero
    # floor for a type that exists on disk would silently under-check it.
    assert all(count > 0 for count in expectations.values())


def test_ab_job_config_static_arm_uses_the_d6_treatment_library(ab_three_arms):
    """Pins the specific choice (not just "some valid library") so a silent
    revert to the smoke fixture -- which would still pass the floor check
    above, since harbor/seed-library/ is also a real, non-empty library --
    is still caught."""
    _control, static, _accumulating = ab_three_arms
    assert static["kwargs"]["seed_library_dir"] == "harbor/treatment-library"
