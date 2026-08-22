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

from harbor.akm_opencode import (  # noqa: E402
    AKM_BUNDLE_DIR,
    AKM_CLI_SPEC,
    AKM_CLI_VERSION,
    AKM_PLUGIN_SPEC,
    AKM_PLUGIN_VERSION,
    AKM_ROOT,
    AKM_SEED_DIR,
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
    # AgentInfo.name comes from name(), and JobStatistics groups arms by it.
    # Inheriting OpenCode.name() would collapse this arm into the control arm.
    assert AkmOpenCode.name() == "akm-opencode"
    assert AkmOpenCode.name() != OpenCode.name()


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
