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

6. **Per-task stash selection.** ``stash_root`` names a host directory with
   one subdirectory per named stash; when set (or defaulted — see
   ``stash_root`` in ``__init__``), the whole root is uploaded ONCE at install
   time and the choice of *which* stash to seed from is made
   container-side, at bundle-seed time, by reading the ``AKM_TASK_STASH`` env
   var a converted task sets via ``[environment] env`` in its ``task.toml``.
   This is one half of a cross-workflow contract with the corpus conversion
   workflow; see ``_build_stash_select_command()``. A named stash absent from
   the uploaded root fails setup loudly rather than silently seeding the
   wrong (or default) library.

7. **The accumulating arm.** ``shared_bundle_path`` switches this agent from
   "seed a pristine per-trial copy" to "point at a shared, mutable bundle and
   let it accumulate across trials" — decision D7 of
   ``docs/plans/benchmark-harness-decisions.md``. See the ``AkmOpenCode``
   class docstring for the operational requirements this arm imposes.

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
from harbor.models.trial.result import AgentInfo
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
AKM_PLUGIN_VERSION = "0.9.1202608242057"

AKM_CLI_SPEC = f"akm-cli@{AKM_CLI_VERSION}"
AKM_PLUGIN_SPEC = f"akm-opencode@{AKM_PLUGIN_VERSION}"

#: Arm label reported by ``to_agent_info()`` for the static (per-trial seeded)
#: arm, and the suffix appended for the accumulating one.
#:
#: These exist because Harbor's agent identity is ``(AgentInfo.name,
#: AgentInfo.version)`` and NOTHING else -- not the class, not the import
#: path, not the kwargs. Both akm arms are the same class at the same
#: opencode + plugin pins, so without a per-arm name their ``result.json``
#: rows are byte-identical and every grouping keyed off ``agent_info``
#: (Harbor's own ``evals`` key, ``JobStatistics``, the viewer's comparison
#: grid, the D4 ``pass_at_k`` cross-check, and any naive
#: ``(name, version, model)`` tuple downstream) SILENTLY MERGES the static and
#: accumulating arms into one bucket whose mean describes neither. Decision D7
#: of ``docs/plans/benchmark-harness-decisions.md`` forbids exactly that
#: pooling ("do not pool it with the static arm").
AKM_ARM_NAME = "akm-opencode"
AKM_ACCUMULATING_ARM_NAME = f"{AKM_ARM_NAME}-accumulating"

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

#: Where ``stash_root`` (one subdirectory per named stash) is uploaded to
#: inside the container. Selection among its subdirectories happens
#: CONTAINER-SIDE, at bundle-seed time -- see ``_build_stash_select_command()``
#: -- keyed off the ``AKM_TASK_STASH`` env var a converted task sets via
#: ``[environment] env`` in its ``task.toml``. This is the akm-bench half of
#: the cross-workflow contract; the corpus workflow owns the other half (task
#: conversion writing ``AKM_TASK_STASH`` and populating ``harbor/stashes/``).
AKM_STASH_ROOT_DIR = f"{AKM_ROOT}/stashes"

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

#: Host-side stash root: one subdirectory per named stash. Resolved relative
#: to this module, same rationale as ``DEFAULT_SEED_LIBRARY_DIR``. Unlike that
#: constant, this directory is OPTIONAL and may not exist at all -- the corpus
#: workflow that populates it may not have run yet -- so the default is
#: applied only when the directory is actually there (see ``stash_root`` in
#: ``__init__``); a missing default is silently ``None``, never an error.
DEFAULT_STASH_ROOT = Path(__file__).resolve().parent / "stashes"

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

#: Per-type index entry counts the DEFAULT (smoke) seed library must reach.
#: Mirrors the asset table in ``seed-library/README.md``; update both together.
#:
#: These are the load-bearing assertion. ``akm bundle create`` scaffolds ~12
#: ``facts/conventions/*`` templates on its own, so a scaffold-only bundle
#: already indexes to ~12 entries and "entryCount > 0" proves nothing. Only
#: these six types come from the seed.
#:
#: This constant describes ``harbor/seed-library/`` ONLY. It is NOT what the
#: self-check asserts: that comes from :func:`derive_seed_expectations` applied
#: to whatever ``seed_library_dir`` the job actually configured, so a job that
#: points the static arm at a differently-shaped library (e.g. the D6
#: ``harbor/treatment-library/``, which ships no ``agent`` and no ``script``
#: assets at all) is checked against ITS OWN shape instead of this one.
#: ``test_derivation_reproduces_the_smoke_constant`` pins the two together for
#: the default library.
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

#: Bundle type-directory name -> akm asset type. akm's bundle layout uses a
#: plural directory per singular asset type (``skills/`` -> ``skill``), except
#: ``knowledge/``, which is already singular. Verified against a real akm 0.9.1
#: index of both shipped libraries: the ``byType`` keys it reports are exactly
#: the values on the right, and asset refs are ``<directory>/<name>``.
SEED_TYPE_DIRS: dict[str, str] = {
    "skills": "skill",
    "commands": "command",
    "agents": "agent",
    "knowledge": "knowledge",
    "scripts": "script",
    "lessons": "lesson",
    "workflows": "workflow",
    "instructions": "instruction",
    "tasks": "task",
    "memories": "memory",
}


#: Inverse of :data:`SEED_TYPE_DIRS`. Asset refs are ``<directory>/<name>``, so
#: the self-check's prefix-enumeration probe needs the DIRECTORY for a type it
#: picked by count (``skill`` -> ``skills/``). Built from the forward map so the
#: two can never drift.
SEED_DIR_FOR_TYPE: dict[str, str] = {v: k for k, v in SEED_TYPE_DIRS.items()}


def derive_seed_expectations(seed_dir: Path) -> dict[str, int]:
    """Per-type index-entry floors for the seed library at ``seed_dir``.

    The self-check's strongest probe asserts that every asset type the seed
    library ships actually landed in the index. Hardcoding one library's
    per-type counts makes that probe a fixture assertion rather than a health
    check: it fails every trial of any job that seeds a DIFFERENT library, for
    a reason that has nothing to do with whether the arm works. That is not
    hypothetical -- both A/B job configs point the static arm at
    ``harbor/treatment-library/`` (decision D6), which ships no ``agent`` and
    no ``script`` assets, so the old hardcoded ``agent>=2`` / ``script>=2``
    aborted 100% of static-arm trials at install time.

    Counting rule, deliberately conservative (these are floors -- undercounting
    only weakens the probe, overcounting FALSE-FAILS a healthy trial):

    * A type directory containing subdirectories is counted by subdirectory
      (``skills/<name>/SKILL.md`` -- one entry per skill directory).
    * Otherwise it is counted by file, skipping ``README.md``. A root
      README never reaches the bundle because ``_build_seed_bundle_command``
      copies only type subdirectories (and a scaffolded bundle would not
      index a root README anyway -- measured; an UNscaffolded directory
      would, which is why the copy step, not akm, is the real guarantee).
      ``test_seed_library_readme_is_not_a_bundle_asset`` pins this.
    * Directories that are not a known akm type are ignored entirely.

    Verified against a real akm 0.9.1 ``index --full`` of both shipped
    libraries, seeded through the exact merge semantics
    ``_build_seed_bundle_command()`` uses in-container: this returns
    ``{knowledge: 4, skill: 3, command: 3, agent: 2, script: 2, lesson: 1}``
    for ``harbor/seed-library/`` (identical to :data:`SEED_EXPECTED_BY_TYPE`,
    and to akm's own reported ``byType``) and ``{knowledge: 20, skill: 3,
    lesson: 3}`` for ``harbor/treatment-library/`` (identical to the
    ``byType`` akm reports for it: 38 entries total, 26 authored + 12
    scaffolded facts; the post-review consolidation pass reshaped the
    library, and ``test_derivation_matches_the_treatment_library_index_shape``
    keeps this claim honest against the shipped tree).
    """
    expectations: dict[str, int] = {}
    for child in sorted(seed_dir.iterdir()):
        if not child.is_dir():
            continue
        asset_type = SEED_TYPE_DIRS.get(child.name)
        if asset_type is None:
            continue
        entries = [e for e in child.iterdir() if not e.name.startswith(".")]
        subdirs = [e for e in entries if e.is_dir()]
        if subdirs:
            count = len(subdirs)
        else:
            count = len(
                [
                    e
                    for e in entries
                    if e.is_file() and e.name.casefold() != "readme.md"
                ]
            )
        if count:
            expectations[asset_type] = count
    return expectations


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

    The accumulating arm (``shared_bundle_path``)
    ---------------------------------------------
    Passing ``shared_bundle_path`` switches this instance from the default
    "static" arm (a pristine per-trial bundle, seeded fresh in every
    container) to the "accumulating" arm: ``AKM_BUNDLE_DIR``, ``AKM_DATA_DIR``,
    ``AKM_STATE_DIR``, ``AKM_CACHE_DIR`` and ``AKM_CONFIG_DIR`` are ALL
    pointed at hidden, namespaced siblings inside the same directory that
    persists ACROSS trials (see ``__init__``), seeding is skipped entirely,
    and ``akm index`` runs only when that directory has no index yet. This is
    decision D7 in ``docs/plans/benchmark-harness-decisions.md`` — isolating
    retrieval value (the static arm) from learning value (this one). Every
    one of those five directories must move together: pointing only
    ``AKM_BUNDLE_DIR`` at the shared mount while leaving the other four at
    their container-local defaults would silently defeat the "learning"
    claim — the index and the ranker's learned state would still be wiped
    with the container on every trial regardless of what the mounted bundle
    held.

    Operational requirements this arm imposes, none of which this class can
    enforce from inside a single trial:

    * **A job-level mount.** ``shared_bundle_path`` must resolve to the SAME
      host location across every trial in the job — a Harbor ``--mounts``
      entry or an extra compose volume, configured at the job level, not by
      this agent. Without it, "shared" is a lie: each trial gets a fresh
      container filesystem and the path is empty every time.
    * **A pre-populated bundle.** Because seeding is skipped entirely, the
      mounted directory must already be a valid, seeded akm bundle before the
      first trial runs — this agent only *indexes* it (once, if needed), it
      never scaffolds or seeds it. Populating it is the job setup's
      responsibility, not this agent's.
    * **Order dependence.** Trials are NOT statistically independent: trial N
      can see everything trials 1..N-1 wrote (or failed to clean up) via
      ``akm_remember`` / ``akm_feedback`` / session hints. Do not pool this
      arm's trials with the static arm's, and do not treat its per-trial
      rewards as i.i.d. samples — aggregate and analyze it as an ordered
      sequence, not a set.
    * **Concurrent SETUP is a real race, and this class now closes it
      itself.** Harbor's per-agent ``n_concurrent`` gates ONLY the
      ``agent.run()`` phase (``AGENT_START``/``AGENT_END``) — verified
      against ``trial/queue.py`` and ``trial/trial.py`` — never
      ``agent.setup()``/``install()``. Setting ``n_concurrent: 1`` on this
      arm in the job config is therefore necessary but not sufficient: with
      a job-level ``n_concurrent_trials > 1``, multiple accumulating-arm
      trials can still run ``install()`` concurrently against the same
      mounted bundle. Every install step that reads or writes the shared
      bundle (the index command, and the self-check's search/curate/feedback
      probes) is wrapped in ``flock`` on a lock file inside the shared mount
      (``_wrap_shared_lock()``), which serializes them across containers
      regardless of ``n_concurrent_trials`` — but the job-level
      ``n_concurrent: 1`` recommendation still stands for the ``agent.run()``
      phase itself, which this class cannot serialize (that phase is where
      the model calls ``akm_remember`` / ``akm_feedback`` live, and Harbor
      gives no hook to flock around a phase it, not this agent, controls the
      boundaries of).
    * **No per-task stash.** A converted task's ``AKM_TASK_STASH`` (the
      cross-workflow contract; see ``_build_stash_select_command``) has no
      effect on this arm — there is ONE shared bundle for every task in the
      job, by construction. Running a stash-bearing task on this arm fails
      setup loudly (``_build_shared_bundle_index_command``) rather than
      silently ignoring the requested stash.
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
        stash_root: str | Path | None = None,
        shared_bundle_path: str | None = None,
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

        # Host dir with one subdirectory per stash. An explicit stash_root
        # (even a nonexistent one -- install() is what validates it) always
        # wins; otherwise fall back to DEFAULT_STASH_ROOT only if it actually
        # exists. Unlike the seed library, a missing default is NOT an error:
        # harbor/stashes/ may not exist at all (the corpus workflow that
        # populates it owns that half of the contract), and plain per-trial
        # seeding must keep working when it doesn't.
        if stash_root is not None:
            self._stash_root: Path | None = Path(stash_root)
        elif DEFAULT_STASH_ROOT.is_dir():
            self._stash_root = DEFAULT_STASH_ROOT
        else:
            self._stash_root = None

        # The accumulating arm. See the class docstring's "accumulating arm"
        # section for what this changes and what it requires of the job.
        self._shared_bundle_path = shared_bundle_path

        self._akm_env = {**self.AKM_ENV, **(akm_env or {})}
        if akm_bundle_dir:
            self._akm_env["AKM_BUNDLE_DIR"] = akm_bundle_dir
        if self._shared_bundle_path:
            # Wins over akm_bundle_dir: this is the more specific, more
            # consequential lever (it also changes install()'s seeding and
            # self-check behavior), so it should not lose to a more generic
            # override quietly set alongside it.
            #
            # AKM_BUNDLE_DIR alone is NOT enough to make this arm's "learning"
            # claim (decision D7) true. AKM_DATA_DIR (index.db + the
            # usage_events table the ranker actually reads), AKM_STATE_DIR and
            # AKM_CACHE_DIR would otherwise stay at their /opt/akm/...
            # CONTAINER-LOCAL defaults -- wiped with the container every
            # trial -- so a fresh trial got a fresh, empty index and ZERO
            # learned ranking signal regardless of what the mounted bundle
            # held, and `_build_shared_bundle_index_command()`'s "skip if
            # already indexed" guard could never see a non-zero entryCount
            # and therefore could never take its skip branch. Redirecting all
            # four into hidden, namespaced siblings INSIDE the same
            # host-backed mount as AKM_BUNDLE_DIR (not a sibling directory
            # outside it -- only the mount target itself is guaranteed to
            # persist across trials) fixes both: the index genuinely persists,
            # and so does the ranker's learned state.
            shared_root = self._shared_bundle_path.rstrip("/") or "/"
            self._akm_env["AKM_BUNDLE_DIR"] = shared_root
            self._akm_env["AKM_DATA_DIR"] = f"{shared_root}/.akm-bench-data"
            self._akm_env["AKM_STATE_DIR"] = f"{shared_root}/.akm-bench-state"
            self._akm_env["AKM_CACHE_DIR"] = f"{shared_root}/.akm-bench-cache"
            self._akm_env["AKM_CONFIG_DIR"] = f"{shared_root}/.akm-bench-config"

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
        """The AGENT name (not the arm label -- see ``arm_name()``).

        Inheriting ``OpenCode.name()`` would report this agent as
        ``"opencode"`` and merge it into the control arm. Kept a
        ``staticmethod`` to match ``BaseAgent.name()``'s declaration, which
        ``BaseAgent.handoff()`` calls as ``cls.name()`` -- an instance method
        here would turn that ``NotImplementedError`` into a ``TypeError``.
        """
        return AKM_ARM_NAME

    def arm_name(self) -> str:
        """The A/B grouping key, which is per-INSTANCE, not per-class.

        ``shared_bundle_path`` selects between two arms that decision D7
        requires be analyzed separately (static = retrieval value,
        accumulating = learning value), and Harbor's agent identity is
        ``(AgentInfo.name, AgentInfo.version)`` and nothing else. Both arms
        run this same class at the same pins, so ``version()`` is identical
        too -- the name is the only field left that can separate them in
        ``result.json``. See ``AKM_ARM_NAME`` for what merges if it does not.
        """
        return (
            AKM_ACCUMULATING_ARM_NAME
            if self._shared_bundle_path
            else AKM_ARM_NAME
        )

    @override
    def to_agent_info(self) -> AgentInfo:
        """Report ``arm_name()`` as ``AgentInfo.name``.

        ``AgentInfo`` is the only agent identity that reaches
        ``result.json``, so this is the single point where the static and
        accumulating arms become distinguishable to Harbor, to the viewer,
        and to every downstream consumer. Everything else about the
        inherited ``to_agent_info()`` (version, model info, the
        ``MODEL_CONNECTION``-aware provider resolution) is left untouched.
        """
        info = super().to_agent_info()
        info.name = self.arm_name()
        return info

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
            # arm_name(), not name(): the trajectory must agree with
            # result.json's agent_info about which ARM produced it.
            trajectory.agent.name = self.arm_name()
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
        # The seed library precondition only applies to the static (per-trial
        # seeded) arm. The accumulating arm skips seeding entirely -- see the
        # class docstring -- so requiring this fixture would be an unrelated
        # dependency that has nothing to do with whether that arm can run.
        if self._shared_bundle_path is None and not self._seed_library_dir.is_dir():
            raise RuntimeError(
                f"akm seed library not found at {self._seed_library_dir}. "
                "It ships alongside this module at harbor/seed-library; pass "
                "seed_library_dir=<path> if it lives elsewhere."
            )
        if (
            self._shared_bundle_path is None
            and self._stash_root is not None
            and not self._stash_root.is_dir()
        ):
            raise RuntimeError(
                f"akm stash root not found at {self._stash_root}. It must be a "
                "directory with one subdirectory per stash. Pass "
                "stash_root=<path> pointing at a directory that exists, or "
                "omit the kwarg to use the plain seed-library default."
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

        if self._shared_bundle_path is None:
            # 5. Upload the seed library. docker cp requires the destination
            #    directory to exist, and lands files root-owned, hence the
            #    mkdir before and the chown after.
            await self.exec_as_root(
                environment, command=f"mkdir -p {shlex.quote(AKM_SEED_DIR)}"
            )
            await environment.upload_dir(self._seed_library_dir, AKM_SEED_DIR)
            await self.exec_as_root(
                environment,
                command=f"chown -R {owner} {shlex.quote(AKM_SEED_DIR)}",
            )
            # Same answer-key invariant as the stash root (see 5b): the seed
            # library is uploaded verbatim into the TREATMENT arm only, and
            # its root-level files are benchmark meta-commentary -- the
            # treatment library's README literally lists the SWE-bench repo
            # names its contamination policy forbids. The seed step copies
            # only type SUBDIRECTORIES into the bundle, so purging root-level
            # non-directories loses nothing the bundle uses while closing the
            # browse-the-filesystem side channel.
            await self.exec_as_root(
                environment,
                command=(
                    f"find {shlex.quote(AKM_SEED_DIR)} "
                    "-mindepth 1 -maxdepth 1 ! -type d -exec rm -f {} +"
                ),
            )

            # 5b. Upload the stash root, once, if configured. Selection among
            #     its subdirectories happens container-side, in
            #     _build_seed_bundle_command() -> _build_stash_select_command().
            if self._stash_root is not None:
                await self.exec_as_root(
                    environment,
                    command=f"mkdir -p {shlex.quote(AKM_STASH_ROOT_DIR)}",
                )
                await environment.upload_dir(self._stash_root, AKM_STASH_ROOT_DIR)
                await self.exec_as_root(
                    environment,
                    command=f"chown -R {owner} {shlex.quote(AKM_STASH_ROOT_DIR)}",
                )
                # Defense in depth against answer-key leakage: the stash root
                # is uploaded verbatim, and ONLY the treatment arm receives it.
                # Any file sitting at the root of harbor/stashes/ (a README, a
                # gold-ref map, conversion notes) would therefore be readable
                # by the akm arm and not the baseline -- an arm-asymmetric
                # information channel that can name gold refs or abstention
                # answers. Repo hygiene keeps metadata in harbor/stashes-meta/
                # (see its README), and this purge guarantees the invariant
                # in-container even if a stray file lands at the root later.
                # Stash CONTENT (files inside <root>/<stash>/) is untouched.
                await self.exec_as_root(
                    environment,
                    command=(
                        f"find {shlex.quote(AKM_STASH_ROOT_DIR)} "
                        "-mindepth 1 -maxdepth 1 ! -type d -exec rm -f {} +"
                    ),
                )

            # 6. Scaffold, seed and index the bundle. All local and
            #    deterministic: no LLM, no network, no TTY.
            await self.exec_as_agent(
                environment,
                command=self._build_seed_bundle_command(),
                env=self._install_env,
            )
        else:
            # 6'. The accumulating arm (decision D7). No upload, no scaffold,
            #     no seed copy -- AKM_BUNDLE_DIR (set in __init__) already
            #     points every exec at the shared, mounted bundle, which the
            #     job's own setup is responsible for having pre-populated.
            #     The only thing this agent still owns is making sure THIS
            #     container's akm has an index of it at least once. See the
            #     class docstring's "accumulating arm" section.
            #
            #     Wrapped in the shared flock: Harbor's per-agent
            #     `n_concurrent` gates ONLY the agent.run() phase
            #     (AGENT_START/AGENT_END), never agent.setup()/install() --
            #     verified against `trial/queue.py` and `trial/trial.py`. A
            #     job-level `n_concurrent_trials > 1` therefore lets multiple
            #     accumulating-arm trials run install() concurrently even
            #     with `n_concurrent: 1` set on this arm in the job config,
            #     racing `akm index` (and, in the self-check below, `akm
            #     feedback`) against the SAME shared, mounted bundle -- the
            #     exact interleaving corruption `n_concurrent: 1` is supposed
            #     to prevent. `flock` on a lock file INSIDE the shared mount
            #     (host-backed, so it serializes across containers, not just
            #     within one) closes that gap at the shell level regardless
            #     of what `n_concurrent_trials` is set to.
            await self.exec_as_agent(
                environment,
                command=self._wrap_shared_lock(self._build_shared_bundle_index_command()),
                env=self._install_env,
            )

        # 7. Write an npm `overrides` pin for akm-cli into
        #    ~/.config/opencode/package.json, BEFORE opencode ever resolves
        #    the plugin (the warm boot, next step). Verified inert against
        #    opencode 1.18.21's actual plugin-install root -- kept anyway as
        #    zero-cost insurance against the plugin's exec-path candidate 2.
        #    See _build_write_npm_overrides_command()'s docstring for the
        #    full verified/assumed split.
        await self.exec_as_agent(
            environment,
            command=self._build_write_npm_overrides_command(),
            env=self._install_env,
        )

        # 8. Pre-warm both opencode plugin caches while egress is still open.
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

        # 9. Force the akm-cli copy this warm boot just hoisted beside the
        #    plugin back onto the pin. THIS is the step that actually closes
        #    the in-process-import pin-bypass hole (akm_search/show/curate) --
        #    see _build_align_hoisted_akm_cli_command()'s docstring for why
        #    step 7's overrides file cannot.
        await self.exec_as_agent(
            environment,
            command=self._build_align_hoisted_akm_cli_command(),
            env=self._install_env,
        )

        # 10. Fail the trial loudly rather than shipping a half-alive arm. On
        #    the accumulating arm, probes 3-5 (search/curate/feedback -- see
        #    _build_self_check_command) read AND WRITE the shared bundle, so
        #    this exec is flock-wrapped for the same reason step 6' is.
        expectations = (
            derive_seed_expectations(self._seed_library_dir)
            if self._shared_bundle_path is None
            else {}
        )
        # One entry per uploaded stash. The container picks among these with
        # the SAME AKM_TASK_STASH it seeded from, so probe 2 always checks the
        # library that actually landed.
        stash_expectations = (
            {
                child.name: derive_seed_expectations(child)
                for child in sorted(self._stash_root.iterdir())
                if child.is_dir() and not child.name.startswith(".")
            }
            if self._shared_bundle_path is None and self._stash_root is not None
            else {}
        )
        if self._shared_bundle_path is None and not expectations:
            raise RuntimeError(
                f"akm seed library at {self._seed_library_dir} contains no "
                "recognisable asset type directories "
                f"({', '.join(sorted(SEED_TYPE_DIRS))}). Seeding it would "
                "produce a scaffold-only bundle, and the arm would measure "
                "akm with nothing to retrieve."
            )
        self_check_command = self._build_self_check_command()
        if self._shared_bundle_path:
            self_check_command = self._wrap_shared_lock(self_check_command)
        await self.exec_as_agent(
            environment,
            command=self_check_command,
            env={
                **self._install_env,
                # Derived from the seed library THIS instance was configured
                # with, not from the smoke fixture's constant -- see
                # derive_seed_expectations(). The accumulating arm never reads
                # these (it gets the lighter, content-agnostic probe 2), so a
                # missing seed dir on that arm must not raise here.
                "AKM_SEED_EXPECTED_BY_TYPE": json.dumps(expectations),
                # Per-stash expectations, because WHICH library gets seeded is
                # decided container-side from the task's AKM_TASK_STASH (see
                # _build_stash_select_command), not by seed_library_dir. Sending
                # only the library's shape made the probe assert the wrong
                # source for every converted task that names a stash, aborting
                # 100% of those treatment trials at install with a byType
                # mismatch that had nothing to do with the arm's health.
                "AKM_SEED_EXPECTED_BY_STASH": json.dumps(stash_expectations),
                "AKM_SEED_TYPE_DIRS": json.dumps(SEED_DIR_FOR_TYPE),
                "AKM_CLI_VERSION_PREFIX": AKM_CLI_VERSION_PREFIX,
            },
        )

    # -- shell command builders (pure; unit-tested without a container) ------

    def _build_akm_dirs_command(self, quoted_owner: str) -> str:
        """Create (and chown) every akm directory this instance will use.

        The fixed ``/opt/akm/...`` paths are always created, even for the
        accumulating arm (harmless -- just unused by it, since its
        ``AKM_ENV`` overrides point elsewhere). Two cases additionally need a
        directory OUTSIDE ``AKM_ROOT``, which the fixed list can't cover:

        * The accumulating arm redirects ``AKM_DATA_DIR`` / ``STATE_DIR`` /
          ``CACHE_DIR`` / ``CONFIG_DIR`` into the shared, host-backed mount
          alongside ``AKM_BUNDLE_DIR`` (see ``__init__``) -- those four must
          exist there too, or the first ``akm`` invocation in that mount
          fails with ENOENT instead of ever reaching the self-check.
        * An operator-supplied ``akm_bundle_dir`` override (static arm only)
          points ``AKM_BUNDLE_DIR`` somewhere other than the module's
          ``AKM_BUNDLE_DIR`` constant; without creating/chowning THAT path
          too, ``_build_seed_bundle_command()`` (which now targets the same
          override -- see its docstring) fails the same way.
        """
        dirs = [
            AKM_ROOT,
            AKM_BUNDLE_DIR,
            AKM_CONFIG_DIR,
            AKM_DATA_DIR,
            AKM_CACHE_DIR,
            AKM_STATE_DIR,
            AKM_SEED_DIR,
            AKM_STASH_ROOT_DIR,
            INSTALL_XDG_DATA_HOME,
            INSTALL_XDG_STATE_HOME,
        ]
        if self._shared_bundle_path:
            extra_owned = [
                d
                for d in (
                    self._akm_env["AKM_DATA_DIR"],
                    self._akm_env["AKM_STATE_DIR"],
                    self._akm_env["AKM_CACHE_DIR"],
                    self._akm_env["AKM_CONFIG_DIR"],
                )
                if d not in dirs
            ]
        elif self._akm_env["AKM_BUNDLE_DIR"] != AKM_BUNDLE_DIR:
            extra_owned = [self._akm_env["AKM_BUNDLE_DIR"]]
        else:
            extra_owned = []

        all_dirs = " ".join(shlex.quote(d) for d in (*dirs, *extra_owned))
        chown_extra = (
            f" && chown -R {quoted_owner} " + " ".join(shlex.quote(d) for d in extra_owned)
            if extra_owned
            else ""
        )
        return (
            "set -euo pipefail; "
            f"install -d -m 0755 {all_dirs} && "
            f"chown -R {quoted_owner} {shlex.quote(AKM_ROOT)}"
            f"{chown_extra}"
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
        #
        # Refuse to `ln -sf` OVER a pre-existing non-symlink at either target
        # path first. `ln -sf` force-replaces whatever is already there with
        # no check, and nothing upstream of this guarantees the task image
        # doesn't already ship a real binary at /usr/local/bin/node (the
        # standard nodejs base-image location for a pinned toolchain version).
        # Silently repointing it to this arm's nvm-installed Node would
        # change which Node runtime the agent runs under -- a confound on
        # this arm ONLY, not the control arm, which never touches this path.
        # A pre-existing SYMLINK is fine to replace (idempotent across a
        # retried setup); only a real file or directory is refused.
        akm = shlex.quote(akm_bin)
        node = shlex.quote(node_bin)
        # Guarded with an explicit `if`, not a bare `&&` chain: under
        # `set -e`, a standalone `[ -e "$x" ] && [ ! -L "$x" ] && fail` list
        # would itself exit non-zero (and abort the whole script) the moment
        # `[ -e "$x" ]` is false -- which is the NORMAL case on a fresh
        # container, since neither target exists yet before the ln -sf
        # below. `if ... ; then ... ; fi` is the construct `set -e` actually
        # exempts from that trap.
        guard = (
            'for _akm_bench_target in /usr/local/bin/akm /usr/local/bin/node; do '
            'if [ -e "$_akm_bench_target" ] && [ ! -L "$_akm_bench_target" ]; then '
            'echo "AKM-BOOTSTRAP FATAL: $_akm_bench_target already exists and '
            'is not a symlink -- refusing to overwrite it. The task image '
            'likely ships its own toolchain there (a pinned Node runtime is '
            'the common case for /usr/local/bin/node); force-replacing it '
            'would change which runtime the agent runs under on this arm '
            'ONLY, which is exactly the kind of treatment-only confound '
            'AKM_ENV deliberately avoids for PATH. Use a base image that '
            'does not pre-populate /usr/local/bin/{akm,node}." >&2; exit 1; '
            "fi; done; "
        )
        return (
            "set -euo pipefail; "
            "install -d -m 0755 /usr/local/bin && "
            + guard
            + f"ln -sf {akm} /usr/local/bin/akm && "
            f"ln -sf {node} /usr/local/bin/node && "
            "test -x /usr/local/bin/akm && test -x /usr/local/bin/node"
        )

    @staticmethod
    def _build_stash_select_command(seed_dir: str, stash_root_dir: str) -> str:
        """Resolve ``AKM_SEED_SRC`` container-side, from ``AKM_TASK_STASH``.

        This is the akm-bench half of the cross-workflow contract: a
        converted task names its stash by setting ``AKM_TASK_STASH`` via
        ``[environment] env`` in its ``task.toml`` (the corpus workflow's
        half). Selection is deliberately done HERE, at bundle-seed time
        inside the container, rather than in Python at install time, because
        the whole stash root is uploaded exactly ONCE and Harbor's task env
        vars are only visible container-side.

        Three cases, and only three:

        * ``AKM_TASK_STASH`` unset (or empty) -> ``AKM_SEED_SRC`` stays
          ``seed_dir``, i.e. the plain default. This is the common case for
          any task that does not opt into a stash.
        * ``AKM_TASK_STASH=<name>`` and ``<stash_root_dir>/<name>`` exists ->
          ``AKM_SEED_SRC`` becomes that directory.
        * ``AKM_TASK_STASH=<name>`` and ``<stash_root_dir>/<name>`` does NOT
          exist -> loud setup failure. Falling back to ``seed_dir`` here
          would silently seed the WRONG library for the task under test,
          which is worse than not running the trial at all — the contract
          explicitly forbids it.

        ``<name>`` must be a plain directory name, checked in two steps
        before it is ever pasted into a path:

        1. Reject any value containing ``/`` (``../seed``, ``/etc``,
           ``a/b``) — the shell ``case`` pattern ``*/*`` matches a ``/``
           anywhere in the string, so this already catches every traversal
           attempt that contains one, including ``../seed``.
        2. Reject any value that does NOT start with an alphanumeric
           character. This is the case ``*/*`` cannot catch: ``.`` and
           ``..`` contain no ``/`` at all, yet ``[ -d "$root/." ]`` resolves
           to the stash root itself (silently merging every stash together
           when the seed loop below iterates its subdirectories) and
           ``[ -d "$root/.." ]`` resolves to the stash root's PARENT — inside
           ``AKM_ROOT``, whose subtree is `bundle/`, `config/`, `data/`,
           `state/`, `cache/`, `seed/`, `stashes/` (copying `bundle/` and
           friends into the target bundle right alongside the intended
           content). Both are real directories that exist, so the `[ -d ]`
           test alone cannot reject them — hence the separate check.

        The contract is "a stash IN the uploaded root, or a loud failure",
        and both of the above are directories that are emphatically not (or
        not only) the named stash — so without these two guards, the case
        the contract calls out as forbidden (silently seeding something
        other than the named stash) is reachable through a traversing or
        dot-only name.

        Pure string building, parameterized on the real directories so it can
        be unit-tested against a real bash and real tmp directories, since a
        purely textual assertion cannot prove the ``[ -d ... ]`` branch
        actually resolves the right thing.
        """
        seed = shlex.quote(seed_dir)
        stash_dir = shlex.quote(stash_root_dir)
        return (
            f"AKM_SEED_SRC={seed}; "
            'AKM_TASK_STASH_NAME="$(printenv AKM_TASK_STASH || true)"; '
            'if [ -n "$AKM_TASK_STASH_NAME" ]; then '
            'case "$AKM_TASK_STASH_NAME" in */*) '
            'echo "AKM-BOOTSTRAP FATAL: AKM_TASK_STASH=$AKM_TASK_STASH_NAME '
            'is not a plain stash name (it contains a /); a stash must be a '
            f'direct subdirectory of {stash_dir}" >&2; exit 1 ;; esac; '
            'case "$AKM_TASK_STASH_NAME" in '
            '[A-Za-z0-9]*) ;; '
            '*) echo "AKM-BOOTSTRAP FATAL: AKM_TASK_STASH=$AKM_TASK_STASH_NAME '
            'is not a plain stash name (must start with a letter or digit -- '
            'this rejects \\".\\", \\"..\\" and hidden-style names, which are '
            f'real directories under {stash_dir} but are not a named stash)" '
            '>&2; exit 1 ;; esac; '
            f'AKM_STASH_CANDIDATE={stash_dir}/"$AKM_TASK_STASH_NAME"; '
            'if [ -d "$AKM_STASH_CANDIDATE" ]; then '
            'AKM_SEED_SRC="$AKM_STASH_CANDIDATE"; else '
            'echo "AKM-BOOTSTRAP FATAL: AKM_TASK_STASH=$AKM_TASK_STASH_NAME '
            f'not found under {stash_dir} (uploaded stash_root); refusing to '
            'silently fall back to the default seed library -- that would '
            'seed the wrong library for this task and corrupt this arm" >&2; '
            'exit 1; fi; fi'
        )

    def _build_seed_bundle_command(self) -> str:
        # `self._akm_env["AKM_BUNDLE_DIR"]`, NOT the module constant: the
        # `akm_bundle_dir` kwarg (static arm only -- the accumulating arm
        # always wins that override, see __init__) points every exec's
        # AKM_BUNDLE_DIR at the override, so the bundle actually SEEDED here
        # must be the same path or the self-check's `bundleDir !== want`
        # probe fails every trial with a config the operator explicitly
        # asked for. Byte-identical to the module constant when no override
        # was given.
        bundle = shlex.quote(self._akm_env["AKM_BUNDLE_DIR"])
        seed = shlex.quote(AKM_SEED_DIR)
        if self._stash_root is None:
            # No stash root configured for this instance: byte-identical to
            # the pre-stash-selection command, seeding from AKM_SEED_DIR
            # directly with no container-side branching at all.
            select_prefix = ""
            seed_source = seed
        else:
            select_prefix = (
                self._build_stash_select_command(AKM_SEED_DIR, AKM_STASH_ROOT_DIR)
                + "; "
            )
            seed_source = '"$AKM_SEED_SRC"'
        return (
            "set -euo pipefail; "
            "[ -f ~/.nvm/nvm.sh ] && . ~/.nvm/nvm.sh; "
            + select_prefix +
            # `akm setup` is never used: it hard-fails on a non-TTY without
            # --yes. `bundle create` is the low-level primitive. --set-default
            # is REQUIRED; without it a --dir with an existing default is
            # scaffolded but the default pointer is left untouched.
            f"akm bundle create --dir {bundle} --set-default && "
            # Copy only the type SUBDIRECTORIES, which both preserves the 0.9
            # layout by merging into the scaffolded dirs and skips the seed's
            # own README.md at the root (which akm would otherwise not index,
            # but which has no business in a bundle).
            f'for d in {seed_source}/*/; do [ -d "$d" ] || continue; '
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

    def _wrap_shared_lock(self, command: str) -> str:
        """Serialize ``command`` against every OTHER trial's setup phase that
        touches this accumulating arm's shared bundle, via ``flock`` on a
        lock file INSIDE the shared, host-backed mount.

        Only meaningful (and only ever called) when ``self._shared_bundle_path``
        is set. The lock file lives at ``<shared_bundle_path>/.akm-bench-setup.lock``
        rather than somewhere container-local specifically because it must be
        visible to and shared by every trial's container, and the mounted
        bundle directory is the one path guaranteed to be backed by the SAME
        host file across all of them (see the class docstring's "a job-level
        mount" requirement). ``flock -c '<command>'`` acquires the lock,
        forks a shell to run ``<command>``, waits for it, and releases the
        lock -- so this wraps one shell invocation per call, not the whole
        install() phase; call it around each shared-bundle-touching exec
        individually rather than once around all of them, since Harbor
        issues install()'s steps as separate execs.

        If the base image lacks ``flock`` (util-linux), this fails loudly
        with "command not found" rather than silently running unserialized
        -- consistent with every other precondition in this module.
        """
        assert self._shared_bundle_path is not None
        lock_path = f"{self._shared_bundle_path.rstrip('/') or '/'}/.akm-bench-setup.lock"
        return f"flock {shlex.quote(lock_path)} -c {shlex.quote(command)}"

    @staticmethod
    def _build_shared_bundle_index_command() -> str:
        """The accumulating arm's entire "seeding" step: index, maybe.

        No ``bundle create``, no seed copy -- the mounted directory at
        ``AKM_BUNDLE_DIR`` (set to ``shared_bundle_path`` in ``__init__``,
        which every ``exec_as_agent`` call carries automatically) must
        already be a valid, populated akm bundle; see the class docstring.
        This command's only job is to make sure THIS container's akm has an
        index of it, without redundantly rebuilding one that another trial
        already built -- an unconditional ``akm index --full`` on every trial
        would still be correct, but wastefully re-embeds the same content
        every single trial as the bundle grows.

        Since ``__init__`` now redirects ``AKM_DATA_DIR`` into the same
        shared, host-backed mount as ``AKM_BUNDLE_DIR``, ``akm info``'s
        ``indexStats.entryCount`` here reflects the REAL persisted index
        across trials -- not a fresh, always-empty container-local one -- so
        the skip branch below can actually fire once another trial has
        already indexed the bundle.

        Also asserts the accumulating-arm half of the cross-workflow stash
        contract: a converted task naming a per-task stash via
        ``AKM_TASK_STASH`` has no effect on this arm at all (there is one
        shared bundle for every task, by construction -- see the class
        docstring), so running such a task here would silently measure it
        against whatever the shared bundle happens to contain instead of
        the stash it declared. Fail loudly rather than let that pass
        unnoticed, the same "loud failure over silent corruption" contract
        ``_build_stash_select_command`` enforces for the static arm.
        """
        has_index_js = (
            'const fs=require("fs");'
            "let n=0;"
            'try{const i=JSON.parse(fs.readFileSync("/tmp/akm-shared-info.json","utf8"));'
            'n=(i.indexStats||{}).entryCount||0;}catch(e){n=0;}'
            'process.stdout.write(n>0?"1":"0");'
        )
        return (
            "set -euo pipefail; "
            "[ -f ~/.nvm/nvm.sh ] && . ~/.nvm/nvm.sh; "
            'AKM_TASK_STASH_NAME="$(printenv AKM_TASK_STASH || true)"; '
            'if [ -n "$AKM_TASK_STASH_NAME" ]; then '
            'echo "AKM-BOOTSTRAP FATAL: AKM_TASK_STASH=$AKM_TASK_STASH_NAME is '
            'set on this task, but the akm-accumulating arm uses ONE shared '
            'bundle for every task in the job and has no per-task stash '
            'selection -- silently ignoring the requested stash would measure '
            'this trial against whatever the shared bundle happens to contain '
            'instead of the stash the task declared, which is worse than not '
            'running the trial at all. Either drop this task from the '
            'akm-accumulating arm dataset, or remove AKM_TASK_STASH from its '
            'task.toml [environment] env." >&2; exit 1; fi; '
            "akm info --format json -q > /tmp/akm-shared-info.json 2>/dev/null "
            "|| true; "
            f"HAS_INDEX=\"$(node -e '{has_index_js}')\"; "
            'if [ "$HAS_INDEX" != "1" ]; then akm index; fi'
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

    def _build_write_npm_overrides_command(self) -> str:
        """Write an npm ``overrides`` pin for akm-cli into
        ``~/.config/opencode/package.json``, before opencode ever resolves
        the plugin.

        **npm overrides semantics -- VERIFIED, empirically.** ``overrides``
        constrains transitive dependency versions for any ``npm install``
        whose PROJECT ROOT is the directory holding that ``package.json``.
        Confirmed with a real, live install against the published
        akm-opencode tarball: a fresh
        ``npm install akm-opencode@0.9.1202608242057`` run in a directory
        pre-seeded with ``{"overrides": {"akm-cli": "0.9.0"}}`` installed
        ``akm-cli@0.9.0`` into that directory's ``node_modules`` -- where the
        identical install with no overrides file resolves
        ``akm-cli@0.9.1`` (the natural "latest satisfying the plugin's
        `^0.9.0`"). A THIRD run confirmed the isolation this method's
        placement depends on: the same overrides file written into an
        UNRELATED directory has zero effect on an install that happens in a
        different directory -- it too resolves ``akm-cli@0.9.1``, exactly
        like the no-overrides control.

        **Where opencode 1.18.21 actually installs plugins -- VERIFIED,
        against its own source, not memory.** Every npm install opencode
        performs -- the automatic one at session start that resolves this
        agent's forced ``plugin: ["akm-opencode@<pin>"]`` entry
        (``@opencode-ai/core`` ``packages/opencode/src/plugin/shared.ts``
        ``resolvePluginTarget()`` -> ``Npm.add()``), AND the manual
        ``opencode plugin <mod> --global`` CLI command (``cli/cmd/plug.ts``
        ``createPlugTask()`` -> the same ``installPlugin()`` ->
        ``resolvePluginTarget()`` -> ``Npm.add()``) -- is rooted at
        ``$HOME/.cache/opencode/packages/<sanitize(spec)>/``
        (``@opencode-ai/core`` ``packages/core/src/npm.ts``: ``directory =
        path.join(global.cache, "packages", sanitize(pkg))``; ``sanitize()``
        is a no-op on non-Windows). ``--global`` on ``opencode plugin`` only
        changes where the plugin's CONFIG-FILE entry is patched
        (``opencode.json``), never where its npm dependencies land.

        **``~/.config/opencode`` IS an npm project root -- VERIFIED, and the
        opposite of what an earlier revision of this docstring asserted.**
        ``ConfigPaths.directories()``
        (``packages/opencode/src/config/paths.ts``) returns
        ``Global.Path.config`` as its FIRST element, and
        ``packages/opencode/src/config/config.ts:439`` calls
        ``npmSvc.install(dir, {add: [{name: "@opencode-ai/plugin", ...}]})``
        for every directory it returns (``config/tui.ts:238`` does the same
        on the TUI path). That directory-scoped ``Npm.install()`` reifies
        with Arborist rooted at ``dir``, so it reads ``dir/package.json`` --
        ``overrides`` field included -- as the project manifest. This is what
        creates ``~/.config/opencode/node_modules``, whose existence
        self-check probe 6 already asserts and which
        ``_build_warm_caches_command()``'s docstring correctly describes.

        **Conclusion -- still INERT today, but for a narrower reason than
        "nothing installs there".** The only package opencode installs into
        that root is ``@opencode-ai/plugin``, which does not depend on
        ``akm-cli`` -- so an ``akm-cli`` override has nothing to bind to, and
        ``~/.config/opencode/node_modules/akm-cli`` stays absent (the case
        probes 7b and 7c treat as healthy). Neither CLI-resolution candidate
        that matters for opencode 1.18.21 +
        akm-opencode@<AKM_PLUGIN_VERSION> is reached by it: the "bundled"
        candidate the in-process ``akm_search``/``akm_show``/``akm_curate``
        tools import from is protected instead by
        ``_build_align_hoisted_akm_cli_command()``, and the "path" candidate
        our own ``/usr/local/bin/akm`` symlink satisfies.

        **Writing it is safe -- VERIFIED against that installer's own logic.**
        ``Npm.install()`` reifies only when ``node_modules`` is absent, or
        when a manifest-declared dep is missing from ``package-lock.json``;
        in both paths ``add`` still carries ``@opencode-ai/plugin``, and
        Arborist runs with ``save: true``, so it writes that dependency back
        into the ``package.json`` written here rather than being pruned away
        by its empty ``dependencies``. Running BEFORE the warm boot is what
        keeps this an initial manifest rather than a clobber of one opencode
        has already populated -- an ordering
        ``test_overrides_are_written_before_the_warm_boot`` pins.

        **Why write it anyway -- ASSUMED, not verified, forward-looking
        insurance.** The shipped plugin's own CLI-resolution order
        (``getPathAkmCandidates()``, read out of the real
        akm-opencode@<AKM_PLUGIN_VERSION> tarball's ``index.ts``) checks
        ``${XDG_CONFIG_HOME:-~/.config}/opencode/node_modules/.bin/akm``
        BEFORE the bare ``akm`` on PATH -- i.e. before our pin. Nothing in
        opencode 1.18.21 or in this agent's own install() populates that
        directory today (self-check probe 7c below will find it absent and
        pass), but the plugin author clearly built resolution logic
        anticipating SOME mechanism populating it (a user's own
        ``npm install --prefix ~/.config/opencode akm-cli``, or a future
        opencode version that does root a plugin-adjacent install there).
        Pre-seeding the override is zero-cost and harmless either way: IF
        that directory is ever populated by anything that respects npm
        `overrides` semantics, this is what keeps the version pinned rather
        than floating to whatever ``^0.9.0`` naturally resolves to at that
        moment. Self-check probes 7b and 7c both already fail the trial
        loudly if that directory exists and disagrees with the pin; this
        turns "exists and disagrees" from a detected failure into a
        structurally unreachable one, for any installer that honors
        overrides.

        Idempotent and side-effect-free: this only writes a file, creates no
        ``node_modules``, and runs no install of its own.
        """
        payload = json.dumps(
            {
                "name": "akm-bench-opencode-config-overrides",
                "private": True,
                "dependencies": {},
                "overrides": {"akm-cli": AKM_CLI_VERSION},
            }
        )
        return (
            "set -euo pipefail; "
            "install -d -m 0755 ~/.config/opencode && "
            f"echo {shlex.quote(payload)} > ~/.config/opencode/package.json"
        )

    def _build_align_hoisted_akm_cli_command(self) -> str:
        """Force the akm-cli copy hoisted beside the plugin onto the pin.

        **This is the fix that actually closes the in-process-import hole.**
        Verified, out of the real akm-opencode@<AKM_PLUGIN_VERSION> tarball's
        ``index.ts``: ``akm_search``/``akm_show``/``akm_curate`` resolve
        akm-cli through ``runInProcess()``'s bare
        ``import("akm-cli/dist/commands/...")`` specifier. Node/Bun module
        resolution for a bare specifier walks UP from the importing module's
        own location through ITS ``node_modules`` chain -- landing on
        exactly what ``getBundledAkmCommand()`` also targets:
        ``<pluginPackageDir>/node_modules/akm-cli``, where
        ``pluginPackageDir`` sits under
        ``$HOME/.cache/opencode/packages/<AKM_PLUGIN_SPEC>/`` -- the tree
        opencode's own ``Npm.add()`` creates the first time the plugin is
        resolved (this agent's warm boot, the install step immediately
        before this one). No ``overrides`` field written anywhere else, and
        no PATH pin, reaches that ``import()`` -- see
        ``_build_write_npm_overrides_command()``'s docstring for the
        verification that rules those out.

        **Verified empirically that realigning it is safe and surgical.**
        Against a real, previously-installed akm-opencode@<pin> tree (fetched
        from the live npm registry) with its natural ``akm-cli@0.9.1``
        already hoisted: running ``npm install --prefix <that tree>
        akm-cli@<other-version> --ignore-scripts --no-save`` flipped
        ``node_modules/akm-cli``'s version to the requested one, left
        ``node_modules/akm-opencode`` itself untouched, and (``--no-save``)
        left the tree's ``package.json`` byte-identical -- a targeted
        in-place version swap of exactly the one package, not a
        re-resolution of the whole tree.

        ``--ignore-scripts`` matches how opencode's own ``Npm.add()``
        installs the plugin (``new Arborist({..., ignoreScripts: true})`` in
        ``packages/core/src/npm.ts``), so this does not newly run a
        postinstall (e.g. a native ``better-sqlite3`` build) that opencode's
        own install of the SAME package would not itself have run --
        no asymmetry beyond the version pin.

        Runs AFTER the warm boot -- nothing exists here before opencode's
        first plugin resolution -- and BEFORE the self-check. Only actually
        reinstalls when the hoisted version disagrees with the pin; the
        common case, where npm's own ``^0.9.0`` resolution already landed on
        the pin, costs one ``find`` and one ``node -p`` and nothing else.
        Absent is left to self-check probe 7, which already fails the trial
        with a more specific message ("no akm-cli hoisted beside the
        plugin") than anything duplicated here.

        **Enumerates every match, not just the first.** An earlier revision
        used ``find ... -print -quit`` (first match wins) on the theory that
        exactly one ``.../node_modules/akm-cli`` tree exists under
        ``$HOME/.cache/opencode`` for this agent's single forced plugin. That
        is true for the resolution root this method verified against (see
        above), but ``find``'s traversal order is otherwise unspecified, and
        nothing rules out a second, unrelated hoisted copy (a stale cache
        entry from a prior plugin version, a nested
        ``node_modules/<pkg>/node_modules/akm-cli``) coexisting on disk. A
        ``-quit`` on an arbitrary one of those would realign whichever one
        ``find`` happened to visit first and leave any other unpinned and
        unchecked -- silently reintroducing the exact drift this method
        exists to close. Realigning every match found is strictly safer than
        that and only costs one extra ``node -p`` per additional copy, which
        is never more than a handful.
        """
        pin = shlex.quote(AKM_CLI_VERSION)
        return (
            "set -euo pipefail; "
            "[ -f ~/.nvm/nvm.sh ] && . ~/.nvm/nvm.sh; "
            'AKM_HOISTED_PKGS="$(find "$HOME/.cache/opencode" -path '
            "'*/node_modules/akm-cli/package.json' "
            '2>/dev/null || true)"; '
            'if [ -z "$AKM_HOISTED_PKGS" ]; then '
            'echo "akm-bootstrap: no hoisted akm-cli yet to realign; the '
            'self-check will fail the trial if this is still true after '
            'it"; exit 0; fi; '
            'echo "$AKM_HOISTED_PKGS" | while IFS= read -r AKM_HOISTED_PKG; do '
            '[ -n "$AKM_HOISTED_PKG" ] || continue; '
            'AKM_HOISTED_VER="$(node -p "require(process.argv[1]).version" '
            '"$AKM_HOISTED_PKG")"; '
            f'if [ "$AKM_HOISTED_VER" = {pin} ]; then '
            f'echo "akm-bootstrap: hoisted akm-cli at $AKM_HOISTED_PKG '
            f'already at the pin ({AKM_CLI_VERSION})"; continue; fi; '
            'AKM_HOISTED_ROOT="${AKM_HOISTED_PKG%/node_modules/akm-cli/package.json}"; '
            f'echo "akm-bootstrap: hoisted akm-cli at $AKM_HOISTED_PKG is '
            f'$AKM_HOISTED_VER, pin is {AKM_CLI_VERSION} -- realigning '
            f'$AKM_HOISTED_ROOT"; '
            f'npm install --prefix "$AKM_HOISTED_ROOT" akm-cli@{pin} '
            "--ignore-scripts --no-audit --no-fund --no-save; "
            'AKM_REALIGNED_VER="$(node -p '
            '"require(process.argv[1]).version" "$AKM_HOISTED_PKG")"; '
            f'[ "$AKM_REALIGNED_VER" = {pin} ] || {{ echo '
            f'"AKM-BOOTSTRAP FATAL: realignment of hoisted akm-cli at '
            f'$AKM_HOISTED_PKG to {AKM_CLI_VERSION} did not take (still '
            f'$AKM_REALIGNED_VER)" 1>&2; exit 1; }}; '
            "done"
        )

    def _build_self_check_command(self) -> str:
        """Assert the bootstrap actually took. Any failure aborts the trial.

        Every JS fragment below is single-quote-free so it can be embedded in a
        single-quoted ``node -e`` argument.

        Probe 2 (the seed-count assertions, ``info_js`` below) runs its FULL
        per-type form only for the static per-trial-seeded arm.
        ``AKM_SEED_EXPECTED_BY_TYPE`` / ``AKM_SEED_MIN_ENTRIES`` are DERIVED
        by ``derive_seed_expectations()`` from the seed library this instance
        was actually configured with (not from the smoke fixture's constant),
        so a job that seeds ``harbor/treatment-library/`` is checked against
        that library's shape; the accumulating arm
        (``shared_bundle_path`` set) never writes it -- it only indexes a
        bundle the job's own setup is responsible for pre-populating (see
        the class docstring) -- so asserting those per-type counts would
        fail every accumulating-arm trial for a reason that has nothing to
        do with whether the plugin works. It still gets a LIGHTER form of
        the same probe (``info_js_accumulating`` below): ``bundleDir``
        resolved to the shared mount, and a non-empty index. Both are
        arm-agnostic facts (unlike the per-type counts, they don't depend on
        what the shared bundle happens to contain) and both were previously
        skipped entirely, which meant the single most consequential question
        for this arm -- did ``AKM_BUNDLE_DIR`` actually resolve to the
        mounted path, and is there anything indexed at all -- went
        unverified until probes 3-5 failed with an error that named the
        wrong cause (an empty knowledge/ enumeration, not "the mount is
        empty or misconfigured"). Every OTHER probe -- akm on PATH (1, 1b),
        the read/rank/mutate paths (3, 4, 5), the plugin cache (6),
        CLI-version skew (7), the pin-bypass hole (7b, 7c), and the run-phase
        log line (8) -- still gates this arm exactly as it gates the static
        one. The only content coupling left anywhere in this method is probe
        3's ``knowledge/`` prefix enumeration returning >=4 entries; probe 5
        now mutates whatever ref THAT enumeration returned first, so it no
        longer names a fixture asset and works against any pre-populated
        shared bundle. Both A/B job configs accordingly suggest
        pre-populating the mount from ``harbor/treatment-library/`` (decision
        D6), not from the smoke fixture.
        """
        # Resolve WHICH seed source this trial actually got, using the same
        # AKM_TASK_STASH the seed step used, and write its expected shape to
        # /tmp/akm-seed-want.json for the probes below. Deriving this
        # host-side from seed_library_dir was wrong: a converted task that
        # names a stash is seeded from that stash, whose shape is unrelated to
        # the library. Prints the DIRECTORY the enumeration probe should use,
        # captured by command substitution -- a bare lowercase name, so it
        # needs no quoting games on the shell side.
        select_js = (
            "const fs=require(\"fs\");"
            "const stash=(process.env.AKM_TASK_STASH||\"\").trim();"
            "const dflt=JSON.parse(process.env.AKM_SEED_EXPECTED_BY_TYPE||\"{}\");"
            "const byStash=JSON.parse("
            "process.env.AKM_SEED_EXPECTED_BY_STASH||\"{}\");"
            "let want=dflt;"
            "if(stash){"
            "if(!Object.prototype.hasOwnProperty.call(byStash,stash))"
            "throw new Error(\"no seed expectations were recorded for "
            "AKM_TASK_STASH=\"+stash+\"; the uploaded stash root has no such "
            "directory\");"
            "want=byStash[stash];}"
            "const types=Object.keys(want);"
            "if(!types.length)throw new Error(\"the selected seed source ships "
            "no recognisable asset type directories\");"
            "types.sort((a,b)=>(want[b]-want[a])||a.localeCompare(b));"
            "const probeType=types[0];"
            "const dirs=JSON.parse(process.env.AKM_SEED_TYPE_DIRS||\"{}\");"
            "const probeDir=dirs[probeType];"
            "if(!probeDir)throw new Error(\"no bundle directory known for asset "
            "type \"+probeType);"
            "const min=types.reduce((a,k)=>a+want[k],0);"
            # probeMin is capped at 4 on purpose: the enumeration probe should
            # be as strong as the content allows and never stronger. The old
            # hardcoded >=4 aborted every trial of a stash with fewer than
            # four knowledge assets -- drillbit and inkwell ship none at all.
            "const probeMin=Math.min(want[probeType],4);"
            "fs.writeFileSync(\"/tmp/akm-seed-want.json\",JSON.stringify("
            "{byType:want,minEntries:min,probeDir:probeDir,probeMin:probeMin}));"
            "process.stdout.write(probeDir);"
        )
        info_js = (
            "const fs=require(\"fs\");"
            "const i=JSON.parse(fs.readFileSync(\"/tmp/akm-info.json\",\"utf8\"));"
            "const want=process.env.AKM_BUNDLE_DIR;"
            "if(i.bundleDir!==want)throw new Error(\"bundleDir=\"+i.bundleDir+"
            "\" want=\"+want);"
            "if(!i.defaultBundle)throw new Error(\"no defaultBundle configured\");"
            "const stats=i.indexStats||{};"
            "const seed=JSON.parse(fs.readFileSync("
            "\"/tmp/akm-seed-want.json\",\"utf8\"));"
            "const min=seed.minEntries;"
            "const n=stats.entryCount;"
            "if(!(n>=min))throw new Error(\"indexStats.entryCount=\"+n+\" (<\"+min+"
            "\"; ~12 means only the scaffold indexed and the seed did not land)\");"
            "const byType=stats.byType||{};"
            "const wantByType=seed.byType;"
            "for(const k of Object.keys(wantByType)){"
            "if((byType[k]||0)<wantByType[k])throw new Error(\"byType.\"+k+\"=\"+"
            "(byType[k]||0)+\" want>=\"+wantByType[k]);}"
            "console.log(\"akm info OK: entries=\"+n+\" bundle=\"+i.bundleDir);"
        )
        # The accumulating arm's lighter probe 2: bundleDir resolved to the
        # shared mount, and SOMETHING is indexed. No defaultBundle check
        # (this agent never runs `bundle create --set-default` for this arm
        # -- see the class docstring) and no per-type counts (the shared
        # bundle's content is the job setup's responsibility, not a fixture
        # this agent controls the shape of).
        info_js_accumulating = (
            "const fs=require(\"fs\");"
            "const i=JSON.parse(fs.readFileSync(\"/tmp/akm-info.json\",\"utf8\"));"
            "const want=process.env.AKM_BUNDLE_DIR;"
            "if(i.bundleDir!==want)throw new Error(\"bundleDir=\"+i.bundleDir+"
            "\" want=\"+want+\" -- AKM_BUNDLE_DIR did not resolve to the shared "
            "mount\");"
            "const stats=i.indexStats||{};"
            "const n=stats.entryCount;"
            "if(!(n>0))throw new Error(\"indexStats.entryCount=\"+n+\" (want >0); "
            "the shared bundle must be pre-populated and indexed before the "
            "first trial runs -- see the accumulating-arm operational "
            "requirements in the AkmOpenCode class docstring\");"
            "console.log(\"akm info OK (accumulating): entries=\"+n+\" bundle=\"+"
            "i.bundleDir);"
        )
        # FTS does NOT stem: `akm search "deploy"` returns zero hits against
        # deployment-runbook. Health checks must use prefix enumeration.
        search_js = (
            "const fs=require(\"fs\");"
            "const h=JSON.parse(fs.readFileSync(\"/tmp/akm-search.json\",\"utf8\"))"
            ".hits||[];"
            "const seed=JSON.parse(fs.readFileSync("
            "\"/tmp/akm-seed-want.json\",\"utf8\"));"
            "if(h.length<seed.probeMin)throw new Error(seed.probeDir+\"/ "
            "enumeration returned \"+h.length+\" hits, want >=\"+seed.probeMin);"
        )
        # The accumulating arm never runs the selection preamble (it seeds
        # nothing, so there is no /tmp/akm-seed-want.json to read) and keeps
        # the arm-agnostic fixed floor it always had.
        search_js_accumulating = (
            "const fs=require(\"fs\");"
            "const h=JSON.parse(fs.readFileSync(\"/tmp/akm-search.json\",\"utf8\"))"
            ".hits||[];"
            "if(h.length<4)throw new Error(\"knowledge/ enumeration returned \"+"
            "h.length+\" hits, want >=4\");"
        )
        # The ranking probe's query is DERIVED from the bundle that actually
        # landed, for the same reason probe 3's directory is: a fixed English
        # phrase is a content assumption. `how do I debug a failing test`
        # returns 0 items against the docker-homelab and drillbit stashes
        # (measured with real akm 0.9.1), which would abort every trial of
        # those tasks for a reason unrelated to the arm's health. akm's FTS is
        # conjunctive AND over name/description/tags/headings, so the enumerated
        # asset's own name is the one query guaranteed to have a match.
        curate_query_js = (
            "const fs=require(\"fs\");"
            "const h=JSON.parse(fs.readFileSync(\"/tmp/akm-search.json\",\"utf8\"))"
            ".hits||[];"
            "const r=(h[0]||{}).ref;"
            "if(!r)throw new Error(\"no ref in the seed enumeration\");"
            "const name=r.split(\"/\").pop().replace(/[-_]+/g,\" \").trim();"
            "if(!name)throw new Error(\"could not derive a curate query from \"+r);"
            "process.stdout.write(name);"
        )
        curate_js = (
            "const fs=require(\"fs\");"
            "const it=JSON.parse(fs.readFileSync(\"/tmp/akm-curate.json\",\"utf8\"))"
            ".items||[];"
            "if(!it.length)throw new Error(\"curate returned 0 items\");"
        )
        # Probe 5 mutates a ref that must actually EXIST in the seeded bundle.
        # Taking it from probe 3's own enumeration (hits[0].ref, verified
        # present in `akm search --format json -q` output) instead of naming a
        # fixture asset keeps this probe working for ANY seed library -- the
        # hardcoded `knowledge/deployment-runbook` exists only in the smoke
        # fixture, so it failed with ASSET_NOT_FOUND (exit 1) against the D6
        # treatment library both job configs actually seed.
        feedback_ref_js = (
            "const fs=require(\"fs\");"
            "const h=JSON.parse(fs.readFileSync(\"/tmp/akm-search.json\",\"utf8\"))"
            ".hits||[];"
            "const r=(h[0]||{}).ref;"
            "if(!r)throw new Error(\"no ref in the knowledge/ enumeration\");"
            "process.stdout.write(r);"
        )
        # Checks EVERY hoisted akm-cli copy found under $HOME/.cache/opencode,
        # not just one -- `find` traversal order is unspecified, and a second,
        # unrelated hoisted copy (a stale cache entry, a nested
        # node_modules/<pkg>/node_modules/akm-cli) coexisting on disk must not
        # be able to pass this probe unchecked just because it wasn't the one
        # an arbitrary first-match picked. AKM_HOISTED_PKGS is newline-
        # separated paths from `find` (no -print -quit -- see
        # _build_align_hoisted_akm_cli_command()'s docstring for the same
        # reasoning applied there).
        skew_js = (
            "const paths=(process.env.AKM_HOISTED_PKGS||\"\").split(\"\\n\")"
            ".map(s=>s.trim()).filter(Boolean);"
            "const global_=process.env.AKM_GLOBAL_VERSION;"
            "for(const p of paths){"
            "const hoisted=require(p).version;"
            "if(hoisted!==global_)throw new Error(\"akm-cli skew: in-process(\"+"
            "p+\")=\"+hoisted+\" global=\"+global_);"
            "}"
            "console.log(\"akm-cli versions agree: \"+global_+\" (\"+paths.length+"
            "\" hoisted copy\"+(paths.length===1?\"\":\"ies\")+\")\");"
        )
        # 2) config, bundle and index agree, and the seed landed. The
        #    accumulating arm gets the lighter `info_js_accumulating` form
        #    instead -- see the docstring above.
        active_info_js = info_js if self._shared_bundle_path is None else info_js_accumulating
        if self._shared_bundle_path is None:
            # 2′) resolve the seed shape THIS trial was actually given, using
            #     the same AKM_TASK_STASH the seed step selected with.
            seed_shape_probe = (
                "AKM_SEED_PROBE_DIR=\"$(node -e '" + select_js + "')\" || "
                'fail "could not resolve the expected seed shape (see '
                'AKM_TASK_STASH and the uploaded stash root)"; '
            )
            enumeration_probe = (
                'akm search "$AKM_SEED_PROBE_DIR/" --format json -q '
                '> /tmp/akm-search.json || fail "akm search failed"; '
                f"node -e '{search_js}' || "
                'fail "akm search prefix enumeration failed"; '
            )
        else:
            seed_shape_probe = ""
            enumeration_probe = (
                f"akm search {shlex.quote('knowledge/')} --format json -q "
                '> /tmp/akm-search.json || fail "akm search failed"; '
                f"node -e '{search_js_accumulating}' || "
                'fail "akm search prefix enumeration failed"; '
            )
        seed_count_probe = (
            "akm info --format json -q > /tmp/akm-info.json || "
            'fail "akm info failed"; '
            f"node -e '{active_info_js}' || fail \"akm info assertions failed\"; "
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
            + seed_shape_probe
            + seed_count_probe
            # 3) read path. Which directory, and how many hits are required,
            #    follow the seed source this trial actually got.
            + enumeration_probe
            # 4) ranking path, with no LLM configured. The query is DERIVED
            #    from probe 3's first hit (see curate_query_js), so it matches
            #    something in whatever bundle this trial actually got. A fixed
            #    English phrase cannot: the previous `how do I debug a failing
            #    test` returns 0 items against the docker-homelab and drillbit
            #    stashes, and the one before it was written for the smoke
            #    fixture's deployment-runbook asset.
            + "AKM_CURATE_QUERY=\"$(node -e '" + curate_query_js + "')\" || "
            'fail "could not derive a curate query from the seed enumeration"; '
            'akm curate "$AKM_CURATE_QUERY" '
            "--limit 3 --format json -q > /tmp/akm-curate.json || "
            'fail "akm curate failed"; '
            f"node -e '{curate_js}' || fail \"akm curate returned nothing\"; "
            # 5) mutating CLI path — what akm_feedback / akm_remember shell out
            #    to. The ref comes from probe 3's enumeration of THIS bundle, so
            #    it exists by construction whatever the seed library is.
            "AKM_FEEDBACK_REF=\"$(node -e '"
            + feedback_ref_js
            + "')\" || fail \"could not pick a ref to send feedback on\"; "
            'akm feedback "$AKM_FEEDBACK_REF" '
            '--positive -q >/dev/null || fail "akm feedback failed on '
            '$AKM_FEEDBACK_REF"; '
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
            'AKM_HOISTED_PKGS="$(find "$HOME/.cache/opencode" -path '
            "'*/node_modules/akm-cli/package.json' "
            '2>/dev/null || true)"; '
            '[ -n "$AKM_HOISTED_PKGS" ] || fail "no akm-cli hoisted beside the '
            'plugin; the in-process tools will fail to import"; '
            "export AKM_HOISTED_PKGS; "
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
            # 7c) same directory as 7b, but reads the PACKAGE version directly
            #     instead of shelling out to node_modules/.bin/akm --version --
            #     catches a package present with no working bin shim (e.g.
            #     installed with --no-bin-links, or dropped in by hand) that
            #     7b's `-x "$CFG_AKM"` guard would silently step over. Historical
            #     note, not a claim about today's resolution: this directory is
            #     the plugin's EXEC-path candidate 2
            #     (getPathAkmCandidates()), the same one 7b covers -- it is NOT
            #     the root the in-process akm_search/show/curate tools import
            #     from. That one is
            #     $HOME/.cache/opencode/packages/.../node_modules/akm-cli,
            #     forced onto the pin by install()'s own
            #     _build_align_hoisted_akm_cli_command() step, immediately
            #     before this self-check runs -- see that method's docstring
            #     for the verified/assumed split behind this comment. Absent is
            #     fine here too, for the same reason 7b treats it as fine.
            #     Note the precise claim: opencode 1.18.21 DOES npm-install
            #     into ~/.config/opencode (ConfigPaths.directories() lists it
            #     first; config.ts:439 installs into every entry -- that is
            #     what probe 6's node_modules assertion relies on), but the
            #     only package it puts there is @opencode-ai/plugin, which has
            #     no akm-cli dependency. So this akm-cli path specifically
            #     stays absent, and absence is the expected case, not evidence
            #     of anything wrong.
            'CFG_AKM_PKG="$HOME/.config/opencode/node_modules/akm-cli/'
            'package.json"; '
            'if [ -f "$CFG_AKM_PKG" ]; then '
            'CFG_PKG_VER="$(node -p "require(process.argv[1]).version" '
            '"$CFG_AKM_PKG" 2>/dev/null || true)"; '
            f'[ "$CFG_PKG_VER" = "{AKM_CLI_VERSION}" ] || fail "akm-cli pin '
            f'bypass (package.json): $CFG_AKM_PKG reports '
            f'${{CFG_PKG_VER:-unknown}}, pin is {AKM_CLI_VERSION}"; '
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
