"""Harbor custom agent: OpenCode **with the akm-opencode plugin enabled**.

This is the treatment arm of the akm A/B benchmark. It subclasses Harbor's
built-in ``OpenCode`` agent (``harbor.agents.installed.opencode:OpenCode``) and
adds exactly five things:

1. **A distinct arm label.** ``name()`` returns ``"akm-opencode"``. Harbor keys
   every A/B grouping off ``AgentInfo.name``, which comes from ``name()`` and
   *not* from the class name or the ``--agent`` import string. Without this
   override the arm would report as ``"opencode"`` and silently collapse into
   the control arm.

2. **A force-injected opencode config.** The ``plugin`` array, the ``tools``
   map that enables the five ``akm_*`` tools, and the ``permission`` block are
   merged into ``self._opencode_config`` in ``__init__``, which is the
   *highest-precedence* layer of ``OpenCode._build_register_config_command()``.
   A job that forgets (or overwrites) them therefore cannot silently degrade
   this arm into a no-plugin run. See ``_force_config()`` for the details.

3. **A container bootstrap.** ``install()`` chains ``super().install()`` (Node +
   pinned ``opencode-ai``) and then installs a pinned ``akm-cli`` globally,
   seeds and indexes an akm bundle from ``seed-library/``, pre-warms opencode's
   two plugin caches, and runs a self-check that fails the trial loudly if any
   of that did not take.

4. **AKM_* environment injection.** ``exec_as_agent()`` merges the agent's akm
   defaults *underneath* the caller-supplied ``env``, so every exec this agent
   issues — including the ``opencode ... run`` invocation built by the
   inherited ``run()`` — carries the akm configuration without having to fork
   and re-sync Harbor's ~40-line ``run()`` body.

5. **A run-phase proof.** ``populate_context_post_run()`` greps the opencode
   log written by the *measured* run for the plugin's ``AKM CLI resolved``
   line and raises ``AkmPluginNotLoadedError`` when it is missing. The plugin
   reports a failed CLI resolution as a WARN and then keeps going: the
   ``akm_*`` tools stay registered, every call degrades, and the process exits
   0. Such a trial completes green with zero ``akm_*`` calls, which is
   byte-for-byte indistinguishable from "the model chose not to use akm" —
   i.e. the treatment arm silently becomes a second control arm. install()'s
   self-check cannot cover this: it proves the plugin loads in an
   *install-time* session, and resolution is redone at every session start.

Invocation
----------
The module must be importable by dotted path; Harbor's ``import_symbol`` uses a
plain ``importlib.import_module`` with no ``sys.path`` manipulation and no
file-path support. Run from the repo root::

    # treatment arm
    PYTHONPATH="$(pwd)" harbor run \
      -p <local-task-dir> -i <task-name> \
      --agent harbor.akm_opencode:AkmOpenCode \
      -m anthropic/claude-sonnet-4-5 \
      --ak version=1.18.21 \
      --allow-agent-host registry.npmjs.org \
      --agent-setup-timeout-multiplier 7.5

    # control arm — must carry the SAME permission block (see
    # SHARED_PERMISSIONS) and NOT the `tools` map, or the A/B confounds
    # "plugin present" with "permissions granted"
    harbor run -p <local-task-dir> -i <task-name> \
      --agent opencode -m anthropic/claude-sonnet-4-5 \
      --ak version=1.18.21 \
      --ak 'opencode_config={"autoupdate":false,"permission":{...}}'

Both arms in one job: see ``harbor/jobs/p0-smoke.yaml``.

Version pinning
---------------
Every version this arm depends on is a module-level constant below
(``OPENCODE_VERSION``, ``AKM_CLI_VERSION``, ``AKM_PLUGIN_VERSION``). The control
arm cannot import them, so ``harbor/jobs/p0-smoke.yaml`` repeats
``OPENCODE_VERSION`` literally for both arms and
``harbor/tests/test_akm_opencode.py`` asserts the two stay in sync.

Status: **never executed live.** The container path below has not been run
against a real Docker daemon. See ``docs/harbor-p0.md`` for what that means.
"""

from __future__ import annotations

import json
import shlex
from pathlib import Path
from typing import Any, override

from harbor.agents.installed.opencode import OpenCode
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext
from harbor.models.trajectories import Trajectory

# ---------------------------------------------------------------------------
# Pins. Change versions HERE and nowhere else.
# ---------------------------------------------------------------------------

#: opencode-ai npm version. Consumed by ``BaseInstalledAgent.__init__``'s
#: ``version`` kwarg, which ``OpenCode.install()`` turns into
#: ``npm i -g opencode-ai@<version>``. Must be repeated verbatim in the control
#: arm's job config so both arms run the same binary.
OPENCODE_VERSION = "1.18.21"

#: akm CLI npm version, installed globally so a real ``akm`` is on PATH.
AKM_CLI_VERSION = "0.9.1"

#: akm-opencode plugin npm version. Pinned exactly (never a bare package name):
#: a bare name resolves ``latest`` at every session start, which is both
#: unpinnable and changes opencode's plugin cache directory name.
AKM_PLUGIN_VERSION = "0.9.202808220049"

AKM_CLI_SPEC = f"akm-cli@{AKM_CLI_VERSION}"
AKM_PLUGIN_SPEC = f"akm-opencode@{AKM_PLUGIN_VERSION}"

#: The plugin hard-gates on semver range ``^0.9.0``
#: (akm-plugins ``claude/shared/akm-version.ts:37``). The install-time
#: self-check asserts the globally installed CLI matches this prefix.
AKM_CLI_VERSION_PREFIX = "0.9."

#: Minimum Node major. ``akm-cli``'s preinstall script hard-fails below this.
#: Harbor's glibc path installs Node 22 via nvm, but the musl branch of
#: ``OpenCode.install()`` takes whatever ``apk`` ships — hence the assertion.
MIN_NODE_MAJOR = 22

# ---------------------------------------------------------------------------
# Container paths
# ---------------------------------------------------------------------------

#: akm lives under /opt, deliberately NOT under /tmp: akm's
#: ``isTransientStashPath()`` silently redirects config to ``$bundle/.akm`` and
#: cache to ``$bundle/.akm/cache`` for /tmp-resident bundles, and tmpfs may be
#: reaped between the setup and run phases.
AKM_ROOT = "/opt/akm"
AKM_BUNDLE_DIR = f"{AKM_ROOT}/bundle"
AKM_CONFIG_DIR = f"{AKM_ROOT}/config"
AKM_DATA_DIR = f"{AKM_ROOT}/data"
AKM_CACHE_DIR = f"{AKM_ROOT}/cache"
AKM_STATE_DIR = f"{AKM_ROOT}/state"

#: Where ``seed-library/`` is uploaded to inside the container.
AKM_SEED_DIR = f"{AKM_ROOT}/seed"

#: XDG roots used only during install(), for the cache-warming opencode boot.
#:
#: These deliberately do NOT match the values Harbor's ``run()`` exports
#: (``/logs/agent/opencode/xdg-{data,state}``). That is safe because opencode's
#: two plugin caches live under ``$HOME/.cache/opencode`` and
#: ``$HOME/.config/opencode`` — neither of which Harbor overrides — so a cache
#: warmed at install time is the same cache read at run time. Keeping DATA/STATE
#: off ``/logs/agent`` gives the self-check a deterministic log path to grep and
#: keeps install-time noise out of the collected trial logs.
INSTALL_XDG_DATA_HOME = f"{AKM_ROOT}/opencode-install/data"
INSTALL_XDG_STATE_HOME = f"{AKM_ROOT}/opencode-install/state"

#: Host-side seed bundle, resolved relative to this module so it survives being
#: imported from any working directory.
DEFAULT_SEED_LIBRARY_DIR = Path(__file__).resolve().parent / "seed-library"

# ---------------------------------------------------------------------------
# opencode permissions and tool enablement
# ---------------------------------------------------------------------------

#: The ``permission`` block BOTH arms must carry — and the *complete* set of
#: keys opencode actually declares.
#:
#: ``Config.permission`` in ``@opencode-ai/sdk@1.18.21``
#: (``dist/gen/types.gen.d.ts:1161-1169``) declares exactly these five keys,
#: each ``"ask" | "allow" | "deny"`` (``bash`` additionally accepts a
#: per-pattern map). There is NO ``read`` / ``write`` / ``grep`` / ``glob`` /
#: ``list`` / ``patch`` key and no per-plugin-tool key. An invented key is not
#: a stricter setting — it is config opencode does not implement, so writing
#: one buys nothing and reads to a reviewer as a grant that was never made.
#: Per-tool enablement lives in the SEPARATE top-level ``tools`` map
#: (``types.gen.d.ts:1170-1173``); see ``AKM_TOOLS``.
#:
#: Honest rationale for setting this at all: Harbor's ``OpenCode.run()`` passes
#: ``--dangerously-skip-permissions``, so nothing here gates tool execution
#: today. It is belt-and-braces against a Harbor upgrade that drops that flag.
#: And precisely *because* it is belt-and-braces it has to be byte-identical on
#: both arms: braces on one arm only would entangle "plugin present" with
#: "permissions granted", which is what akm-bench's legacy
#: BENCH_OPENCODE_INVARIANTS existed to prevent.
SHARED_PERMISSIONS: dict[str, str] = {
    "edit": "allow",
    "bash": "allow",
    "webfetch": "allow",
    "doom_loop": "allow",
    "external_directory": "allow",
}

#: The five tools the akm-opencode plugin registers, enabled through opencode's
#: top-level ``tools`` map (``{[key: string]: boolean}``) — the schema-supported
#: lever for per-tool enablement, and, alongside ``plugin``, the only config
#: this arm carries that the control arm does not.
#:
#: Unlisted tools keep their default, so this enables the akm surface without
#: disabling a single built-in — the two arms still see the same built-in tools.
AKM_TOOLS: dict[str, bool] = {
    "akm_search": True,
    "akm_show": True,
    "akm_curate": True,
    "akm_feedback": True,
    "akm_remember": True,
}

# ---------------------------------------------------------------------------
# Run-phase proof
# ---------------------------------------------------------------------------

#: Exported verbatim by Harbor's ``OpenCode.run()``
#: (``harbor/agents/installed/opencode.py``). opencode writes its session log to
#: ``$XDG_DATA_HOME/opencode/log/*.log``.
RUN_XDG_DATA_HOME = "/logs/agent/opencode/xdg-data"

#: The same log directory as seen on the HOST, relative to ``self.logs_dir``.
#: ``/logs/agent`` is the container side of ``logs_dir`` — which is why
#: ``OpenCode._parse_stdout()`` can read the ``/logs/agent/opencode.txt`` that
#: ``run()`` tees to — so the run-phase log lands here once Harbor has synced
#: the agent logs back (``Trial._sync_agent_output`` downloads *before* it calls
#: ``populate_context_post_run``).
RUN_LOG_RELDIR = "opencode/xdg-data/opencode/log"

#: What the plugin logs through ``client.app.log()`` once it has located the akm
#: CLI. Absent ⇒ the plugin never loaded, or died before resolution.
PLUGIN_RESOLVED_MARKER = "AKM CLI resolved"

#: The plugin's failure path. Logged at WARN, after which the session
#: CONTINUES: the ``akm_*`` tools stay registered and every call degrades. No
#: non-zero exit, no opencode ``error`` event — the log line is the only signal
#: that separates a degraded trial from a healthy one in which the model simply
#: never called akm.
PLUGIN_FAILED_MARKER = "AKM CLI resolution failed"

# ---------------------------------------------------------------------------
# Seed expectations
# ---------------------------------------------------------------------------

#: Per-type index entry counts the seeded bundle must reach. Mirrors the asset
#: table in ``seed-library/README.md``; update both together.
#:
#: These are the load-bearing assertion. ``akm bundle create`` scaffolds ~12
#: ``facts/conventions/*`` templates on its own, so a scaffold-only bundle
#: already indexes to ~12 entries and "entryCount > 0" proves nothing. Only
#: these six types come from the seed.
SEED_EXPECTED_BY_TYPE: dict[str, int] = {
    "knowledge": 4,
    "skill": 3,
    "command": 3,
    "agent": 2,
    "script": 2,
    "lesson": 1,
}

#: Floor for total index entries: the 15 seeded assets. The observed total is
#: ~27 (15 seeded + ~12 scaffolded facts), but asserting 27 would false-fail if
#: ``akm bundle create``'s scaffold ever changes, whereas 15 still cleanly
#: rejects a scaffold-only (~12) bundle.
SEED_MIN_ENTRIES = sum(SEED_EXPECTED_BY_TYPE.values())


class AkmPluginNotLoadedError(RuntimeError):
    """The measured run produced no proof that akm-opencode was live.

    Raised from ``populate_context_post_run()``, which Harbor calls in
    ``Trial._sync_agent_output()`` *after* ``_download_agent_logs()``. Raising
    there aborts ``SingleStepTrial._run()`` before the verifier, so the trial is
    recorded with ``exception_info`` and no reward instead of contributing a
    green, akm-free data point to the treatment arm. A distinct exception type
    (rather than a bare ``RuntimeError``) makes those trials greppable in
    ``results.json`` via ``exception_info.exception_type``.
    """


class AkmOpenCode(OpenCode):
    """OpenCode with the akm-opencode plugin force-enabled.

    Inherited unchanged and deliberately not redeclared: ``SUPPORTS_ATIF``,
    ``SUPPORTS_RESUME``, ``MODEL_CONNECTION`` (passthrough — changing it breaks
    provider auth), ``CLI_FLAGS``, ``_OUTPUT_FILENAME`` (must stay
    ``opencode.txt``; ``run()`` tees to that literal path), ``run()`` and
    ``get_version_command()``.

    ``populate_context_post_run()`` IS overridden, but only to chain
    ``super()`` — which is how token and cost accounting reaches
    ``results.json`` — before asserting the run-phase plugin proof.
    """

    #: Overridable defaults. These sit at the LOWEST precedence layer, so a job
    #: may legitimately override them via ``--ak opencode_config=...``.
    _DEFAULT_CONFIG: dict[str, Any] = {
        "$schema": "https://opencode.ai/config.json",
        "autoupdate": False,
    }

    #: Load-bearing invariants. Force-merged into ``self._opencode_config``
    #: (the HIGHEST precedence layer) so a job config cannot drop them.
    #: ``model`` is deliberately absent: Harbor passes ``--model=`` on the
    #: opencode command line and generates the ``provider`` block from
    #: ``model_name``, so pinning a model here would fight the ``-m`` flag.
    #:
    #: ``tools`` and ``permission`` are separate top-level maps in opencode's
    #: schema and are NOT interchangeable: the ``akm_*`` keys belong in
    #: ``tools`` (per-tool enablement) and would be unknown keys under
    #: ``permission``. ``plugin`` is forced in ``_force_config()`` rather than
    #: here because it is a list and needs a union, not a dict merge.
    _FORCED_CONFIG: dict[str, Any] = {
        "permission": SHARED_PERMISSIONS,
        "tools": AKM_TOOLS,
    }

    #: akm configuration applied to every exec this agent issues.
    #:
    #: Precedence, lowest to highest: these defaults < the per-call ``env=``
    #: dict < Harbor's Trial scoped overlay (``--ae`` / ``agents[].env``).
    #: ``BaseEnvironment._merge_env`` applies the scoped overlay last, so an
    #: operator can always override any of these from the CLI — but it also
    #: means these cannot be hard-pinned against ``--ae``.
    AKM_ENV: dict[str, str] = {
        # All five directory pins are mandatory together. Harbor's run() exports
        # XDG_DATA_HOME=/logs/agent/opencode/xdg-data, so without AKM_DATA_DIR
        # the index.db built during install() ($HOME/.local/share/akm) is a
        # DIFFERENT database than the one read at run time. That failure is
        # silent: every akm call returns zero results and no error.
        "AKM_BUNDLE_DIR": AKM_BUNDLE_DIR,
        "AKM_CONFIG_DIR": AKM_CONFIG_DIR,
        "AKM_DATA_DIR": AKM_DATA_DIR,
        "AKM_CACHE_DIR": AKM_CACHE_DIR,
        "AKM_STATE_DIR": AKM_STATE_DIR,
        # Route index-time and query-time embedding through the model-free
        # feature hasher: byte-identical vectors across machines, and
        # @huggingface/transformers is never dynamically imported (no model
        # download, no egress).
        "AKM_EMBED_DETERMINISTIC": "1",
        # Memory harvest shells out to `akm proposal extract`, which is
        # LLM-required and exits 78 LLM_NOT_CONFIGURED here: pure latency and
        # log noise. Only the literal "0" disables it.
        "AKM_AUTO_MEMORY": "0",
        # The session-end index refresh races container teardown and mutates the
        # index mid-measurement.
        "AKM_INDEX_ON_SESSION_END": "0",
        # Auto-feedback mutates utility scores during the trial. In a
        # single-turn `opencode run` the resulting ranking change lands on a
        # next turn that never comes, so it can only add state noise.
        "AKM_AUTO_FEEDBACK": "0",
        # Per-prompt curation and the hints doctrine block ARE the treatment.
        # Left at their defaults (on) and stated explicitly so the arm is
        # self-documenting.
        "AKM_AUTO_CURATE": "1",
        "AKM_AUTO_HINTS": "1",
        # Each plugin -> akm CLI call is a synchronous execFileSync costing
        # ~1.1s cold on the Node launcher. The 2s / 8s defaults are coin-flips
        # in a loaded container.
        "AKM_PENDING_PROPOSAL_TIMEOUT": "5",
        "AKM_CURATE_TIMEOUT": "15",
        # Default for the *measured* process: the opencode run and every plugin
        # hook and akm_* tool under it. Install-time harness shells override
        # this to "audit" via their per-call env= so our own scaffolding does
        # not register as demand or move the utility scores the ranker then
        # uses during the trial. Unset would default to "user" anyway; setting
        # it explicitly survives someone exporting "audit" globally.
        "AKM_EVENT_SOURCE": "user",
        # Belt-and-braces with "autoupdate": false in opencode.json.
        "OPENCODE_DISABLE_AUTOUPDATE": "true",
        # DELIBERATELY NO "PATH" KEY. Harbor renders every env entry as a
        # `docker exec -e KEY=VALUE` and runs a NON-login `bash -c`, so a PATH
        # set here REPLACES the image's PATH for the measured run rather than
        # extending it — and only on this arm, because the control arm has no
        # AKM_ENV. Any task image whose toolchain lives outside the pinned
        # directories (a venv, conda, ~/.local/bin, cargo, go) would lose it in
        # the treatment arm ONLY, and "python: not found" would read as akm
        # making the agent worse. `akm` is instead made reachable by install()
        # step 4, which symlinks it into /usr/local/bin — on the default PATH
        # of every Harbor base image — and the self-check proves that from a
        # deliberately minimal PATH so a broken symlink cannot hide behind nvm.
    }

    def __init__(
        self,
        *args,
        opencode_config: dict[str, Any] | None = None,
        akm_plugin_spec: str | None = None,
        akm_cli_spec: str | None = None,
        akm_env: dict[str, str] | None = None,
        akm_bundle_dir: str | None = None,
        seed_library_dir: str | Path | None = None,
        **kwargs,
    ):
        # Pin opencode-ai unless the job overrode it. BaseInstalledAgent takes
        # `version` as a keyword parameter and stores it as self._version, which
        # OpenCode.install() renders as `npm i -g opencode-ai@<version>`.
        # setdefault (rather than a positional) keeps a job's --ak version=...
        # authoritative.
        kwargs.setdefault("version", OPENCODE_VERSION)

        # OpenCode.__init__ is what creates self._opencode_config, so the
        # force-merge below has to come after it.
        super().__init__(*args, opencode_config=opencode_config, **kwargs)

        self._akm_plugin_spec = akm_plugin_spec or AKM_PLUGIN_SPEC
        self._akm_cli_spec = akm_cli_spec or AKM_CLI_SPEC
        self._seed_library_dir = Path(seed_library_dir or DEFAULT_SEED_LIBRARY_DIR)

        self._akm_env = {**self.AKM_ENV, **(akm_env or {})}
        if akm_bundle_dir:
            self._akm_env["AKM_BUNDLE_DIR"] = akm_bundle_dir

        # True only for the duration of install(). See exec_as_agent().
        self._install_phase = False

        # One-shot latch for the run-phase proof. See _assert_plugin_ran().
        self._proof_checked = False

        self._force_config()

    # -- config injection ---------------------------------------------------

    def _force_config(self) -> None:
        """Merge the load-bearing invariants into ``self._opencode_config``.

        **This is the force-inject point.** ``_build_register_config_command()``
        layers the config as::

            _DEFAULT_CONFIG  ->  auto-generated (mcp / provider)  ->  self._opencode_config

        with ``self._opencode_config`` applied LAST, so mutating it here beats
        anything the job passed via ``--ak opencode_config=...`` or
        ``agents[].kwargs.opencode_config``. Putting the invariants in
        ``_DEFAULT_CONFIG`` instead would not force anything — a job config
        would still win and the arm would degrade silently.

        Operator keys are preserved wherever they do not collide:

        * ``plugin`` is a LIST, and ``OpenCode._deep_merge`` replaces lists
          wholesale rather than recursing, so a naive merge would silently drop
          a job-supplied plugin list (or be dropped by one). It is unioned
          explicitly here, with the akm plugin first.
        * ``permission`` and ``tools`` keys the job supplied that we do not
          force survive; the specific keys in ``_FORCED_CONFIG`` win, which is
          the entire point of forcing them. In particular a job cannot set
          ``tools: {"akm_search": false}`` and quietly measure a
          half-disabled treatment arm.
        * Every unrelated top-level key (``experimental``, ``mcp``, ...) is
          untouched.
        """
        config = self._opencode_config

        operator_plugins = [
            entry
            for entry in (config.get("plugin") or [])
            if entry != self._akm_plugin_spec
        ]

        for key, forced in self._FORCED_CONFIG.items():
            existing = config.get(key)
            if isinstance(existing, dict) and isinstance(forced, dict):
                # Operator keys first so the forced keys overwrite on collision
                # while the operator's extra keys survive.
                config[key] = {**existing, **forced}
            elif isinstance(forced, dict):
                # Copy, never alias: _FORCED_CONFIG is a class attribute and a
                # later mutation of self._opencode_config would otherwise write
                # back into it and leak across agent instances.
                config[key] = {**forced}
            else:
                config[key] = forced

        config["plugin"] = [self._akm_plugin_spec, *operator_plugins]

    # -- identity -----------------------------------------------------------

    @staticmethod
    @override
    def name() -> str:
        """The A/B grouping key.

        ``BaseAgent.to_agent_info()`` builds ``AgentInfo(name=self.name(), ...)``
        and ``JobStatistics`` groups arms by ``trial_result.agent_info.name``.
        Inheriting ``OpenCode.name()`` would report this arm as ``"opencode"``
        and merge it into the control arm.
        """
        return "akm-opencode"

    @override
    def version(self) -> str | None:
        """Report the opencode pin *and* the plugin pin.

        Lands in ``AgentInfo.version`` (which the uploader keys on alongside the
        name) and in the ATIF ``Agent.version``. Safe with respect to
        ``setup()``'s version auto-detection, which tests ``self._version``
        rather than calling ``version()``.
        """
        base = super().version() or "unknown"
        return f"{base}+{self._akm_plugin_spec}"

    @override
    def _convert_events_to_trajectory(
        self, events: list[dict[str, Any]]
    ) -> Trajectory | None:
        """Relabel the ATIF trajectory.

        ``OpenCode._convert_events_to_trajectory`` hardcodes
        ``Agent(name="opencode")`` regardless of subclass, so without this the
        per-trial ``trajectory.json`` would mislabel the arm even though
        ``result.json`` is correct. (``Agent.version`` already resolves through
        ``self.version()``, so only the name needs fixing.)
        """
        trajectory = super()._convert_events_to_trajectory(events)
        if trajectory is not None:
            trajectory.agent.name = self.name()
        return trajectory

    # -- run-phase proof ----------------------------------------------------

    @override
    def populate_context_post_run(self, context: AgentContext) -> None:
        """Token/cost accounting first, then the run-phase plugin proof.

        ``super()`` runs FIRST on purpose. A trial that is about to be
        invalidated still burned tokens, and that cost belongs in
        ``results.json`` — the whole point of erroring is to record *what
        happened*, not to erase it. It also has a load-bearing side effect:
        ``Trial._populate_agent_context()`` only calls this hook while
        ``AgentContext.is_empty()``, so populating the context here makes the
        second call (from ``Trial._recover_outputs()`` on the error path) a
        no-op. ``_assert_plugin_ran()`` latches as well, for the case where
        there were no events to populate from.
        """
        super().populate_context_post_run(context)
        self._assert_plugin_ran()

    def _assert_plugin_ran(self) -> None:
        """Raise unless the RUN-PHASE opencode log proves the plugin was live.

        **Why install()'s self-check is not enough.** That self-check proves
        the plugin loads in an *install-time* session. The plugin re-resolves
        the akm CLI at every session start, so the measured run can still fail
        — a different PATH, a symlink whose target moved, an npm fetch blocked
        by the agent-phase network policy — and it fails *quietly*: one WARN
        line, tools still registered, every call degraded, exit code 0. The
        resulting trial is green with zero ``akm_*`` calls, which is exactly
        what "the model chose not to use akm" looks like. Scoring it would put
        a control-arm data point in the treatment column.

        **Where the evidence is.** Harbor's ``OpenCode.run()`` exports
        ``XDG_DATA_HOME=`` ``RUN_XDG_DATA_HOME``, so opencode writes the
        run-phase log to ``$XDG_DATA_HOME/opencode/log/*.log``, which mirrors
        to ``self.logs_dir / RUN_LOG_RELDIR`` on the host.
        ``Trial._sync_agent_output()`` calls ``_download_agent_logs()`` and
        *then* ``populate_context_post_run()``, so the files are already here.
        They are only absent if the run never started or a log filter dropped
        them — hence the pointer to ``exclude_logs`` in the message below.

        **Checked once.** ``Trial.run()`` calls ``_recover_outputs()`` after
        recording an exception, which reaches this hook a second time. Raising
        again from there would escape ``Trial.run()`` itself instead of leaving
        a cleanly errored trial behind, so the latch is not optional.
        """
        if self._proof_checked:
            return
        self._proof_checked = True

        log_dir = self.logs_dir / RUN_LOG_RELDIR
        where = f"{log_dir}/*.log"
        logs: dict[Path, str] = {}
        for path in sorted(log_dir.glob("*.log")):
            try:
                logs[path] = path.read_text(errors="replace")
            except OSError as exc:
                # Unreadable is the same evidence as absent; say so rather than
                # letting an OSError masquerade as a different failure.
                self.logger.debug(f"Could not read opencode log {path}: {exc}")

        if not logs:
            raise AkmPluginNotLoadedError(
                f"akm run-phase proof MISSING: no readable opencode log at {where}. "
                f"Harbor's OpenCode.run() exports XDG_DATA_HOME={RUN_XDG_DATA_HOME} "
                "and opencode writes $XDG_DATA_HOME/opencode/log/*.log, so this "
                "directory is empty only if the run never started or the log was "
                "filtered out of the trial. LOOK AT: (1) agents[].exclude_logs in "
                "the job config — Harbor applies exclude AFTER include, so a "
                "pattern matching 'opencode/xdg-data/**' cannot be rescued by an "
                f"include; (2) {self.logs_dir / self._OUTPUT_FILENAME}, which shows "
                "whether opencode produced any output at all. Refusing to score "
                "this trial: with no log there is no evidence this arm differed "
                "from the control arm."
            )

        degraded = sorted(
            str(path) for path, text in logs.items() if PLUGIN_FAILED_MARKER in text
        )
        if degraded:
            raise AkmPluginNotLoadedError(
                f"akm-opencode DEGRADED during the measured run: "
                f"{PLUGIN_FAILED_MARKER!r} appears in {', '.join(degraded)}. The "
                "plugin loaded but could not resolve the akm CLI; it logs that at "
                "WARN and continues, so the akm_* tools stayed registered and every "
                "call failed while the process still exited 0. LOOK AT: that log "
                "line (it names the paths the plugin tried), then /usr/local/bin/akm "
                "in the container and the AKM_* env on the opencode process — "
                "install() step 4 and AKM_ENV are what it depends on. Refusing to "
                "score this trial."
            )

        if not any(PLUGIN_RESOLVED_MARKER in text for text in logs.values()):
            raise AkmPluginNotLoadedError(
                f"akm-opencode DID NOT LOAD during the measured run: no "
                f"{PLUGIN_RESOLVED_MARKER!r} line in {where} "
                f"({len(logs)} log file(s) scanned). A trial in this state records "
                "zero akm_* calls, which is byte-for-byte indistinguishable from "
                "'the model chose not to use akm' — i.e. it would report the "
                "treatment arm as a second control arm. LOOK AT: that log for a "
                "plugin install or import error (opencode installs plugins at "
                "SESSION START, under the agent-phase network policy), and the "
                f"{self._akm_plugin_spec!r} entry in the opencode.json this arm "
                "writes to ~/.config/opencode/opencode.json. Refusing to score "
                "this trial."
            )

    # -- env injection ------------------------------------------------------

    @override
    async def exec_as_agent(
        self,
        environment: BaseEnvironment,
        command: str,
        env: dict[str, str] | None = None,
        cwd: str | None = None,
        timeout_sec: int | None = None,
    ) -> Any:
        """Inject AKM_* into every agent-user exec.

        Overriding here rather than ``run()`` means the inherited ~40-line
        ``run()`` body does not have to be copied and re-synced on every Harbor
        upgrade, and the injection also covers ``install()`` and the
        config-writer exec. ``run()`` passes its own ``env=`` (model-connection
        credentials plus ``OPENCODE_FAKE_VCS`` / ``XDG_DATA_HOME`` /
        ``XDG_STATE_HOME``); merging the akm defaults *underneath* it keeps
        those authoritative while every AKM_* key still reaches the opencode
        process.

        Note that declaring ``ENV_VARS`` descriptors instead would be a no-op:
        they only feed model-connection resolution and are never injected into
        execs unless an agent explicitly calls ``resolve_env_vars()``, which
        ``OpenCode.run()`` does not.
        """
        defaults = dict(self._akm_env)
        if self._install_phase:
            # Everything install() runs — including the execs issued by
            # super().install() — is harness scaffolding, not agent behaviour.
            # akm excludes "audit" rows from demand and utility scoring, so
            # marking the whole phase structurally (rather than per call site)
            # means a future base-class exec cannot leak in as "user" traffic
            # and move the rankings the trial then measures.
            defaults["AKM_EVENT_SOURCE"] = "audit"
        merged = {**defaults, **(env or {})}
        return await super().exec_as_agent(
            environment,
            command=command,
            env=merged,
            cwd=cwd,
            timeout_sec=timeout_sec,
        )

    # -- install ------------------------------------------------------------

    @property
    def _install_env(self) -> dict[str, str]:
        """Per-call env for install-time shells.

        Only the XDG pins: ``AKM_EVENT_SOURCE=audit`` is stamped on the whole
        install phase by ``exec_as_agent()`` instead of being repeated here.

        These XDG values deliberately differ from the ones Harbor's ``run()``
        exports, which is safe because opencode's plugin caches live under
        ``$HOME/.cache/opencode`` and ``$HOME/.config/opencode`` — paths Harbor
        never overrides — so a cache warmed here is the cache read at run time.
        Post-hoc, ``source`` in akm's usage-events table separates harness noise
        (``audit``) from agent behaviour (``user``).
        """
        return {
            "XDG_DATA_HOME": INSTALL_XDG_DATA_HOME,
            "XDG_STATE_HOME": INSTALL_XDG_STATE_HOME,
        }

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        """Node + pinned opencode-ai, then the full akm bootstrap.

        Note on failure semantics: ``exec_as_root`` / ``exec_as_agent`` raise on
        a non-zero exit code, they never return a status to check. Every step
        below is therefore its own tripwire, and any command whose failure is
        acceptable carries an explicit ``|| true``.
        """
        if not self._seed_library_dir.is_dir():
            raise RuntimeError(
                f"akm seed library not found at {self._seed_library_dir}. "
                "It ships alongside this module at harbor/seed-library; pass "
                "seed_library_dir=<path> if it lives elsewhere."
            )

        self._install_phase = True
        try:
            await self._install(environment)
        finally:
            self._install_phase = False

    async def _install(self, environment: BaseEnvironment) -> None:
        """The install steps proper. Split out so ``install()`` owns nothing but
        the precondition check and the install-phase flag."""
        owner = shlex.quote(str(environment.default_user or "root"))

        # 1. Node (nvm on glibc, apk on musl) + `npm i -g opencode-ai@<pin>`.
        await super().install(environment)

        # 2. Persistent akm directories, owned by the agent user. install()
        #    runs as the agent user, not root, so the mkdir must be root's.
        await self.exec_as_root(
            environment, command=self._build_akm_dirs_command(owner)
        )

        # 3. Global akm CLI. The plugin's bundled-CLI fallback CANNOT fire:
        #    opencode's npm hoists akm-cli to the plugin cache's package root,
        #    where the plugin's getBundledAkmCommand() does not look. Without a
        #    real `akm` on PATH the arm half-works — the in-process
        #    akm_search/show/curate still import the hoisted copy, but
        #    akm_feedback, akm_remember, session hints and bundle-dir discovery
        #    all fail — which is worse than not running the arm at all.
        await self.exec_as_agent(
            environment,
            command=self._build_install_akm_cli_command(),
            env=self._install_env,
        )

        # 4. Put `akm` and `node` on a PATH that needs no nvm sourcing, in two
        #    halves. Resolution runs through exec_as_agent, which is ALREADY the
        #    agent user with the agent's HOME and nvm; only the resulting
        #    absolute paths are handed to root's `ln`. The tempting one-liner —
        #    `su - <owner> -c 'command -v akm'` inside the root shell — is not
        #    equivalent and fails three ways this arm cannot afford, all of them
        #    treatment-only: the agent user's shell may be /usr/sbin/nologin,
        #    `su` is absent from minimal images, and AgentConfig.user is typed
        #    `str | int | None`, so a UID makes `su - 1000` look up a user
        #    literally named "1000".
        resolved = await self.exec_as_agent(
            environment,
            command=self._build_resolve_binaries_command(),
            env=self._install_env,
        )
        akm_bin, node_bin = self._parse_resolved_binaries(
            getattr(resolved, "stdout", "") or ""
        )
        await self.exec_as_root(
            environment,
            command=self._build_link_binaries_command(akm_bin, node_bin),
        )

        # 5. Upload the seed library. docker cp requires the destination
        #    directory to exist, and lands files root-owned, hence the mkdir
        #    before and the chown after.
        await self.exec_as_root(
            environment, command=f"mkdir -p {shlex.quote(AKM_SEED_DIR)}"
        )
        await environment.upload_dir(self._seed_library_dir, AKM_SEED_DIR)
        await self.exec_as_root(
            environment,
            command=f"chown -R {owner} {shlex.quote(AKM_SEED_DIR)}",
        )

        # 6. Scaffold, seed and index the bundle. All local and deterministic:
        #    no LLM, no network, no TTY.
        await self.exec_as_agent(
            environment,
            command=self._build_seed_bundle_command(),
            env=self._install_env,
        )

        # 7. Pre-warm both opencode plugin caches while egress is still open.
        #    opencode installs npm plugins at SESSION START, i.e. during
        #    agent.run(), where the task's network allowlist applies. The boot
        #    uses the REAL run-phase config and the REAL model name, so a config
        #    opencode rejects fails here, during setup, instead of during the
        #    paid run. See _build_warm_caches_command().
        await self.exec_as_agent(
            environment,
            command=self._build_warm_caches_command(),
            env=self._install_env,
        )

        # 8. Fail the trial loudly rather than shipping a half-alive arm.
        await self.exec_as_agent(
            environment,
            command=self._build_self_check_command(),
            env={
                **self._install_env,
                "AKM_SEED_EXPECTED_BY_TYPE": json.dumps(SEED_EXPECTED_BY_TYPE),
                "AKM_SEED_MIN_ENTRIES": str(SEED_MIN_ENTRIES),
                "AKM_CLI_VERSION_PREFIX": AKM_CLI_VERSION_PREFIX,
            },
        )

    # -- shell command builders (pure; unit-tested without a container) ------

    @staticmethod
    def _build_akm_dirs_command(quoted_owner: str) -> str:
        dirs = " ".join(
            shlex.quote(d)
            for d in (
                AKM_ROOT,
                AKM_BUNDLE_DIR,
                AKM_CONFIG_DIR,
                AKM_DATA_DIR,
                AKM_CACHE_DIR,
                AKM_STATE_DIR,
                AKM_SEED_DIR,
                INSTALL_XDG_DATA_HOME,
                INSTALL_XDG_STATE_HOME,
            )
        )
        return (
            "set -euo pipefail; "
            f"install -d -m 0755 {dirs} && "
            f"chown -R {quoted_owner} {shlex.quote(AKM_ROOT)}"
        )

    def _build_install_akm_cli_command(self) -> str:
        # `npm i -g akm-cli` pulls ~432MB: better-sqlite3 (the REQUIRED SQLite
        # driver on Node), sqlite-vec and @huggingface/transformers are all
        # optionalDependencies. Do not pass --omit=optional; npm cannot omit
        # transformers selectively and dropping better-sqlite3 breaks storage.
        # AKM_EMBED_DETERMINISTIC=1 keeps transformers from ever being loaded.
        return (
            "set -euo pipefail; "
            "[ -f ~/.nvm/nvm.sh ] && . ~/.nvm/nvm.sh; "
            'NODE_MAJOR="$(node -p "process.versions.node.split(\'.\')[0]")"; '
            f'if [ "$NODE_MAJOR" -lt {MIN_NODE_MAJOR} ]; then '
            f'echo "AKM-BOOTSTRAP FATAL: node $NODE_MAJOR < {MIN_NODE_MAJOR}; '
            'akm-cli preinstall will refuse to install" >&2; exit 1; fi; '
            f"npm i -g {shlex.quote(self._akm_cli_spec)} && "
            "command -v akm && akm --version"
        )

    @staticmethod
    def _build_resolve_binaries_command() -> str:
        """Print the agent user's absolute `akm` and `node` paths.

        Runs as the agent user (exec_as_agent), so nvm's shims resolve exactly
        as they do for every other install step. ``readlink -f`` dereferences
        the shim to the real file, so the symlink survives a later `nvm use`
        and does not depend on root being able to traverse the agent's $HOME.
        ``|| true`` on each `command -v` is required: under ``set -e`` an
        assignment inherits the command substitution's exit status, so a plain
        `$(command -v akm)` would abort with no message at all.
        """
        return (
            "set -euo pipefail; "
            "[ -f ~/.nvm/nvm.sh ] && . ~/.nvm/nvm.sh; "
            'AKM_BIN="$(command -v akm || true)"; '
            'NODE_BIN="$(command -v node || true)"; '
            '[ -n "$AKM_BIN" ] || { echo "AKM-BOOTSTRAP FATAL: akm not found '
            'for the agent user" >&2; exit 1; }; '
            '[ -n "$NODE_BIN" ] || { echo "AKM-BOOTSTRAP FATAL: node not found '
            'for the agent user" >&2; exit 1; }; '
            'echo "AKM_BIN=$(readlink -f "$AKM_BIN")"; '
            'echo "NODE_BIN=$(readlink -f "$NODE_BIN")"'
        )

    @staticmethod
    def _parse_resolved_binaries(stdout: str) -> tuple[str, str]:
        """Pull the two absolute paths out of _build_resolve_binaries_command().

        Fails loudly rather than symlinking something empty or relative: a
        `ln -sf "" /usr/local/bin/akm` succeeds and leaves a dangling link,
        which would then surface as the plugin's silent WARN at run time —
        the exact failure mode this module exists to make impossible.
        """
        found: dict[str, str] = {}
        for line in stdout.splitlines():
            key, sep, value = line.partition("=")
            key = key.strip()
            if sep and key in ("AKM_BIN", "NODE_BIN"):
                found[key] = value.strip()

        for key in ("AKM_BIN", "NODE_BIN"):
            value = found.get(key, "")
            if not value.startswith("/"):
                raise RuntimeError(
                    f"AKM-BOOTSTRAP FATAL: could not resolve an absolute {key} "
                    "for the agent user. `command -v` printed: "
                    f"{stdout.strip() or '<no output>'}"
                )
        return found["AKM_BIN"], found["NODE_BIN"]

    @staticmethod
    def _build_link_binaries_command(akm_bin: str, node_bin: str) -> str:
        # dist/akm is a `#!/usr/bin/env node` launcher, so `node` must be
        # reachable too or the shebang dies whenever PATH is minimal.
        #
        # /usr/local/bin is on the default PATH of every Harbor base image,
        # which is what lets AKM_ENV leave PATH alone — see the note there for
        # why pinning PATH on this arm only would be a confound. The final
        # `test -x` follows the symlinks, so a dangling link fails setup here
        # instead of degrading the plugin at run time.
        akm = shlex.quote(akm_bin)
        node = shlex.quote(node_bin)
        return (
            "set -euo pipefail; "
            "install -d -m 0755 /usr/local/bin && "
            f"ln -sf {akm} /usr/local/bin/akm && "
            f"ln -sf {node} /usr/local/bin/node && "
            "test -x /usr/local/bin/akm && test -x /usr/local/bin/node"
        )

    @staticmethod
    def _build_seed_bundle_command() -> str:
        bundle = shlex.quote(AKM_BUNDLE_DIR)
        seed = shlex.quote(AKM_SEED_DIR)
        return (
            "set -euo pipefail; "
            "[ -f ~/.nvm/nvm.sh ] && . ~/.nvm/nvm.sh; "
            # `akm setup` is never used: it hard-fails on a non-TTY without
            # --yes. `bundle create` is the low-level primitive. --set-default
            # is REQUIRED; without it a --dir with an existing default is
            # scaffolded but the default pointer is left untouched.
            f"akm bundle create --dir {bundle} --set-default && "
            # Copy only the type SUBDIRECTORIES, which both preserves the 0.9
            # layout by merging into the scaffolded dirs and skips the seed's
            # own README.md at the root (which akm would otherwise not index,
            # but which has no business in a bundle).
            f'for d in {seed}/*/; do [ -d "$d" ] || continue; '
            f'cp -a "$d" {bundle}/; done && '
            # `cp -a` relaxes pre-existing 0700 dirs to 0755. The current seed
            # ships neither env/ nor secrets/, but the scaffold creates them and
            # a future seed might carry them.
            f'for d in {bundle}/env {bundle}/secrets; do '
            '[ -d "$d" ] && chmod 700 "$d"; done; '
            # Purely local: no LLM, no network, no TTY. akm also auto-indexes on
            # write, but an explicit full index makes the install-time state
            # deterministic.
            "akm index --full"
        )

    def _build_warm_caches_command(self) -> str:
        """Boot opencode once, at setup, with the EXACT run-phase config.

        opencode 1.18.21 keeps plugins in ~/.cache/opencode/packages/<pin>/ (NOT
        the ~/.cache/opencode/node_modules the docs describe) and installs
        @opencode-ai/plugin separately into ~/.config/opencode. Warming only the
        first leaves an offline boot stalling ~70s on "background dependency
        install failed". Both are warmed by booting a real session.

        The config comes from ``_build_register_config_command()`` — the same
        method Harbor's ``run()`` calls, rendering the same bytes to the same
        path — and the boot uses ``self.model_name``, not a placeholder. That
        matters: a config opencode REJECTS (an unknown ``permission`` key, a
        malformed provider block, a bad baseURL) takes the plugin down with it,
        and the self-check's log grep in step 8 then fails *this* step, during
        setup. Warming a different, smaller config — as this used to, with
        ``{$schema, autoupdate, plugin}`` and ``--model=warmup/warmup`` — meant
        the measured run was the first time the real config was ever parsed, so
        a config-level rejection could only show up as a paid, silently
        akm-free trial.

        It also costs nothing: install() never passes
        ``self.model_connection.env``, so this boot has no provider
        credentials, model resolution fails, and no tokens are billed. What it
        *does* exercise is everything up to that point — config parse, plugin
        install, plugin load, akm CLI resolution — which is the whole claim
        "plugins install before model resolution" turned from an assumption
        into an assertion. Hence ``|| true``: the model failure is expected and
        step 8, not this exit code, is the tripwire.
        """
        if not self.model_name or "/" not in self.model_name:
            raise RuntimeError(
                "AkmOpenCode requires model_name as provider/model to warm the "
                f"opencode caches with the real run-phase config; got "
                f"{self.model_name!r}. OpenCode.run() would reject the same "
                "value later — failing here keeps it a setup error."
            )

        config_command = self._build_register_config_command()
        if config_command is None:
            raise RuntimeError(
                "OpenCode._build_register_config_command() returned None, which "
                "means the forced plugin/tools/permission config did not reach "
                "self._opencode_config. Check _force_config()."
            )

        return (
            "set -euo pipefail; "
            "[ -f ~/.nvm/nvm.sh ] && . ~/.nvm/nvm.sh; "
            f"{config_command} && "
            "mkdir -p /tmp/akm-warm && cd /tmp/akm-warm && "
            f"timeout 600 opencode --model={shlex.quote(self.model_name)} run "
            "--format=json --dangerously-skip-permissions "
            "-- warmup >/dev/null 2>&1 || true"
        )

    @staticmethod
    def _build_self_check_command() -> str:
        """Assert the bootstrap actually took. Any failure aborts the trial.

        Every JS fragment below is single-quote-free so it can be embedded in a
        single-quoted ``node -e`` argument.
        """
        bundle = shlex.quote(AKM_BUNDLE_DIR)
        info_js = (
            "const fs=require(\"fs\");"
            "const i=JSON.parse(fs.readFileSync(\"/tmp/akm-info.json\",\"utf8\"));"
            "const want=process.env.AKM_BUNDLE_DIR;"
            "if(i.bundleDir!==want)throw new Error(\"bundleDir=\"+i.bundleDir+"
            "\" want=\"+want);"
            "if(!i.defaultBundle)throw new Error(\"no defaultBundle configured\");"
            "const stats=i.indexStats||{};"
            "const min=Number(process.env.AKM_SEED_MIN_ENTRIES);"
            "const n=stats.entryCount;"
            "if(!(n>=min))throw new Error(\"indexStats.entryCount=\"+n+\" (<\"+min+"
            "\"; ~12 means only the scaffold indexed and the seed did not land)\");"
            "const byType=stats.byType||{};"
            "const wantByType=JSON.parse(process.env.AKM_SEED_EXPECTED_BY_TYPE);"
            "for(const k of Object.keys(wantByType)){"
            "if((byType[k]||0)<wantByType[k])throw new Error(\"byType.\"+k+\"=\"+"
            "(byType[k]||0)+\" want>=\"+wantByType[k]);}"
            "console.log(\"akm info OK: entries=\"+n+\" bundle=\"+i.bundleDir);"
        )
        # FTS does NOT stem: `akm search "deploy"` returns zero hits against
        # deployment-runbook. Health checks must use prefix enumeration.
        search_js = (
            "const fs=require(\"fs\");"
            "const h=JSON.parse(fs.readFileSync(\"/tmp/akm-search.json\",\"utf8\"))"
            ".hits||[];"
            "if(h.length<4)throw new Error(\"knowledge/ enumeration returned \"+"
            "h.length+\" hits, want >=4\");"
        )
        curate_js = (
            "const fs=require(\"fs\");"
            "const it=JSON.parse(fs.readFileSync(\"/tmp/akm-curate.json\",\"utf8\"))"
            ".items||[];"
            "if(!it.length)throw new Error(\"curate returned 0 items\");"
        )
        skew_js = (
            "const hoisted=require(process.env.AKM_HOISTED_PKG).version;"
            "const global_=process.env.AKM_GLOBAL_VERSION;"
            "if(hoisted!==global_)throw new Error(\"akm-cli skew: in-process=\"+"
            "hoisted+\" global=\"+global_);"
            "console.log(\"akm-cli versions agree: \"+hoisted);"
        )
        return (
            "set -euo pipefail; "
            "[ -f ~/.nvm/nvm.sh ] && . ~/.nvm/nvm.sh; "
            'fail(){ echo "AKM-BOOTSTRAP FATAL: $*" >&2; exit 1; }; '
            # 1) akm on PATH at a version the plugin's ^0.9.0 gate accepts.
            'command -v akm >/dev/null || fail "akm is not on PATH"; '
            # 1b) ...and usable from a MINIMAL PATH, with no nvm and no PATH
            #     pin. This is the only probe that actually exercises the
            #     /usr/local/bin symlinks from install() step 4: the nvm
            #     prelude above would otherwise mask a broken link. It is
            #     load-bearing because AKM_ENV deliberately does not pin PATH
            #     (pinning it on one arm is a confound) and because the plugin
            #     spawns a bare `akm` through execFileSync with the opencode
            #     process env — no shell, no nvm. `akm --version` also proves
            #     the `#!/usr/bin/env node` shebang resolves under that PATH.
            '( PATH=/usr/local/bin:/usr/bin:/bin; export PATH; '
            'command -v akm >/dev/null && akm --version >/dev/null ) || '
            'fail "akm is not usable from PATH=/usr/local/bin:/usr/bin:/bin; '
            'the /usr/local/bin symlinks did not take and the plugin spawns a '
            'bare akm"; '
            "AKM_GLOBAL_VERSION=\"$(akm --version | tr -d '[:space:]')\"; "
            'export AKM_GLOBAL_VERSION; '
            'case "$AKM_GLOBAL_VERSION" in '
            '"$AKM_CLI_VERSION_PREFIX"*) ;; '
            '*) fail "akm --version=$AKM_GLOBAL_VERSION does not satisfy '
            '${AKM_CLI_VERSION_PREFIX}x" ;; esac; '
            # 2) config, bundle and index agree, and the seed landed.
            "akm info --format json -q > /tmp/akm-info.json || "
            'fail "akm info failed"; '
            f"node -e '{info_js}' || fail \"akm info assertions failed\"; "
            # 3) read path.
            f"akm search {shlex.quote('knowledge/')} --format json -q "
            '> /tmp/akm-search.json || fail "akm search failed"; '
            f"node -e '{search_js}' || fail \"akm search prefix enumeration failed\"; "
            # 4) ranking path, with no LLM configured.
            "akm curate "
            f"{shlex.quote('how do I roll back a bad production deploy')} "
            "--limit 3 --format json -q > /tmp/akm-curate.json || "
            'fail "akm curate failed"; '
            f"node -e '{curate_js}' || fail \"akm curate returned nothing\"; "
            # 5) mutating CLI path — what akm_feedback / akm_remember shell out to.
            f"akm feedback {shlex.quote('knowledge/deployment-runbook')} "
            '--positive -q >/dev/null || fail "akm feedback failed"; '
            # 6) plugin materialised in opencode's cache. Never hardcode the
            #    layout; it is version-dependent.
            # `|| true` so a missing cache dir surfaces as the friendly
            # `fail` below rather than as a bare set -e exit with no message.
            'PLUGIN_PKG="$(find "$HOME/.cache/opencode" -maxdepth 5 -type d '
            '-name akm-opencode -print -quit 2>/dev/null || true)"; '
            '[ -n "$PLUGIN_PKG" ] || fail "akm-opencode is not in the opencode '
            'plugin cache"; '
            '[ -d "$HOME/.config/opencode/node_modules" ] || fail "opencode '
            'config-dir deps were not pre-warmed; an offline boot will stall ~70s"; '
            # 7) version skew between the two call paths: the akm-cli hoisted
            #    beside the plugin drives the in-process akm_search/show/curate,
            #    the global pin drives feedback/remember/hints.
            'AKM_HOISTED_PKG="$(find "$HOME/.cache/opencode" -path '
            "'*/node_modules/akm-cli/package.json' -print -quit "
            '2>/dev/null || true)"; '
            '[ -n "$AKM_HOISTED_PKG" ] || fail "no akm-cli hoisted beside the '
            'plugin; the in-process tools will fail to import"; '
            "export AKM_HOISTED_PKG; "
            f"node -e '{skew_js}' || fail \"akm-cli version skew\"; "
            # 7b) the pin-bypass hole. The plugin's CLI resolution walks
            #     ~/.config/opencode/node_modules/.bin/akm BEFORE bare `akm` on
            #     PATH (getPathAkmCandidates, plugin index.ts:1313-1326). npm
            #     resolves that copy from the plugin's own `akm-cli: ^0.9.0`
            #     range, independently of our pin, so the moment a newer 0.9.x
            #     publishes, the mutating call path (feedback/remember/hints)
            #     would silently run an UNPINNED CLI while result.json still
            #     reports the pin -- a green, plausible trial measured against
            #     the wrong binary. Probe 7 does not cover it: that compares the
            #     ~/.cache hoist against the global, a different pair of paths.
            #     Absent is fine (resolution falls through to the pinned PATH
            #     akm); present-and-different is not.
            'CFG_AKM="$HOME/.config/opencode/node_modules/.bin/akm"; '
            'if [ -x "$CFG_AKM" ]; then '
            'CFG_VER="$("$CFG_AKM" --version 2>/dev/null | tr -d "[:space:]" '
            '|| true)"; '
            f'[ "$CFG_VER" = "{AKM_CLI_VERSION}" ] || fail "akm-cli pin bypass: '
            f'the plugin resolves $CFG_AKM (${{CFG_VER:-unknown}}) before the '
            f'pinned PATH akm ({AKM_CLI_VERSION}); pin the transitive dep with '
            'an npm overrides entry in ~/.config/opencode/package.json"; '
            'fi; '
            # 8) strongest check: the plugin loaded and resolved akm in a real
            #    session, booted from the REAL run-phase config (step 7), so a
            #    config opencode rejects fails setup here rather than during
            #    the paid run. Resolution failure is a WARN, not a non-zero
            #    exit, so only the log proves it. The same two markers are
            #    re-checked against the RUN-phase log by _assert_plugin_ran():
            #    this install-time session cannot speak for that one.
            f'OPENCODE_LOG="{INSTALL_XDG_DATA_HOME}/opencode/log"; '
            f'grep -qh "{PLUGIN_RESOLVED_MARKER}" "$OPENCODE_LOG"/*.log || '
            f'fail "no {PLUGIN_RESOLVED_MARKER} in the opencode log at '
            '$OPENCODE_LOG; the plugin did not load, or opencode rejected the '
            'config this arm writes"; '
            f'if grep -qh "{PLUGIN_FAILED_MARKER}" "$OPENCODE_LOG"/*.log; then '
            f'fail "the opencode log contains {PLUGIN_FAILED_MARKER}"; fi; '
            'echo "AKM bootstrap OK (akm $AKM_GLOBAL_VERSION, plugin '
            "$PLUGIN_PKG)\""
        )
