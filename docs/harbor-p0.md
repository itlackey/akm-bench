# Harbor P0: running akm-opencode against stock opencode

**Status: never executed live.** Everything below was derived by reading Harbor
v0.22.0's source, opencode 1.18.21's published SDK types, and the shipped
`akm-opencode` tarball, then verified as far as it can be without a Docker
daemon (see [What has and has not been verified](#not-verified--this-is-the-honest-list)).
No containerised run has happened yet. Treat the first execution as a debugging
session, not as a measurement.

This runbook covers the P0 milestone only:

> Prove that a Harbor custom agent can run opencode **with the akm-opencode
> plugin enabled** inside a benchmark task container, and that the model
> actually calls `akm_*` tools in there.

P0 is a plumbing check. It is explicitly **not** evidence that akm improves task
performance. It does not touch the legacy Bun harness in `src/`.

## What was added

| Path | What it is |
|---|---|
| `harbor/akm_opencode.py` | The custom agent, `AkmOpenCode(OpenCode)`. Version pins live here as module constants. |
| `harbor/__init__.py` | A shim that keeps this `harbor/` directory from breaking the installed Harbor. Read the note below before you `export PYTHONPATH`. |
| `harbor/seed-library/` | A 15-asset akm bundle in the 0.9 layout, uploaded into the container at install time. Smoke fixture only. |
| `harbor/jobs/p0-smoke.yaml` | Both arms, one task, one job. |
| `harbor/tests/test_akm_opencode.py` | Unit tests. No Docker, no network. |

## Prerequisites

1. **A running Docker daemon.** `docker ps` must succeed. The P0 job uses
   `environment.type: docker`; Harbor builds a task image and runs one container
   per trial.
2. **uv**, then Harbor:
   ```sh
   uv tool install harbor
   harbor --version     # expect 0.22.x; this was written against 0.22.0
   ```
   The PyPI distribution is named `harbor` (`Name: harbor`, `Version: 0.22.0`
   in the installed `METADATA`). Upstream source:
   <https://github.com/harbor-framework/harbor>.
3. **A model API key** in the environment. Harbor's OpenCode agent declares
   `ModelConnectionSpec(passthrough=True)`, so provider variables reach the
   container under their own names — `ANTHROPIC_API_KEY` for
   `anthropic/...`, `OPENAI_API_KEY` for `openai/...`, and so on.
4. **Egress to `registry.npmjs.org`** from the container. Both arms npm-install
   during agent **setup**; the treatment arm pulls ~432MB of akm CLI
   (`better-sqlite3` and friends). Separately, opencode installs plugins at
   **session start** — inside the measured agent phase — so a cold plugin cache
   would refetch there. Install step 7 pre-warms that cache precisely so it does
   not. Those are two different phases under two different network policies;
   read
   [Network policy: what `extra_allowed_hosts` does and does not do](#network-policy-what-extra_allowed_hosts-does-and-does-not-do)
   before assuming one flag covers both.
5. **A glibc task image.** The treatment arm asserts Node ≥ 22 at install and
   aborts otherwise. See [musl / Alpine is out of scope](#musl--alpine-is-out-of-scope).
6. **A task dataset.** The quickest is Harbor's own examples:
   ```sh
   git clone https://github.com/harbor-framework/harbor /path/to/harbor
   ls /path/to/harbor/examples/tasks/hello-world
   ```

### The PYTHONPATH trap — read this one

Harbor resolves `--agent module.path:ClassName` with a plain
`importlib.import_module`. There is no `sys.path` manipulation and no file-path
support, so `harbor.akm_opencode` only resolves when this repository's root is
importable — normally `PYTHONPATH="$(pwd)"`.

But this package is *named* `harbor`, and `PYTHONPATH` is searched **before**
site-packages. So the repo directory shadows the installed Harbor distribution.
With a plain empty `__init__.py` the very first import blows up:

```
ModuleNotFoundError: No module named 'harbor.agents'
AttributeError: module 'harbor' has no attribute '__version__'
```

`harbor/__init__.py` fixes this with `pkgutil.extend_path` (so Harbor's own
submodules stay reachable through this package) plus a module-level
`__getattr__` that forwards to the installed distribution's top level (so
`harbor.__version__`, `harbor.JobConfig` and the rest keep working). Verified:
with `PYTHONPATH` set, `harbor --help` still runs and `harbor.__version__`
still reports `0.22.0`.

Two consequences:

- Always run from the repo root. `PYTHONPATH="$(pwd)"`, not a relative path
  from elsewhere.
- If you ever move this package to a different top-level name, drop the shim
  and update `import_path` in the job config.

## Running both arms

Edit `harbor/jobs/p0-smoke.yaml` first. Two placeholders:

1. `model_name:` — appears **twice**, once per arm. They must match exactly.
2. `datasets[0].path` — absolute path to a task directory.

> `-m/--model` on the command line will **not** fill these in. Harbor only
> applies `-m` when `--agent` is also passed, and `--agent` *replaces the entire
> agents list* from the config file — which would drop one of your two arms.
> Edit the YAML.

Then:

```sh
cd /path/to/akm-bench
export ANTHROPIC_API_KEY=...            # or your provider's variable
PYTHONPATH="$(pwd)" harbor run -c harbor/jobs/p0-smoke.yaml
```

The treatment arm's setup is long: opencode-ai, then `npm i -g akm-cli`
(~432MB), then bundle seed + index, then a full opencode boot to warm the plugin
caches, then the self-check. The job config sets two timeout overrides, both
**identically on both arms** so the phase budgets match:

- `override_setup_timeout_sec: 2700` — Harbor's default agent-setup timeout is
  360s and the treatment arm will not finish in that. The control arm simply
  finishes early.
- `override_timeout_sec: 1800` — the *agent-phase* budget. Without it the
  budget comes from the task's `[agent] timeout_sec`, which is **120s** for
  Harbor's `hello-world`. The treatment arm has to share that 120s with plugin
  session-start work (plugin fetch, CLI resolution, ~4–5s of blocked event loop
  before the first token) that the control arm never pays, so a treatment-only
  `AgentTimeoutError` would read as "akm failed the task".

### Running one arm at a time

Useful while debugging. These are **not** a valid A/B against each other unless
the control arm carries exactly the config block the job file gives it — so
generate it from the job file rather than retyping it. Retyping is how the two
arms drift, and how invalid keys creep in (opencode's `permission` map accepts
only five keys; see [Config symmetry](#config-symmetry-what-actually-differs)).

Note the flags: a **local** task directory is `-p/--path` (`-d/--dataset` is a
registry `name@version`), task filtering is `-i/--include-task-name`, and the
setup timeout is expressed as a **multiplier** over Harbor's 360s base —
`7.5` gives the 2700s the job config sets directly. All four are present in
`harbor run --help` on 0.22.0.

```sh
# treatment
PYTHONPATH="$(pwd)" harbor run \
  -p /path/to/harbor/examples/tasks -i hello-world \
  --agent harbor.akm_opencode:AkmOpenCode \
  -m anthropic/claude-sonnet-4-5 \
  --ak version=1.18.21 \
  --allow-agent-host registry.npmjs.org \
  --agent-setup-timeout-multiplier 7.5

# control — lift the config out of the job file so it cannot drift from the
# arm you are comparing against. Harbor's parse_kwargs() json.loads() each
# --ak value, so a compact JSON blob is the right shape here.
CTRL_CONFIG=$(python -c "
import json, pathlib, yaml
cfg = yaml.safe_load(pathlib.Path('harbor/jobs/p0-smoke.yaml').read_text())
print(json.dumps(cfg['agents'][0]['kwargs']['opencode_config'], separators=(',', ':')))
")
harbor run \
  -p /path/to/harbor/examples/tasks -i hello-world \
  --agent opencode -m anthropic/claude-sonnet-4-5 \
  --ak version=1.18.21 \
  --ak "opencode_config=$CTRL_CONFIG" \
  --allow-agent-host registry.npmjs.org \
  --agent-setup-timeout-multiplier 7.5
```

### Checking the config without running anything

`--print-config` resolves the job config and exits without touching Docker:

```sh
PYTHONPATH="$(pwd)" harbor run -c harbor/jobs/p0-smoke.yaml --print-config
```

Use it after editing the placeholders to confirm both arms survived, both carry
the same `model_name`, and the dataset path resolved.

## Confirming P0: did the model call `akm_*`?

Trials land in `jobs/akm-p0-smoke/<task>/<trial>/`. Read the checks in order:
**step 0 gates the meaning of every later step.**

### 0. Did the plugin actually load? (read this before anything else)

The plugin's failure path is warn-only. `ensureSupportedAkmResolved()` runs when
the plugin factory is invoked; if it cannot find a compatible akm CLI it writes
one WARN line (`AKM CLI resolution failed`), returns, and the session
**continues** — the `akm_*` tools stay registered and every call degrades. And
if opencode fails to install or import the plugin package at all, there is no
plugin, no hooks and no tools, with no non-zero exit either.

Both of those produce a green trial with **zero `akm_*` calls**, which is
byte-for-byte identical to "the model chose not to use akm". Do not read zero
calls as a model choice until you have ruled out the other two.

`AkmOpenCode.populate_context_post_run()` now makes this a hard failure rather
than a judgement call: it greps the run-phase opencode log for the plugin's
`AKM CLI resolved` line and raises `AkmPluginNotLoadedError` when the line is
absent, when `AKM CLI resolution failed` is present, or when the log itself is
missing. Such a trial is recorded with `exception_info` and no reward instead
of being scored.

Check it yourself:

```sh
# The exception type, if the run-phase proof tripped:
jq -r '"\(input_filename)  \(.exception_info.exception_type // "none")"' \
  jobs/akm-p0-smoke/*/*/result.json

# The log the proof reads (treatment arm):
grep -h "AKM CLI resolved\|AKM CLI resolution failed" \
  jobs/akm-p0-smoke/*/*/agent/opencode/xdg-data/opencode/log/*.log
```

> **This check needs the run-phase opencode log, so neither arm carries an
> `exclude_logs` entry.** An `opencode/xdg-data/**` exclude cannot be rescued
> by an include — Harbor applies `exclude_logs` *after* `include_logs`
> (`harbor/utils/path_filter.py`), so exclude always wins. On **Docker** the
> point is moot: `Trial._download_agent_logs()` short-circuits to
> `prepare_logs_for_host()` whenever `capabilities.mounted` is true (it is, for
> Docker), and the filters never run at all. On any **non-mounted / cloud**
> environment the filter does run, the log is deleted, and every treatment
> trial aborts with "no readable opencode log". If you hit that error off
> Docker, an exclude pattern is the first thing to look at. The cost of keeping
> the logs is bigger trial directories — the right trade against an arm that
> cannot be verified.

An independent, plugin-side confirmation is the event log (step 4 below): the
plugin writes a `session_started` record on `session.created` before it does
anything else, so one `session_started` line for the measured session is direct
proof the plugin's hooks were live in that run.

### 1. The arm is labelled correctly

```sh
jq -r '"\(input_filename)  \(.agent_info.name)  \(.agent_info.version)"' \
  jobs/akm-p0-smoke/*/*/result.json
```

Expect exactly two distinct names:

```
opencode      1.18.21
akm-opencode  1.18.21+akm-opencode@0.9.202808220049
```

If both say `opencode`, the arms collapsed into one and every downstream
statistic is meaningless. `AgentInfo.name` comes from the agent's `name()`
static method, which `AkmOpenCode` overrides for exactly this reason.

### 2. Raw tool calls in the opencode stream

`<trial>/agent/opencode.txt` is the JSON-lines stream from
`opencode run --format=json`. Harbor's `run()` merges stderr into it
(`2>&1 ... | stdbuf -oL tee /logs/agent/opencode.txt`), so the file is *mostly*
JSON lines, not entirely — parse defensively. A plugin tool call is a
`tool_use` event whose `part.tool` is the tool name:

```json
{"type":"tool_use","part":{"type":"tool","tool":"akm_search","callID":"...","state":{"input":{},"output":"..."}}}
```

Quick census (`fromjson?` drops the non-JSON lines instead of aborting):

```sh
jq -rR 'fromjson? | select(.type=="tool_use") | .part.tool' \
  jobs/akm-p0-smoke/*/*/agent/opencode.txt | grep '^akm_' | sort | uniq -c
```

A plain `grep -o '"tool":"akm_[a-z]*"'` over the same file also works and is
fine for a quick look; it just depends on opencode's compact serialisation.

**This is the P0 pass/fail.** Any `akm_search`, `akm_show`, `akm_curate`,
`akm_feedback` or `akm_remember` in the treatment arm's file, and zero in the
control arm's, means P0 passed — *given* that step 0 came back clean.

### 3. ATIF trajectory

```sh
jq -r '[.steps[].tool_calls[]?.function_name] | map(select(startswith("akm_"))) | unique' \
  jobs/akm-p0-smoke/*/*/agent/trajectory.json
```

`Step.tool_calls` is `list[ToolCall] | None`, which is why the `[]?` is there:
without it a step with `"tool_calls": null` aborts the program.

`trajectory.json` also carries `.agent.name`, which `AkmOpenCode` relabels —
stock `OpenCode` hardcodes `Agent(name="opencode")` there regardless of
subclass, so without the override this file would mislabel the arm even when
`result.json` is right.

### 4. The plugin's own telemetry

Harbor sets `XDG_STATE_HOME=/logs/agent/opencode/xdg-state` during the run, and
the plugin resolves its event log to
`$XDG_STATE_HOME/akm-opencode/events.jsonl`
(`shared/memory-events.ts: getEventLogPath("opencode")`), so it is collected
for free.

First, the plugin-was-live probe — `session_started` is written unconditionally
on `session.created`/`session.updated`, before any akm work:

```sh
jq -r 'select(.event=="session_started")
       | "\(.timestamp)  \(.sessionId)  \(.input.type)"' \
  jobs/akm-p0-smoke/*/*/agent/opencode/xdg-state/akm-opencode/events.jsonl
```

Then the akm tool traffic:

```sh
jq -r 'select(((.input.tool // .input.toolName) // "") | startswith("akm_"))
       | "\(.event)  \(.input.tool // .input.toolName)  \(.outcome.status)"' \
  jobs/akm-p0-smoke/*/*/agent/opencode/xdg-state/akm-opencode/events.jsonl
```

Expect lines like `tool_observation  akm_search  ok` and
`workflow_step  akm_curate  ok`. A whole-file census is often more informative
than a filter:

```sh
jq -r '.event' \
  jobs/akm-p0-smoke/*/*/agent/opencode/xdg-state/akm-opencode/events.jsonl \
  | sort | uniq -c
```

#### The real event shapes — filters that look right and match nothing

- **`.event` is a closed union.** `shared/memory-events.ts` declares exactly
  eleven values: `session_started`, `prompt_recall`, `tool_observation`,
  `tool_batch_observation`, `tool_ref_observed`, `workflow_step`,
  `task_created`, `task_completed`, `subagent_started`,
  `post_compact_summary`, `feedback_recorded`. **No value ever begins with
  `akm.`**, so `select(.event | startswith("akm."))` matches zero lines whether
  or not the plugin ran — a silent false negative.
- **`.outcome` is an object**, `{"status": "ok"|"skipped"|"blocked"|"failed"}`,
  never the string `"success"`. Comparing `.outcome == "success"` matches
  nothing. (The literal string `"success"` *does* occur, but at
  `.input.outcome` on `workflow_step` records — a different field.)
- **The akm tool name lives in two places** depending on the event:
  `.input.tool` on `tool_observation` / `tool_ref_observed`, and
  `.input.toolName` on `workflow_step`. Hence the `//` fallback above.
- **`tool_observation` is akm-only.** The `tool.execute.after` hook returns
  early for non-akm tools (`if (!isAkmTool) return`), so a `bash` or `read`
  call produces at most a `tool_ref_observed` record (and only when the output
  contained a resolvable asset ref). Do not expect a per-tool audit trail of
  the whole session here.
- **`workflow_step` covers the in-process tools only.** `akm_search`,
  `akm_curate` and `akm_show` emit `akm.<op>.invoked` telemetry through
  `emitWorkflowTelemetry()`. The session-start `curate` and `hints` legs go
  through `runCliSyncBestEffort()`, which writes **no** structured event on
  success — so their absence from `events.jsonl` is not evidence they did not
  run.

The dotted `akm.search.invoked` / `akm.curate.invoked` / `akm.show.invoked`
strings do exist, but only as `client.app.log()` messages, so they land in
opencode's own log under `$XDG_DATA_HOME/opencode/log/*.log` — the same log
step 0's run-phase proof reads. Grep it for `"service":"akm-opencode"`.

**Never exclude `xdg-state`** — that would delete the `events.jsonl` evidence
above — and, per step 0, **do not exclude `xdg-data` on either arm**, because
the run-phase proof reads the log that lives there. Neither arm in
`p0-smoke.yaml` carries an `exclude_logs` entry today; keep it that way.

## Config symmetry: what actually differs

`~/.config/opencode/opencode.json` lives inside the container and is rewritten
on every run, so it is not in the trial directory. Reproduce both arms on the
host:

```sh
PYTHONPATH="$(pwd)" python -c "
import json, pathlib, re, shlex, yaml
from harbor.akm_opencode import AkmOpenCode
from harbor.agents.installed.opencode import OpenCode

M = 'anthropic/claude-sonnet-4-5'
ctrl = yaml.safe_load(pathlib.Path('harbor/jobs/p0-smoke.yaml').read_text())['agents'][0]['kwargs']

def render(agent):
    cmd = agent._build_register_config_command()
    body = re.search(r'echo (.*) > ~/\.config/opencode/opencode\.json', cmd, re.S).group(1)
    return json.loads(shlex.split(body)[0])

t = render(AkmOpenCode(logs_dir=pathlib.Path('/tmp/t'), model_name=M))
c = render(OpenCode(logs_dir=pathlib.Path('/tmp/c'), model_name=M,
                    version=ctrl['version'], opencode_config=ctrl['opencode_config']))
print('treatment key order:', list(t))
print('control   key order:', list(c))
print('keys only in treatment:', sorted(set(t) - set(c)))
print('shared keys that differ:', sorted(k for k in set(t) & set(c) if t[k] != c[k]))
"
```

The two rendered files are **not byte-identical**, and claiming they are would
paper over two real differences and one cosmetic one. They differ in exactly
three ways:

1. **`plugin`** — present on the treatment arm only, as
   `["akm-opencode@<AKM_PLUGIN_VERSION>"]`. This is the treatment.
2. **`tools`** — present on the treatment arm only, enabling the five plugin
   tools (`akm_search`, `akm_show`, `akm_curate`, `akm_feedback`,
   `akm_remember`). This is the schema-supported lever for per-tool
   enablement: `Config.tools?: {[key: string]: boolean}` at
   `@opencode-ai/sdk@1.18.21` `dist/gen/types.gen.d.ts:1170-1173`. Unlisted
   tools keep their defaults, so this enables the akm surface without
   disabling a single built-in. Also intended.
3. **Top-level key order.** Treatment renders
   `$schema, autoupdate, provider, permission, tools, plugin`; control renders
   `provider, $schema, autoupdate, permission`. This is an artefact of
   `OpenCode._build_register_config_command()`'s merge order (defaults →
   auto-generated `provider` → job overrides) meeting two different
   `_DEFAULT_CONFIG`s, and it is semantically irrelevant — JSON objects are
   unordered. It does mean **`diff` on the raw files is the wrong check**; use
   `jq -S .` on both, or the script above.

Everything else is equal: `$schema`, `autoupdate`, the whole `provider` block
including `baseURL`, and the `permission` map. That symmetry is the experiment.

Two things about `permission` worth stating plainly, because both were wrong in
earlier drafts of this runbook:

- **`Config.permission` declares exactly five keys**, each
  `"ask" | "allow" | "deny"` (`bash` additionally accepts a per-pattern map):
  `edit`, `bash`, `webfetch`, `doom_loop`, `external_directory`
  (`types.gen.d.ts:1161-1169`). There is **no** `read`/`write`/`grep`/`glob`/
  `list`/`patch`/`todowrite`/`todoread` key, and no per-plugin-tool key. An
  invented key is not a stricter setting — it is config opencode does not
  implement. If the rendered config still shows five `akm_*` keys nested inside
  `permission`, the agent is out of date with this document; those belong in
  `tools`.
- **The `permission` block is inert today.** Harbor's `OpenCode.run()` passes
  `--dangerously-skip-permissions` on the opencode command line, so nothing in
  that map gates tool execution in the measured run. It is belt-and-braces
  against a Harbor upgrade that drops the flag — and precisely *because* it is
  belt-and-braces, it must stay byte-identical on both arms. Braces on one arm
  only would entangle "plugin present" with "permissions granted".

## Known asymmetries between the arms

The two arms are not identical containers with one flag flipped. This is the
complete list of what differs, in rough order of how much it could distort a
result. Two of these are the treatment; the rest are cost or confound.

| # | Asymmetry | Class |
|---|---|---|
| 1 | **Warm vs. cold opencode first boot.** Install step 7 boots a full opencode session on the treatment arm to warm `~/.cache/opencode` and `~/.config/opencode`. The control arm's `install()` ends at `opencode --version`, so its *first real session* — plugin-manager bootstrap, `@opencode-ai/plugin` install, models.dev registry fetch — happens **inside the measured agent phase**. | **Confound, favours treatment** |
| 2 | **~432MB of extra disk** under `/opt/akm` and in the global npm prefix, plus `/usr/local/bin/akm` and `/usr/local/bin/node` symlinks, on the treatment arm only. | Confound (disk-pressure only) |
| 3 | **Extra setup wall-clock** on the treatment arm — npm install, bundle seed, `akm index --full`, the warm boot, the self-check. This is charged to the *setup* phase, not the agent phase, so it does not enter the measurement. | Cost, not validity |
| 4 | **The `AKM_*` environment** (`AKM_BUNDLE_DIR`, `AKM_AUTO_CURATE`, timeouts, `AKM_EVENT_SOURCE`, …) on the treatment process. | **Intended — this is the treatment** |
| 5 | **The `plugin` array and the `tools` map** in `opencode.json`. | **Intended — this is the treatment** |

Three former entries on this list have been removed from the agent (or, for
the second one, closed by editing the job config) and should **not** be
described as present; re-check all three before a run rather than trusting
this paragraph:

- **A hard `PATH` replacement.** `AKM_ENV` used to set
  `PATH=/usr/local/bin:...`. Harbor renders every env entry as
  `docker exec -e KEY=VALUE` and runs a **non-login** `bash -c`, so nothing
  restores the image PATH: that setting *replaced* the image's PATH for the
  measured run, on the treatment arm only. Any task image whose toolchain lives
  elsewhere (a venv, conda, `~/.local/bin`, cargo, go) would have lost it in
  one arm, and `python: not found` would have read as akm making the agent
  worse. `akm` is instead reached through the `/usr/local/bin` symlinks from
  install step 4. Verify with
  `PYTHONPATH="$(pwd)" python -c "from harbor.akm_opencode import AkmOpenCode; print('PATH' in AkmOpenCode.AKM_ENV)"` — expect `False`.
- **Five invalid `akm_*` keys inside `permission`.** See the previous section;
  verify with the render script there and expect `keys only in treatment` to be
  `['plugin', 'tools']`.
- **`OPENCODE_DISABLE_AUTOUPDATE=true` reaching only the treatment arm's
  process env.** `AKM_ENV` sets it there; `p0-smoke.yaml`'s control arm now
  carries the same variable via its own `env:` block (alongside its
  pre-existing `opencode_config.autoupdate: false`), specifically so this is
  no longer two different, possibly-unequal mechanisms on the two arms.
  Verify with `grep -A2 'env:' harbor/jobs/p0-smoke.yaml` and expect
  `OPENCODE_DISABLE_AUTOUPDATE: "true"` under the control arm's block, not
  only the treatment arms'.

If any of these checks comes back the other way, the A/B is confounded and
the run is not valid evidence.

### `models.dev` reachability

If the task image blocks `models.opencode.ai`, opencode logs
`Failed to fetch models.dev` and stalls. Earlier drafts of this runbook said
this "affects both arms equally, so it is not an akm confound." **That is
backwards.** The treatment arm has already paid that cost during `install()`
(asymmetry #1 above), so a slow or blocked models.dev is charged to the control
arm's *measured* phase and to the treatment arm's *setup* phase. It is one of
the clearest ways to get a real-looking but meaningless timing result.

## Network policy: what `extra_allowed_hosts` does and does not do

`--allow-agent-host` / `agents[].extra_allowed_hosts` is weaker than it looks.
Four things to know:

1. **Agent run phase only.** Harbor's own help says so
   ("merged into the agent phase allowlist during `agent.run()` only"), and the
   code agrees: `resolve_agent_phase_policy()` is the only consumer of
   `TrialAgentConfig.extra_allowed_hosts`, and `Trial._run_agent_phase()` wraps
   only `agent.run()` in `_phase_network_policy()`. **It does not cover the
   setup-phase npm installs.** Setup runs under the environment baseline.
2. **On a `public` policy it is silently a no-op.** `merge_extra_allowlists()`
   returns the policy unchanged and emits a `UserWarning`
   ("Run-specific allowlist host(s) … are ignored because the effective network
   policy is public"). Harbor's `hello-world` task sets no `network_mode`, and
   the default is `NetworkMode.PUBLIC` — **so on the P0 smoke task this flag
   does nothing at all**. Its presence in `p0-smoke.yaml` is documentation of
   intent, not an active control.
3. **On a restricted task it needs the Docker egress-control sidecar.** A phase
   policy that differs from the environment baseline requires
   `capabilities.dynamic_network_policy`, which the Docker environment
   advertises only when `_enable_egress_control` is true — which needs a
   non-`public` policy, a Linux container, and a kernel with
   `CONFIG_NFT_FIB_INET`. Harbor then routes services through a
   `harbor-docker-egress-control-sidecar` compose service. If the kernel probe
   fails, the trial raises: "network policy differs from the agent environment
   baseline, but this environment cannot change network policy after start."
4. **From `none` mode it can cut off the model API.** `merge_extra_allowlists()`
   builds `NetworkPolicy(network_mode=ALLOWLIST, allowed_hosts=[*policy.allowed_hosts, *extra])`.
   A `none`-mode baseline has an empty `allowed_hosts`, so adding
   `registry.npmjs.org` converts the agent phase from "no network" to an
   allowlist containing **only** `registry.npmjs.org` — which does not include
   the model API endpoint. The flag intended to unblock the plugin fetch would
   then cut off the provider. On such a task, pass the model host explicitly
   too.

The practical upshot for the treatment arm: opencode installs npm plugins at
**session start**, i.e. during `agent.run()`. That fetch is why the flag is
there. The install-time cache warm (step 7) is the second, independent
mitigation, and on a restricted task it is the one that actually works.

## Reading the result

`result.json` per trial (the filename is `result.json`, singular — the docstring
in Harbor's `TrialPaths` says `results.json` and is stale). `harbor view <folder>`
starts the trajectory browser; the folder argument is required, e.g.
`harbor view jobs`. (`harbor viewer` is not a command in 0.22.0.)

For P0, `reward` is close to noise: it is one task, one attempt, and (for
`hello-world`) a task no knowledge library could help with. Read it as "did the
trial complete", not as a score.

Three failure signatures worth recognising:

- **Setup failed.** Look for `AKM-BOOTSTRAP FATAL: ...` in
  `<trial>/exception.txt` and `<trial>/trial.log`. The install-time self-check
  writes that prefix to **stderr** and every message names the specific
  assertion that failed; `BaseInstalledAgent._classify_exec_error()` folds
  stdout and stderr into the exception detail, so it reaches those files.
  Note the truncation: `_truncate_output()` caps each stream at 1000 chars but
  keeps head *and* tail, and the fatal line is emitted last, so it survives.
  **Do not go looking in `<trial>/agent/setup/`** — Harbor creates that
  directory for every installed agent but only the Cline agent writes into it,
  so for opencode it is empty.
- **Trial errored with `AkmPluginNotLoadedError`.** The run-phase proof tripped.
  The exception message names which of the three cases it was and what to look
  at. See [step 0](#0-did-the-plugin-actually-load-read-this-before-anything-else).
- **Trial ran, zero `akm_*` calls, no exception.** *Now* it is fair to read this
  as the model not choosing to use akm — the run-phase proof has ruled out the
  two impostor explanations. With a one-turn `opencode run` this is a plausible
  outcome even when everything works.

## Known caveats and things that are unverified

### Verified without a container

- Every shell command `install()` builds is valid bash (`bash -n`).
- The full self-check script was executed against a fake `akm` CLI and a fake
  opencode cache with real bash and real Node 22: the success path passes, and
  each of eight failure modes (akm missing from PATH, version prefix mismatch,
  scaffold-only bundle, per-type shortfall, missing plugin cache,
  `AKM CLI resolution failed` in the log, missing log, akm-cli version skew)
  aborts with its own message.
- The seed copy loop was run against the real `harbor/seed-library`: all 15
  assets land, the scaffold's `facts/` survives the merge, `README.md` does not
  leak into the bundle, and `env/`/`secrets/` keep mode 0700.
- `p0-smoke.yaml` validates against Harbor's `JobConfig` with
  `DeprecationWarning` promoted to an error, and both arms construct through
  Harbor's own `AgentFactory` and produce distinct `agent_info.name` values.
- `harbor --help` and `harbor.__version__` still work with the shadowing
  `PYTHONPATH`.
- Every CLI flag and subcommand quoted in this runbook exists in Harbor 0.22.0
  (`harbor run --help`, `harbor view --help`, `harbor --help`).
- Every `jq` program in this runbook was run against synthetic records built
  from the real emitters (`shared/memory-events.ts`,
  `OpenCode._convert_events_to_trajectory`, `TrialResult`).
- The two marker strings the run-phase proof greps for were checked against the
  shipped `akm-opencode@0.9.202808220049` tarball, not against memory:
  `"AKM CLI resolved"` is logged at `info` (`index.ts:1420`) and
  `"AKM CLI resolution failed"` at `warn` (`index.ts:1402`), both through
  `writePluginLog() -> client.app.log({service:"akm-opencode", ...})`, and the
  failure branch `return`s rather than throwing — so the warn-only-and-continue
  behaviour step 0 describes is the shipped behaviour. The same tarball confirms
  the five registered tool names (`akm_search`, `akm_show`, `akm_remember`,
  `akm_feedback`, `akm_curate`), the `akm-cli: "^0.9.0"` dependency and
  `AKM_VERSION_RANGE`, the five-candidate CLI resolution order (with
  `~/.config/opencode/node_modules/.bin/akm` genuinely outranking the PATH pin),
  the eleven-value `AkmMemoryEventType` union, the `outcome: {status}` object,
  `if (!isAkmTool) return`, the ten `gatherCwdContext()` indicator files, and
  `getEventLogPath("opencode")` resolving under `$XDG_STATE_HOME/akm-opencode/`.
- The `permission` and `tools` schema was read out of the actual
  `@opencode-ai/sdk@1.18.21` tarball (`dist/gen/types.gen.d.ts:1161-1169` and
  `1170-1173`), and both arms' rendered `opencode.json` was produced through
  Harbor's own `AgentFactory` and checked to contain zero `akm_*` keys under
  `permission` and only boolean values under `tools`.
- The unit-test suite (`pytest harbor/tests`) runs against a real Harbor
  0.22.0 install with no Docker, no network and no credentials, and is the
  gate for every claim in this section. Run it before you trust any of them.

### Not verified — this is the honest list

- **No container has ever run this.** Docker, npm installs, the nvm/apk branch,
  `akm bundle create`, `akm index`, the opencode warm boot and the plugin
  handshake have not executed together anywhere. Everything above is source
  reading plus host-side simulation.
- **The run-phase proof has never fired for real.** `_assert_plugin_ran()`
  depends on opencode writing `$XDG_DATA_HOME/opencode/log/*.log` during the
  measured run and on Harbor syncing that directory back before
  `populate_context_post_run()`. Both are read from source
  (`Trial._sync_agent_output()` downloads, then populates), not observed.
- **`akm-cli@0.9.1` is pinned globally, but the copy the plugin actually uses
  may not be.** See the next section — this is the sharpest remaining hole.
- **Session-start curation is inert on hello-world and live everywhere else.**
  See [Session-start curation](#session-start-curation-inert-on-the-smoke-task-live-on-real-tasks).
- **akm's FTS does not stem.** `akm search "deploy"` returns zero hits against
  `deployment-runbook`. Expect the model's first search to miss on near-miss
  vocabulary. The self-check uses prefix enumeration (`akm search "knowledge/"`)
  precisely because a keyword probe is not a reliable health check.
- **Latency.** Each plugin → akm CLI call is a synchronous `execFileSync`
  costing ~1.1s cold on the Node launcher, and session start makes about four of
  them — roughly 4–5s of blocked event loop before the first token, plus ~1.1s
  per `akm_feedback` / `akm_remember` call. The agent raises
  `AKM_PENDING_PROPOSAL_TIMEOUT` to 5s and `AKM_CURATE_TIMEOUT` to 15s to
  compensate. The treatment arm is inherently slower; do not read wall-clock as
  a quality signal.
- **The seed library is a smoke fixture.** What the real benchmark library
  should be is an open decision. See `harbor/seed-library/README.md`.
- **Every claim about the akm CLI's own behaviour is source/doc-derived, not
  executed.** `akm-cli` was never installed or run while writing any of this, so
  the following are assumptions the first live run will test, not observations:
  `akm bundle create` scaffolding ~12 `facts/conventions/*` templates (hence the
  "~27 total entries" figure); `akm info --format json` reporting
  `indexStats.byType` under the *singular* type keys
  `knowledge/skill/command/agent/script/lesson` that `SEED_EXPECTED_BY_TYPE`
  asserts against, rather than the plural directory names; `akm setup`
  hard-failing on a non-TTY without `--yes`; `bundle create` leaving the default
  pointer untouched without `--set-default`; `isTransientStashPath()` redirecting
  config and cache for `/tmp`-resident bundles; a query-less `curate` exiting 2
  with `MISSING_REQUIRED_ARGUMENT`; and `npm i -g akm-cli` weighing ~432MB. Each
  of these is asserted by the install-time self-check, so a wrong assumption
  fails **loudly at setup** rather than degrading a trial — but none is proven.
- **Where opencode writes its session log is an assumption about opencode, not a
  fact read out of Harbor.** Harbor's `OpenCode.run()` only exports
  `XDG_DATA_HOME=/logs/agent/opencode/xdg-data`; that opencode then writes
  `$XDG_DATA_HOME/opencode/log/*.log` comes from opencode's own behaviour, and no
  opencode binary was available to confirm it. Both the install-time self-check
  and `_assert_plugin_ran()` grep that layout, so if it is wrong the self-check
  fails during **setup**, before any paid run — but the layout itself is unproven.
  The same applies to the plugin-cache layout claims
  (`~/.cache/opencode/packages/<pin>/`, `@opencode-ai/plugin` installed separately
  under `~/.config/opencode`) and to the "~70s stall on an offline boot" figure.
- **`/usr/local/bin` being on the default PATH of every Harbor base image** is
  asserted, not checked against any image. It is what lets `AKM_ENV` leave `PATH`
  alone. Self-check probe 1b re-tests it inside the container from
  `PATH=/usr/local/bin:/usr/bin:/bin`, so a wrong assumption is again a loud
  setup failure.
- **The plugin's log line reaches the log on a best-effort basis.**
  `writePluginLog()` wraps `client.app.log()` in a bare `try {} catch {}` so a
  logging failure cannot break the TUI. If that call throws during a measured
  run, a *healthy* treatment trial produces no `AKM CLI resolved` line and
  `_assert_plugin_ran()` invalidates it. The proof therefore fails **closed**:
  it can manufacture a false error, never a false green.

### akm-cli pinning has a hole

`install()` pins the **global** CLI: `npm i -g akm-cli@0.9.1`, symlinked to
`/usr/local/bin/akm`. That is not necessarily the CLI the plugin runs.

The plugin resolves its CLI in this order (`getResolvedAkmDetails()` →
`getPathAkmCandidates()`), first compatible candidate wins:

1. `$AKM_LOCAL_BUILD_CLI` — explicit dev override
2. `${XDG_CONFIG_HOME:-~/.config}/opencode/node_modules/.bin/akm`
3. `akm` on `PATH`  ← the pinned global one
4. `$HOME/.local/bin/akm`
5. the copy bundled beside the plugin (`<plugin>/node_modules/akm-cli`)

Candidate 2 outranks the pin. That path is **npm's own independent resolution
of the plugin's `"akm-cli": "^0.9.0"` dependency**, performed when opencode
installs the plugin. The day `akm-cli@0.9.2` ships, npm will happily satisfy
`^0.9.0` with it, and the measured run will exercise an unpinned CLI while
`result.json` still reports the pinned version.

Two more things make this worse than it sounds:

- **There are two akm-cli copies in play, not one.** `akm_feedback`,
  `akm_remember` and the session-start `hints`/`curate` legs shell out through
  the resolution order above. `akm_search`, `akm_show` and `akm_curate` go
  through `runInProcess()`, which is a bare ES import
  (`import { akmSearch } from "akm-cli/dist/commands/read/search.js"`) resolved
  by the module loader from the plugin's own location. Those two can be
  different versions of akm-cli inside one session.
- **Self-check #7 does not cover candidate 2.** It locates
  `*/node_modules/akm-cli/package.json` under `$HOME/.cache/opencode` and
  compares that to `akm --version`. It says nothing about
  `~/.config/opencode/node_modules/.bin/akm`.
- **Self-check #7b now does** (`akm_opencode.py`, probe `7b`). If
  `~/.config/opencode/node_modules/.bin/akm` exists and its `--version` is not
  `AKM_CLI_VERSION`, setup aborts with `akm-cli pin bypass: ...`. Absent is
  fine — resolution then falls through to the pinned `akm` on PATH. This
  converts the one silent-corruption path into a loud setup failure. It still
  runs at install time, not at session start, and it does not cover the
  in-process import path — see mitigation (1).

Mitigations, in order of strength:

1. **npm `overrides`.** Write an `overrides` block pinning `akm-cli` to
   `AKM_CLI_VERSION` into `~/.config/opencode/package.json` before the
   cache-warm boot, so npm's own resolution of `^0.9.0` cannot float. This is
   the only mitigation that also covers the in-process import path.
2. **Extend the skew check** to probe every candidate in the resolution order.
   *Implemented* as probe 7b for candidate 2, the one that outranks the PATH
   pin. Detection, not prevention: it fails the trial rather than making the
   right binary run, so (1) is still the stronger fix.
3. **`AKM_LOCAL_BUILD_CLI=/usr/local/bin/akm`** in `AKM_ENV` wins outright over
   candidates 2–5 — but only for the exec path. The in-process tools ignore it,
   so this is necessary-not-sufficient.

With (2) in place the exec path fails loudly rather than silently drifting, but
until (1) also lands treat the **in-process** tools' akm-cli as unverified
for any run made after a newer 0.9.x ships, and re-warm the plugin cache whenever the
global pin moves.

**As of 2026-08-22 the hole is latent, not active.** The npm registry was
queried directly: `akm-cli` has exactly two stable `0.9.x` releases, `0.9.0` and
`0.9.1`, and `dist-tags.latest` is `0.9.1` — so npm's own resolution of the
plugin's `^0.9.0` today lands on `0.9.1`, which *is* the pin, and candidate 2
agrees with candidate 3. `akm-opencode@0.9.202808220049` and
`opencode-ai@1.18.21` are likewise published and are both their package's
`latest`. This is the one caveat on this page that has a shelf life: re-check it
before every run, because nothing in the agent enforces it.

```sh
curl -s https://registry.npmjs.org/akm-cli \
  | jq -r '[.versions | keys[] | select(startswith("0.9.")) | select(contains("-") | not)], .["dist-tags"].latest'
```

If that prints any stable `0.9.x` newer than `AKM_CLI_VERSION`, the measured run
may exercise an unpinned CLI while `result.json` still reports the pin.

### Session-start curation: inert on the smoke task, live on real tasks

Earlier drafts said the session-start curated-context leg of the treatment
"does not exist". That understates it, and it is wrong for every task that
matters.

What the shipped plugin actually does on `session.created`:

```ts
const cwdContext = gatherCwdContext(directory)
const curated = await runCurateForSession(logClient, sid, cwdContext || undefined)
```

`runCurateForSession()` appends the query only `if (query)`, and akm 0.9.1
rejects a query-less `curate` with `MISSING_REQUIRED_ARGUMENT` (exit 2,
"A curate query is required"). So the leg is inert **exactly when
`gatherCwdContext()` returns an empty string** — which requires the cwd to
contain *none* of ten indicator files (`package.json`, `Cargo.toml`,
`pyproject.toml`, `go.mod`, `Gemfile`, `Makefile`, `Dockerfile`,
`docker-compose.yml`, `.github/workflows`, `composer.json`) **and** no
`README.md` with a non-heading content line in it.

- **On `hello-world` that is true.** Its image is `FROM ubuntu:24.04` with
  `WORKDIR /app` and nothing copied in, so the query is empty and the
  session-start curate is a no-op. For the P0 smoke, what remains is the
  `akm hints` doctrine block, per-prompt `chat.message` curation (which lands on
  the *next* turn — and a one-turn `opencode run` has no next turn), and the
  model choosing to call `akm_*` itself. Budget P0 expectations accordingly.
- **On essentially any real repository task it is non-empty**, because almost
  every repo has at least a README or one build file. There the session-start
  curate fires with a cwd-derived query, and it is a live part of the treatment
  that P0 will not have exercised.

Do not carry the P0 observation forward as "session-start curation is dead". It
is dead on the fixture and alive on the thing you actually want to measure.

### musl / Alpine is out of scope

The treatment arm asserts `node --version` ≥ 22 before `npm i -g akm-cli`
(`MIN_NODE_MAJOR = 22`; `akm-cli`'s preinstall script refuses to install below
that). Harbor's `OpenCode.install()` branches on libc:

```sh
if ldd --version 2>&1 | grep -qi musl || [ -f /etc/alpine-release ]; then
  node --version && npm --version;        # whatever apk installed
else
  <nvm install 22 && nvm alias default 22>
fi
```

The glibc branch installs Node 22 via nvm. The musl branch takes **whatever the
distro ships**, because nvm's official Node binaries do not run on musl and its
source-build fallback fails in task images. Harbor's `nodejs` PackageSpec maps
to a bare `apk add nodejs` with no version constraint, and shipping Alpine
releases have been below the floor (3.19 ships Node 20). So an Alpine-based task
image reaches the assertion under-version and aborts:

```
AKM-BOOTSTRAP FATAL: node 20 < 22; akm-cli preinstall will refuse to install
```

That is a **loud** failure at install time, not a silent degradation, which is
the right behaviour. But it means **musl/Alpine task images are out of scope for
the treatment arm as it stands.** The control arm has no such floor and will run
fine, so a mixed dataset would quietly become control-only on its Alpine tasks.
Pick glibc images, or raise Node on the musl branch first.

## What the agent actually does at install time

For debugging, the eight steps in order — all of them raise on a non-zero exit,
so the first failure aborts the trial:

1. `super().install()` — Node (nvm on glibc, apk on musl) + `npm i -g opencode-ai@1.18.21`.
2. **root:** create and chown `/opt/akm/{bundle,config,data,cache,state,seed}`.
   Not under `/tmp`: akm silently redirects config and cache for `/tmp`-resident
   bundles, and tmpfs can be reaped between phases.
3. Assert Node ≥ 22, then `npm i -g akm-cli@0.9.1`. The global install is
   mandatory: opencode's npm hoists the plugin's own `akm-cli` to the cache
   package root, where the plugin's bundled-CLI lookup does not search. Without
   a real `akm` on PATH the arm half-works — the in-process tools still import
   the hoisted copy, but feedback, remember, hints and bundle-dir discovery all
   fail.
4. **root:** symlink `akm` and `node` into `/usr/local/bin`. Both are needed —
   `dist/akm` is a `#!/usr/bin/env node` launcher. `/usr/local/bin` is on the
   default PATH of every Harbor base image, which is what lets `AKM_ENV` leave
   `PATH` alone.
5. Upload `harbor/seed-library/` to `/opt/akm/seed` and chown it.
6. `akm bundle create --dir /opt/akm/bundle --set-default`, copy the seed's type
   subdirectories over it, restore 0700 on `env/` and `secrets/`, then
   `akm index --full`. `akm setup` is never used: it hard-fails on a non-TTY
   without `--yes`.
7. Boot opencode once to warm **both** plugin caches (`~/.cache/opencode` and
   `~/.config/opencode`). Warming only the first leaves an offline boot stalling
   ~70s. The boot writes its config with the *same*
   `_build_register_config_command()` the measured run uses -- byte-identical
   config, `plugin`, `tools` and `permission` included -- and passes the arm's
   *real* `model_name`, not a placeholder, so a config opencode rejects fails
   here during setup rather than during the paid run. `install()` never passes
   `self.model_connection.env`, so this boot has no provider credentials: model
   resolution fails and nothing is billed, while everything before that point
   (config parse, plugin install, plugin load, akm CLI resolution) still runs --
   which is exactly what step 8's log grep then asserts. Hence the trailing
   `|| true`. This step is also asymmetry #1 above.
8. The self-check. Any failure prints `AKM-BOOTSTRAP FATAL: <reason>` to stderr
   and aborts.

Install-time execs run with `XDG_DATA_HOME`/`XDG_STATE_HOME` under
`/opt/akm/opencode-install/`, so the warm boot's logs and events do not
contaminate the measured run's `opencode.txt`, event log or run-phase proof.

Every agent-user exec in this phase is stamped `AKM_EVENT_SOURCE=audit`, so the
harness's own akm traffic is excluded from demand and utility scoring. The
measured opencode process runs as `AKM_EVENT_SOURCE=user`. Post-hoc, the
`source` column in akm's usage-events table separates the two.

## Changing versions

All pins are module-level constants in `harbor/akm_opencode.py`:
`OPENCODE_VERSION`, `AKM_CLI_VERSION`, `AKM_PLUGIN_VERSION`. The control arm
cannot import them, so `p0-smoke.yaml` repeats `OPENCODE_VERSION` literally for
both arms and `harbor/tests/test_akm_opencode.py` asserts the two stay in sync —
if you bump the constant without updating the YAML, the tests fail.

`AKM_PLUGIN_VERSION` is pinned exactly, never a bare package name: a bare name
resolves `latest` at every session start, which is both unpinnable and changes
opencode's plugin cache directory name.

## Running the tests

```sh
PYTHONPATH="$(pwd)" pytest harbor/tests -q
```

No Docker, no network, no credentials: container interaction goes through a
recording fake and `install()` is asserted as a list of shell command strings.
