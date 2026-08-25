# Corpus conversion guide: legacy `fixtures/corpus/tasks/` → Harbor `harbor/tasks/`

**Audience:** the domain agents converting the 46-task legacy corpus (az-cli 6,
docker-homelab 6, drillbit 7, inkwell 9, opencode 6, workflow-compliance 11,
`_example` 1) into Harbor task format, one domain at a time.

**Read first:** `docs/plans/benchmark-harness-consolidation.md` §4.4 and §8,
`docs/plans/benchmark-harness-decisions.md` (D1, D2, D4, D6, D7 decided; D3,
D5, D9, D10 open). This guide makes the P3-scoped calls that D10 left open
(fixture delivery mechanism, slice representation, budget mapping) so
per-domain conversion is mechanical from here.

Everything below was verified live against akm 0.9.1 (`bun
/home/user/akm/src/cli.ts`) and Harbor v0.22.0's `harbor.models.task` — no
guessing. The worked example at the bottom is a real, validated task you can
diff your own conversions against.

---

## 0. The non-negotiables

1. **One directory level, flat, double-hyphen separator.** `harbor run -p
   <dir>` scans exactly one directory level
   (`benchmark-harness-consolidation.md` §3.1). Every converted task goes to
   `harbor/tasks/<domain>--<taskid>/` — never `harbor/tasks/<domain>/<taskid>/`.
   **Correction, verified live (§9.3 has the full derivation):** the string
   Harbor actually writes to `result.json`'s `task_name` field is
   `self.task.name` — i.e. `task.toml`'s `[task].name`
   (`akm-bench/<domain>--<taskid>`, org prefix included), **not** the bare
   directory basename. The join key the analysis layer needs is
   `task_name.split("/", 1)[-1]`, which must equal the directory basename for
   every task — no exceptions (see §9.3: the fixture task used to be the one
   exception, until its directory was renamed to remove the mismatch). Get
   the directory basename right regardless — `[metadata]` never reaches
   `result.json`, so this join is the only way back to
   domain/slice/difficulty/etc.
2. **Single `reward` key, 0 or 1 (D4).** `tests/test.sh` writes exactly one
   float to `/logs/verifier/reward.txt`. Never write `reward.json` with
   multiple keys, never write a partial-credit float. Diagnostics beyond
   pass/fail go to `/logs/artifacts/`, joined post-hoc later (D5, open,
   revisited at P4) — they do not affect the reward in this phase.
3. **Task environments are arm-neutral (D2).** Never install akm, opencode,
   or node in a task's `environment/Dockerfile`. Never copy stash content
   into the task environment. akm reaches the treatment-arm container
   through the `AkmOpenCode` custom Harbor agent
   (`harbor/akm_opencode.py`, owned by a concurrent workflow) at agent
   `install()` time — not through anything this conversion writes. The
   baseline arm runs the identical task image; only the `--agent` flag
   Harbor is invoked with differs.
4. **`instruction.md` is arm-neutral prose, not the akm-arm's system prompt.**
   The legacy driver (`src/driver.ts`'s `defaultPrompt`) synthesized a
   *different* prompt per arm: the baseline arm got `Task: <id>\nArm:
   <arm>\nWorkspace: <path>` (forcing it to read the workspace README for
   everything); the akm arm got that plus an explicit "search the stash,
   show the best match, apply it, record feedback" recipe. Harbor has one
   `instruction.md` per task, shared by both arms — there is no per-arm
   prompt slot. The akm-arm equivalent of that recipe is now the
   `AkmOpenCode` agent's job (confirmed in its source: *"Per-prompt curation
   and the hints doctrine block ARE the treatment"*), injected uniformly at
   the agent layer for every task, not authored per-task here. Concretely:
   **never write "search the stash" / "use akm show" / "record akm
   feedback" workflow advice into `instruction.md`** — §3 below has the one
   real exception and how to tell it apart.
5. **The strip rule (§3) applies to the shipped `workspace/README.md`, not
   just `instruction.md`.** `environment/workspace/` is copied verbatim into
   `/app` (§2) and both arms can read it, so an akm-solving-method sentence
   left in the README leaks exactly as much as leaving it in
   `instruction.md` would — Harbor giving each task one shared prompt slot
   doesn't mean the *workspace* only has one arm-neutral surface too, it has
   two. Read every `workspace/README.md` for the same "how to find the
   answer" vs. "what the artifact must contain" test §3 describes, not only
   the legacy `title`/README text you're deriving `instruction.md` from.
   The first conversion pass on this corpus missed exactly this — stripped
   the sentence from `instruction.md` on 16 tasks but left it standing in
   the shipped README on 12 of them (6 docker-homelab, 5 inkwell, 1
   opencode) — check explicitly, don't assume stripping `instruction.md`
   covered it.

---

## 1. `task.toml` template

```toml
schema_version = "1.4"

[task]
name = "akm-bench/<domain>--<taskid>"
version = "1.0.0"
description = "<legacy task.yaml title, verbatim>"
authors = []
keywords = []

[metadata]
legacy_task_id = "<domain>/<taskid>"      # = legacy task.yaml `id:`, for traceability
domain = "<domain>"
slice = "train" | "eval"                  # from task.yaml `slice:` (all 46 declare one explicitly)
difficulty = "easy" | "medium" | "hard"
stash = "<stash>"                         # legacy task.yaml `stash:` — must be a harbor/stashes/ dir name
budget_tokens = <int>                     # legacy task.yaml budget.tokens
budget_wall_ms = <int>                    # legacy task.yaml budget.wallMs
# --- optional, copy only when present in the legacy task.yaml ---
gold_ref = "<0.9 conceptId>"              # resolved via harbor/stashes-meta/gold-ref-map.json — NEVER hand-translate
gold_ref_legacy = "<legacy type:name>"    # the pre-0.9 spelling, for provenance
memory_ability = "<one of MEMORY_ABILITY_VALUES>"
task_family = "<domain>/<short-name>"
akm_keywords = "<string>"
workflow_focus = "<string>"
expected_transfer_from = ["<domain>/<short-name>", ...]
abstention_case = true | false
conflict_case = true | false
stale_guidance_case = true | false
# --- workflow-compliance-only optional fields (issue #259 in the legacy corpus) ---
workflow_failure_category = "<string>"
expected_workflows = ["<string>", ...]
repeated_failure_group = "<string>"

[verifier]
timeout_sec = <max(120, budget.wallMs / 1000 * 3)>

[agent]
timeout_sec = 600.0

[environment]
workdir = "/app"

[environment.env]
AKM_TASK_STASH = "<stash>"
```

### Field-by-field notes

- **`[task].name`** must satisfy Harbor's `ORG_NAME_PATTERN`
  (`^[a-zA-Z0-9][a-zA-Z0-9._-]*/[a-zA-Z0-9][a-zA-Z0-9._-]*$` —
  `harbor/src/harbor/constants.py`): org and name each start with an
  alphanumeric. Every real domain (`az-cli`, `docker-homelab`, `drillbit`,
  `inkwell`, `opencode`, `workflow-compliance`) satisfies this trivially. The
  one exception is the `_example` fixture domain, which starts with `_` —
  see the worked example below for how that's handled
  (`akm-bench/reference--example-task`, leading underscore dropped from the
  `[task].name` value **and** from the directory basename, so the two stay
  aligned — see §9.3 for why keeping the underscore in only one of them is a
  trap).
- **`[metadata]`** is a free-form dict Harbor stores verbatim in `task.toml`
  but **never surfaces in `result.json`** at any level
  (`benchmark-harness-consolidation.md` §3.1). It exists purely so the
  analysis layer (P4, not this phase) can read `task.toml` directly and
  left-join on `task_name` (the directory basename). Carry every field the
  legacy `task.yaml` declares — including the four workflow-compliance-only
  fields, even though **no code in this repo parses them today**
  (`src/corpus.ts`'s `RawTask` doesn't recognize `expected_workflows`,
  `workflow_failure_category`, or `repeated_failure_group` — verified by
  grep). They're dead weight in the current loader but real signal a later
  phase may want; dropping them during conversion is a one-way information
  loss, so don't.
- **`gold_ref`**: resolve from `harbor/stashes-meta/gold-ref-map.json`, never by
  re-deriving the 0.9 spelling yourself (the 0.9 conceptId is not a
  mechanical string transform of the legacy `type:name` — it happened to be
  `type:name → types/name` for every asset in this corpus, but that's an
  artifact of how these 7 fixture stashes happen to be laid out, not a
  contract). If your task's `gold_ref` isn't in the map, or maps to
  `"unresolvable": true`, stop and flag it — don't invent a spelling.
- **`[verifier].timeout_sec`**: `max(120, wallMs / 1000 * 3)`. The legacy
  `budget.wallMs` bounded the whole synthetic-driver loop (agent run +
  verifier); Harbor separates agent and verifier timeouts, and our
  `tests/test.sh` runs in low single-digit seconds for every real task in
  this corpus (file/YAML/regex checks, no network, no build). The 3x factor
  is slack, not a real requirement. Observed corpus values: `wallMs` ∈
  {30000, 90000, 180000, 360000} → `timeout_sec` ∈ {120, 270, 540, 1080}.
- **`[agent].timeout_sec = 600.0`** is a flat constant across all 46 tasks,
  **not** derived from `budget.wallMs`. The legacy `wallMs` values (30s–360s)
  bounded a synthetic test harness, not a real model round-trip against a
  real provider; a real `opencode run` needs headroom the legacy budget
  never had to account for. Do not scale this per task.
- **`[environment].workdir = "/app"`**: this is not cosmetic. Harbor's
  Docker environment's `exec()` defaults `cwd` to
  `task_env_config.workdir` when the caller (the verifier) doesn't pass one
  explicitly (`environments/docker/docker.py:1104`, verified in source) —
  meaning `tests/test.sh` runs with this as its cwd. Every ported
  `verify.sh` / `test_*.py` in this corpus uses paths relative to the
  workspace root (`greeting.txt`, `service.yaml`, ...), so this must match
  the Dockerfile's `WORKDIR` exactly. Set both to `/app`. **Known risk, not
  a conversion defect — do not "fix" it by varying `workdir` per task:**
  opencode also merges a *project-level* `opencode.json` from its working
  directory at session start, and 5 tasks either ship one in
  `environment/workspace/` or require the agent to author one as the
  deliverable (`opencode--opencode-config-model`,
  `opencode--tool-allowlist`, and the three
  `workflow-compliance--repeated-fail-opencode-*` tasks). Because
  `workdir` is uniformly `/app` for all 46 tasks, an agent that edits or
  is seeded with `/app/opencode.json` could in principle affect its own
  tool/model/provider config for the remainder of that same session. This is
  inherited from the legacy driver (which also ran opencode with `cwd` =
  the workspace), not introduced by this conversion, and every one of these
  5 tasks passes the two-run rule (§10.1) and derivability rule (§10.2)
  regardless — but the effect on trial-to-trial variance is unverified.
  Giving these 5 tasks a non-`/app` `workdir` would violate the uniform
  convention this field's whole point is to enforce (every ported
  `verify.sh`/`test_*.py` assumes cwd = `/app`) and would need
  re-validating all 5 verifiers besides. If this needs mitigating, it
  belongs in the agent layer (`harbor/akm_opencode.py`'s `install()`, or
  the baseline `OpenCode` agent's own config handling) or in job config, not
  in a per-task `workdir` override.
  **Update — the risk is confirmed, not hypothetical, and all 5 tasks are now
  fixed.** Reproduced against opencode 1.18.11 and re-confirmed against the
  pinned 1.18.21: a real `opencode run` in a directory holding `opencode.json`
  loads that file as its own project config, applies it to the session, and
  rewrites it with a `"$schema": "https://opencode.ai/config.json"` line before
  the model's first turn. In all 5 tasks the *graded* artifact sat at
  `/app/opencode.json`, so the agent under test was reading — and applying —
  the thing it was being scored on. Three of the five were worse than a
  rewrite, at 1.18.21:

  | task | what the graded answer did to the agent |
  | --- | --- |
  | `opencode--tool-allowlist` | `tools` as an ARRAY is invalid against opencode's own `Record<string, boolean>` schema → `Configuration is invalid … Expected object \| undefined`, opencode exits 1 and never starts |
  | `workflow-compliance--repeated-fail-opencode-disable-provider` | `"openai": false` → `Configuration is invalid … Expected ProviderConfig, got false`, opencode exits 1 and never starts |
  | `workflow-compliance--repeated-fail-opencode-provider-token-{train,eval}` | `provider.anthropic.options.apiKey` HIJACKS the agent's own credential: the outbound request carried the fixture's `{env:ANTHROPIC_API_KEY}` value instead of the agent's configured key |
  | `opencode--opencode-config-model` | the fixture's bogus model was applied to the agent's own session |

  Each task's fixture, instruction, README, solution and verifier now use
  `config/opencode.json` (opencode's discovery is a `findUp` from cwd and never
  descends, so a subdirectory is out of reach). Where the graded file is
  *created* rather than shipped, the task Dockerfile pre-creates `/app/config`
  so the move costs the agent no step the original task did not ask for.
  `workdir` stays `/app` — the fix is the artifact's path, not the convention.
  What each task measures is unchanged: same literals, same checks, same
  `expected_workflows`. Each task's own `tests/verify.sh` carries the full
  rationale and the per-task evidence.
  **Second, separate defect — same cause, different opencode subsystem:
  project INSTRUCTION files.** `OPENCODE_DISABLE_PROJECT_CONFIG` does not
  cover this one, because the file is loaded as instructions, not as config.
  opencode's `Instruction.systemPaths` walks UP from cwd over the names
  `AGENTS.md`, `CLAUDE.md`, `CONTEXT.md` (`findUp(name, directory,
  worktree)`) and splices whatever it finds VERBATIM into the system prompt
  of the agent under test, prefixed `Instructions from: <path>`. Two eval
  tasks graded an artifact at `/app/AGENTS.md`
  (`opencode--agents-md-akm-snippet`, `opencode--select-correct-skill`), so
  the model's own graded output became the model's own instructions mid-trial
  — a feedback loop, strictly worse than the config rewrite above. Both now
  grade `agent-guidance.md`; no other filename is matched, and the graded file
  stays at the workspace root so the rename costs the agent no step.
  Verified in a container at the pinned `opencode-ai@1.18.21` against a
  listener that logged the outbound request body: the same marker content at
  `AGENTS.md`/`CLAUDE.md`/`CONTEXT.md` appeared in the system prompt, while at
  `agent-guidance.md` (and at `docs/AGENTS.md`) the request was byte-identical
  to the no-instruction-file baseline. Full rationale and evidence live in
  `harbor/tasks/opencode--agents-md-akm-snippet/tests/verify.sh` and
  `harbor/tasks/opencode--select-correct-skill/tests/test_select_skill.py`.
- **`[environment.env].AKM_TASK_STASH`**: the legacy task.yaml `stash:`
  value, verbatim — must equal a directory name under `harbor/stashes/`.
  This is the entire cross-workflow contract with `AkmOpenCode`; get the
  spelling wrong and the treatment arm silently seeds an empty/wrong bundle
  instead of failing loudly (`harbor/akm_opencode.py` logs an error if
  `stash_root` is missing but does **not** validate that a *named* stash
  subdirectory exists before falling through — double-check the spelling
  against `harbor/stashes-meta/README.md`'s table).
- **Do not set `[environment].docker_image`.** See §2 — every task ships its
  own `environment/Dockerfile` instead, uniformly.

---

## 2. `environment/` — the one delivery mechanism (resolves D10's fixture-delivery sub-question for task workspaces)

**Decision:** every converted task ships `environment/Dockerfile`. None set
`[environment].docker_image`. This is deliberate, not the naive per-verifier
split you might reach for first (`docker_image` for script tasks,
`Dockerfile` only for pytest tasks) — that split breaks the moment a
script-verified task has real workspace files (which is 28 of the 29 script
tasks; the only exception is this guide's own worked example). A bare
`docker_image` gives no build step, so there is no way to `COPY` fixture
files in. One mechanism, always a `Dockerfile`, removes the special case.

**Two base-image variants, selected by `verifier:`:**

```dockerfile
# --- script verifier ---
FROM ubuntu:24.04
WORKDIR /app
COPY workspace/ /app/          # omit this line only if workspace/ is empty — see below
```

```dockerfile
# --- pytest verifier ---
FROM python:3.12-slim
WORKDIR /app
RUN pip install --no-cache-dir pytest==8.4.1 pytest-json-ctrf==0.3.5 pyyaml
COPY workspace/ /app/
```

(`regex` verifier tasks — none exist in the current 46, see §4.3 — use the
`script` verifier's base image, since the check runs against agent output,
not workspace files; still `COPY workspace/` if the task ships one.)

**Workspace copy rule:** copy the legacy task's `workspace/` directory to
`harbor/tasks/<domain>--<taskid>/environment/workspace/` verbatim, **except**:
drop a bare `.gitkeep` placeholder (only the `_example` fixture has one — a
real task's `workspace/` always has real content) and drop
`workspace/AGENTS.md` (see §3 — that file is legacy akm-arm scaffolding,
never task content, and shipping it would let the agent read akm-specific
hints Harbor never intended to expose uniformly; in the two opencode
fixtures whose graded deliverable IS that file it now ships as
`workspace/agent-guidance.md` — see §1's instruction-file note — and must be
dropped just the same). If, after those two exclusions,
`environment/workspace/` would be empty, delete the directory
entirely and drop the `COPY workspace/ /app/` line from the Dockerfile (this
guide's worked example is the only task in the corpus where that applies).

**Do not copy** `fixtures/corpus/base/workspace/` or
`fixtures/corpus/base/domains/<domain>/workspace/` content. Those are the
legacy per-domain `AGENTS.md` scaffolding files the old `seedWorkspace()`
layered under every task's own `workspace/` — same category as the
per-task `workspace/AGENTS.md` exclusion above, just domain-wide instead of
task-specific. None of it is task content.

**Legacy `tests/*.py` path caveat — check every pytest task:** most legacy
pytest tests resolve fixture paths as `pathlib.Path("service.yaml")`
(relative to cwd), which ports verbatim since Harbor's verifier also runs
with cwd = `/app` (§1). **Three legacy test files do not** — they resolve
`pathlib.Path(__file__).parent.parent / "workspace" / "<file>"`, which
assumed the legacy `<taskDir>/tests/` + `<taskDir>/workspace/` sibling
layout. Under Harbor, `tests/` becomes `/tests` and the workspace is `/app`
— `__file__`'s `parent.parent` no longer resolves to anything meaningful.
**Grep every pytest task's `tests/*.py` for `__file__` before copying it in
verbatim; rewrite the affected line to a plain relative path.** The three
known instances as of this writing:

| Legacy file | Fix |
| --- | --- |
| `inkwell/full-config/tests/test_full_config.py` | `SERVICE = pathlib.Path(__file__).parent.parent / "workspace" / "service.yaml"` → `SERVICE = pathlib.Path("service.yaml")` |
| `inkwell/workflow-configure-scaling/tests/test_workflow_scaling.py` | same fix, same variable |
| `opencode/select-correct-skill/tests/test_select_skill.py` | `AGENTS = pathlib.Path(__file__).parent.parent / "workspace" / "agent-guidance.md"` → `AGENTS = pathlib.Path("agent-guidance.md")` |

This is a silent-failure trap, not a loud one: the unfixed test raises
`FileNotFoundError` (or resolves to a nonexistent `/workspace/...` path) and
every run — oracle solution included — fails identically, so it reads as
"verifier is broken," not "conversion bug," unless you know to look here.
**Verify your oracle solution against the real reward path before moving on
(§6)** — this is exactly the class of bug that check catches.

---

## 3. `instruction.md` — authoring rules

Derive from: legacy `task.yaml` `title:` + the legacy `workspace/README.md`
content + what the verifier objectively requires (read `verify.sh` /
`tests/*.py`, but never restate its literal expected values, hashes, magic
strings, or file/test names beyond what the README already told the agent).
State the working directory is `/app`. State what "done" looks like
observably (files to produce, their required properties) — never leak *how*
the verifier checks it.

### The strip rule

Legacy `workspace/README.md` files sometimes contain a sentence recommending
akm as the **method** for solving the task (e.g. *"Use `akm show
skill:inkwell` for the exact field names"*, *"Use `akm search docker compose
network bridge` to find the correct YAML structure"*). **Strip these
sentences.** They are workflow scaffolding belonging to the akm arm's system
prompt (now the `AkmOpenCode` agent's job — §0.4), not task specification.
16 of the 46 tasks' README.md files contain at least one such sentence;
after stripping, the underlying task requirement (the field names, the YAML
shape) must still be fully specified by what remains — check that it is
(these fixtures were authored so the workspace already states the concrete
requirement independently of the akm hint; e.g. `inkwell/full-config`'s
README lists all nine required field values explicitly regardless of the
akm sentence).

Also strip legacy `workspace/AGENTS.md` files that are pure akm-usage
scaffolding (numbered "run akm search, run akm show, apply, give feedback"
recipes) — don't ship them (§2).

### The exception: when "akm" is the task's own subject matter, not scaffolding

The `opencode` domain (6 tasks) is about akm/opencode integration itself —
its objective is literally "write a config/script/doc whose content
correctly references akm commands." There, "akm search" / "akm feedback"
are **required literal output content**, not a solving method, and must be
kept verbatim:

> `opencode/agents-md-akm-snippet` — legacy README: *"the file must contain
> the literal string `akm search`."* This is a deliverable constraint
> (parallel to a task whose deliverable is "write a Dockerfile," which
> legitimately says "docker" throughout) — keep it word for word.

Apply this test line by line, not file by file: **does this sentence tell
the agent how to go find the answer (strip), or does it constrain what the
produced artifact must contain (keep)?** The three
`workflow-compliance/repeated-fail-opencode-*` tasks mix both in the same
README and are the hardest real case in the corpus — worked in full below.

#### Worked case study: `workflow-compliance/repeated-fail-opencode-provider-token-train`

Legacy `workspace/README.md` (annotated):

```
- Follow `AGENTS.md` workflow requirements before editing.                    [STRIP — dangling ref, AGENTS.md not shipped]
- This task is intentionally underspecified in the prompt. The exact          [STRIP — reveals the solving method]
  anthropic model pin and env-ref token wiring come from AKM opencode
  guidance.
- If you skip AKM lookup, verifier failures are likely.                       [STRIP — same]

Required workflow (for reproducibility):
1. Run `akm search opencode config`.                                          [STRIP — solving method]
2. Run `akm show skill:opencode`.                                             [STRIP — solving method]
3. Then edit files.

Update `config/opencode.json` to satisfy these constraints:                   [KEEP — deliverable spec]
- set `model` to the anthropic default model required for this
  provider-token train variant,
- ensure a `provider` object exists,
- under `provider.anthropic`, add an `options` object,
- set `provider.anthropic.options.apiKey` to the canonical env-ref form
  used by opencode config.

Also add a brief prep note in `prep-note.txt` with this exact line:           [KEEP — deliverable spec,
- `prep: anthropic provider token train`                                       fully self-contained]

Then add two provenance lines in `prep-note.txt`:                             [KEEP — deliverable spec.
- `akm-search-query: opencode config`                                          These are literal strings
- `akm-show-ref: skill:opencode`                                               given verbatim in the
                                                                                 prompt already; the agent
Keep existing unrelated keys unchanged. Do not run opencode.                   doesn't need real akm access
                                                                                 to reproduce them.]
```

Resulting `instruction.md` keeps every constraint and drops every
solving-method sentence. Note what this does to the task, faithfully: the
exact required `model` / `apiKey` values are **genuinely not derivable**
from what remains — that's not an authoring bug, it's the legacy task's
actual design (a case constructed so the baseline arm cannot pass and the
treatment arm can, by using the akm access its agent wrapper gives it). Do
not "fix" this by adding the value back in — that would erase the effect
the task exists to measure.

---

## 4. `tests/` — verifier templates

Harbor copies the task's `tests/` directory to `/tests` and runs `bash
/tests/test.sh` (verified: `harbor/src/harbor/verifier/verifier.py`, shared
mode — the default, same container as the agent, so `/tests` and `/app` both
exist side by side). `test.sh` must write exactly one 0-or-1 float to
`/logs/verifier/reward.txt` (D4). Richer output goes to `/logs/artifacts/`.

### 4.1 `script` verifier (29 tasks)

Copy the legacy `verify.sh` in as `tests/verify.sh` unchanged (it already
uses cwd-relative paths, which is the correct convention on both sides).
`tests/test.sh` is a fixed wrapper — copy this verbatim for every
script-verified task, no per-task edits:

```bash
#!/bin/bash
# Harbor entry point: copied to /tests/test.sh and run from the container's
# working directory (task.toml [environment].workdir = "/app"). Wraps the
# ported legacy `verify.sh` and reduces its exit code to the single
# reward.txt signal Harbor's viewer/aggregator reads.
set -uo pipefail

mkdir -p /logs/verifier /logs/artifacts

bash /tests/verify.sh >/logs/artifacts/verify-stdout.txt 2>&1
status=$?

if [ "$status" -eq 0 ]; then
  echo 1 >/logs/verifier/reward.txt
else
  echo 0 >/logs/verifier/reward.txt
fi

cat /logs/artifacts/verify-stdout.txt
```

### 4.2 `pytest` verifier (17 tasks)

Copy every legacy `tests/test_*.py` file in unchanged **except** the three
files needing the `__file__`-path fix (§2). `pytest` and
`pytest-json-ctrf` are installed at image-build time
(`environment/Dockerfile`, §2) so `test.sh` never touches the network:

```bash
#!/bin/bash
# Harbor entry point. pytest and pytest-json-ctrf are already on PATH —
# installed at image build time (environment/Dockerfile), not here, so this
# script has no network dependency.
set -uo pipefail

mkdir -p /logs/verifier /logs/artifacts

pytest -q --tb=line --ctrf /logs/verifier/ctrf.json /tests -rA \
  >/logs/artifacts/pytest-stdout.txt 2>&1
status=$?

if [ "$status" -eq 0 ]; then
  echo 1 >/logs/verifier/reward.txt
else
  echo 0 >/logs/verifier/reward.txt
fi

cat /logs/artifacts/pytest-stdout.txt
```

`pytest ... /tests` (not a subpath) is correct and safe: `/tests` also
contains `test.sh` itself, but pytest only collects `test_*.py` /
`*_test.py`, so the wrapper script is silently ignored during collection.

### 4.3 `regex` verifier (0 tasks today, template for future use)

No task in the current 46-task corpus uses `verifier: regex` (verified:
`grep -c '^verifier: regex'` across the corpus is 0 — census is 29 script +
17 pytest = 46). The legacy verifier matched `expected_match` against the
agent's raw stdout (`agentStdout`), which under Harbor's `opencode` agent is
persisted at `/logs/agent/opencode.txt` (verified:
`harbor/src/harbor/agents/installed/opencode.py`, `_OUTPUT_FILENAME =
"opencode.txt"`; the file is present at verify time because the shared
verifier runs in the same container the agent just ran in — nothing needs
syncing). If a future task needs this:

```bash
#!/bin/bash
set -uo pipefail

mkdir -p /logs/verifier

PATTERN='<expected_match, copied verbatim from legacy task.yaml>'

if grep -qE "$PATTERN" /logs/agent/opencode.txt; then
  echo 1 >/logs/verifier/reward.txt
else
  echo 0 >/logs/verifier/reward.txt
fi
```

**Caveat:** the legacy engine matched with JavaScript `RegExp`; this
template matches with `grep -E` (POSIX ERE). They agree on simple patterns
(literal text, basic character classes, anchors, alternation) but diverge on
some constructs (`\d`, lookahead/lookbehind, named groups). Check the
specific `expected_match` pattern by hand before porting — don't assume.

---

## 5. `gold_ref` resolution

Never hand-translate a legacy `gold_ref` (`type:name`) to a 0.9 conceptId by
guessing the plural/singular form. Look it up in
`harbor/stashes-meta/gold-ref-map.json`, built by indexing every fixture stash
under akm 0.9.1 and reading the ref back from `akm search` output — see that
file and `harbor/stashes-meta/README.md` for the resolution method and the
verified counts.

**All 8 distinct `(stash, legacy ref)` pairs now resolve.** Verified by
execution, not by inspection: each of the 7 stashes was copied into a scratch
bundle, indexed with `akm index --full` under akm 0.9.1, and every `gold_ref`
in `harbor/tasks/*/task.toml` was probed with `akm show <ref>` — all 8 exit 0,
covering the 43 tasks that declare one.

`workflow:configure-inkwell-service` (stash `inkwell`) was the one holdout in
the first conversion pass: the fixture's workflow markdown fails akm 0.9.1's
workflow-asset schema validation and never enters the index. The
execution-validation pass migrated **the `harbor/stashes/inkwell` copy** (not
`fixtures/`, which the legacy driver still owns) to the 0.9.1 workflow schema,
so the asset now indexes (`entryCount` 2 → 3) and
`akm show workflows/configure-inkwell-service` exits 0.
`inkwell--workflow-configure-scaling` therefore carries
`gold_ref = "workflows/configure-inkwell-service"`. See
`harbor/stashes-meta/README.md` for the exact before/after and
`harbor/stashes-meta/gold-ref-map.json` for the map entry.

**Three tasks still carry no `gold_ref`, correctly:** `_example/example-task`,
`workflow-compliance/abstention-rust-async-haiku`, and
`workflow-compliance/tempting-shortcut-arithmetic` declare none in their legacy
`task.yaml` (`grep -L '^gold_ref:' fixtures/corpus/tasks/*/*/task.yaml`), because
loading nothing is the correct behaviour. **Omit** the key for those — don't
write `gold_ref = ""` or a guessed spelling. (`analysis/src/corpus.ts`'s
`asString()` maps both an absent key and `""` to `undefined`, so omission costs
nothing downstream and doesn't invent data.)

---

## 6. Validating a converted task

No Docker daemon exists in this environment — validate structurally, not by
running a container:

```sh
# 1. Task.is_valid_dir + TaskConfig parse (the sanctioned entrypoint —
#    doesn't touch Docker):
python3 -c "
import sys; sys.path.insert(0, '<harbor checkout>/src')
from harbor.models.task.task import Task
print(Task.is_valid_dir('harbor/tasks/<domain>--<taskid>'))
t = Task('harbor/tasks/<domain>--<taskid>')
print(t.name, t.config.verifier.timeout_sec, t.config.agent.timeout_sec)
print(t.config.environment.workdir, t.config.environment.env)
"

# 2. One-level scan sanity check (mirrors how `harbor run -p harbor/tasks`
#    will actually discover tasks):
python3 -c "
import sys, os; sys.path.insert(0, '<harbor checkout>/src')
from harbor.models.task.task import Task
root = 'harbor/tasks'
print([d for d in sorted(os.listdir(root)) if Task.is_valid_dir(os.path.join(root, d))])
"

# 3. Run the ACTUAL verifier logic locally, TWICE — pristine, then oracle
#    (this is what catches the __file__-path trap in §2 — is_valid_dir alone
#    won't — and it is what catches a task that ships its own answer, §10.1):
cd harbor/tasks/<domain>--<taskid>

# 3a. Pristine: verifier must score 0 with ZERO agent action.
mkdir -p /tmp/verify-pristine && cp -r environment/workspace/. /tmp/verify-pristine/ 2>/dev/null
cd /tmp/verify-pristine
bash <task-dir>/tests/verify.sh; echo "exit=$?"   # script verifier: must be non-zero
# — or —
pytest -q <task-dir>/tests                        # pytest verifier: must fail

# 3b. Oracle: apply solution/solve.sh, then the verifier must score 1.
cd /tmp && rm -rf verify-oracle && mkdir verify-oracle && cp -r <task-dir>/environment/workspace/. verify-oracle/ 2>/dev/null
cd verify-oracle
bash <task-dir>/solution/solve.sh
bash <task-dir>/tests/verify.sh; echo "exit=$?"   # script verifier: must be 0
# — or, after applying solve.sh —
pytest -q <task-dir>/tests                        # pytest verifier: must pass
```

Step 3 is not optional for pytest tasks: it's the only step that actually
executes `test_*.py`, which is where the `__file__`-path bug in §2 hides.
**Neither half of step 3 is optional for any task, script or pytest:** 3b
alone (`oracle == 1`) is not enough — eight legacy fixtures had a pristine
workspace that already scored 1 with zero agent action, which is a task
that measures nothing (§10.1's two-run rule has the full account, including
all eight). Run 3a first; a converted task that scores non-zero on the
pristine workspace needs its shipped `environment/workspace/` fixed (usually
by removing or truncating a pre-solved file — see the `NOTE` comments in
`environment/Dockerfile` on the tasks §10.1 and §10.3 name) before you move
on, not documented as a known issue.

---

## 7. Worked example: `reference--example-task`

The legacy `fixtures/corpus/tasks/_example/example-task/` (the loader's own
unit-test fixture — excluded from real corpus statistics by the `_example/`
prefix, per `src/corpus.ts`'s `isExampleTaskDir`) converts to
`harbor/tasks/reference--example-task/`. It's the simplest possible task —
a `script` verifier, no `gold_ref`, empty `workspace/` — which is exactly
why it's the reference: every mechanical step is visible with nothing else
going on.

**Legacy source** (`fixtures/corpus/tasks/_example/example-task/`):

```yaml
# task.yaml
id: _example/example-task
title: "Example task — write 'hello' to greeting.txt"
domain: _example
difficulty: easy
slice: train
stash: minimal
verifier: script
budget:
  tokens: 1000
  wallMs: 30000
```

```bash
# verify.sh
#!/usr/bin/env bash
set -euo pipefail
if [[ ! -f greeting.txt ]]; then
  echo "greeting.txt missing"; exit 1
fi
if grep -qi "hello" greeting.txt; then
  echo "ok"; exit 0
fi
echo "greeting.txt did not contain 'hello'"; exit 1
```

`workspace/` contains only `.gitkeep` — no real fixture content (§2's one
"empty workspace" case in the whole corpus).

**Converted** (`harbor/tasks/reference--example-task/`):

```
reference--example-task/
├── task.toml
├── instruction.md
├── environment/
│   └── Dockerfile          # no workspace/ subdir — legacy workspace/ was empty
├── tests/
│   ├── test.sh              # the fixed §4.1 wrapper, verbatim
│   └── verify.sh            # copied from legacy verify.sh, unchanged
└── solution/
    └── solve.sh              # oracle: echo "hello" > greeting.txt
```

`task.toml`:

```toml
schema_version = "1.4"

[task]
name = "akm-bench/reference--example-task"
version = "1.0.0"
description = "Example task — write 'hello' to greeting.txt"
authors = []
keywords = []

[metadata]
legacy_task_id = "_example/example-task"
domain = "_example"
slice = "train"
difficulty = "easy"
stash = "minimal"
budget_tokens = 1000
budget_wall_ms = 30000
notes = "This task exists for unit-testing the bench corpus loader and verifier dispatcher. It is not part of the real corpus; the _example/ prefix excludes it from corpus statistics. Real tasks land in #237."

[verifier]
timeout_sec = 120.0

[agent]
timeout_sec = 600.0

[environment]
workdir = "/app"

[environment.env]
AKM_TASK_STASH = "minimal"
```

`description` is copied verbatim from the legacy `title` — em dash and all;
don't let a shell heredoc or editor autocorrect quietly ASCII-fy it (the
first conversion pass did, on this exact file, and it was the only
mistranscribed field in the whole 46-task corpus). `metadata.notes` is
likewise copied verbatim from the legacy `task.yaml`'s `metadata.notes`
block — §1 says carry every field the legacy file declares, and this is the
one field the first pass dropped.

Note `[task].name` drops the legacy domain's leading underscore
(`akm-bench/reference--example-task`, not
`akm-bench/_example--example-task`) to satisfy `ORG_NAME_PATTERN` (§1) — and,
as of this revision, so does the **directory basename**
(`reference--example-task`, not `_reference--example-task`). Both used to
drop the underscore only from `[task].name`, keeping it in the directory
basename for "traceability" — that was a mistake: it made this the one task
in the whole corpus where `result.json`'s `task_name`, stripped of its org
prefix, didn't equal the directory basename (§9.3 has the full blast radius).
`metadata.legacy_task_id` (`_example/example-task`) is what actually carries
the real legacy identity now; nothing downstream needs the directory name
to carry it too. No real corpus domain needs any of this treatment — it's
specific to this one fixture-only example, whose domain is the only one
that starts with `_`.

`instruction.md`:

```
Your working directory is `/app`.

Create a file named `greeting.txt` in the working directory. Its contents
must include the word "hello" (matching is case-insensitive).
```

`environment/Dockerfile`:

```dockerfile
FROM ubuntu:24.04

WORKDIR /app
```

`tests/test.sh` — the unmodified §4.1 template, `tests/verify.sh` — the
legacy script byte-for-byte.

### Validated

```
$ python3 -c "... Task.is_valid_dir('harbor/tasks/reference--example-task') ..."
True

$ python3 -c "... t = Task('harbor/tasks/reference--example-task'); print(t.config.metadata) ..."
{'legacy_task_id': '_example/example-task', 'domain': '_example', 'slice': 'train',
 'difficulty': 'easy', 'stash': 'minimal', 'budget_tokens': 1000, 'budget_wall_ms': 30000,
 'notes': 'This task exists for unit-testing the bench corpus loader and verifier dispatcher. '
          'It is not part of the real corpus; the _example/ prefix excludes it from corpus '
          'statistics. Real tasks land in #237.'}
config.verifier.timeout_sec: 120.0
config.agent.timeout_sec: 600.0
config.environment.workdir: /app
config.environment.env: {'AKM_TASK_STASH': 'minimal'}
config.environment.docker_image: None

$ python3 -c "... one-level scan of harbor/tasks/, filtered to this one ..."
['reference--example-task']

$ python3 -c "... t.name.split('/', 1)[-1] == directory basename, across ALL 46 tasks ..."
mismatches: []
```

`TaskConfig.model_validate_toml` parses the file cleanly (no
`ValidationError`), `Task.is_valid_dir` returns `True`, and the one-level
scan (mirroring `harbor run -p harbor/tasks`) discovers exactly this one
task by its directory basename — confirming the naming convention in §0.1
resolves the way `harbor run -p` actually walks the tree. No Docker daemon
was needed for any of this; it's the same validation path a domain agent
should run after every task it converts (§6).

---

## 8. Per-domain conversion checklist

1. For each task: copy `task.yaml` fields into `task.toml` per §1's
   template. Resolve `gold_ref` via `harbor/stashes-meta/gold-ref-map.json` (§5).
2. Copy `workspace/` to `environment/workspace/`, dropping `AGENTS.md` and a
   bare `.gitkeep` (§2). Author `environment/Dockerfile` from the §2
   template matching the task's `verifier:` kind. **Apply the strip rule
   (§3, §0.5) to `workspace/README.md` here, not only to `instruction.md`
   in the next step** — it ships into `/app` verbatim and both arms can
   read it, so an akm-solving-method sentence left standing in it leaks
   exactly as much as one left in `instruction.md`. This is a real trap:
   the first conversion pass got it right for `instruction.md` on all 16
   affected tasks and still shipped the un-stripped sentence into the
   README on 12 of them.
3. Author `instruction.md` from `title` + `workspace/README.md`, applying
   the strip rule (§3). If your domain is `opencode`, or your task is one of
   the `repeated-fail-opencode-*` family, read the case study in §3 first.
   Match legacy prompt difficulty in both directions: state what the
   verifier objectively requires, but don't add structural specificity
   (an exact key name, "top-level" placement, etc.) the legacy title/README
   never gave and the task doesn't strictly need spelled out to be
   unambiguous.
4. Convert `verify.sh` → `tests/verify.sh` + `tests/test.sh` (§4.1), or
   `tests/test_*.py` → same files, checking every one for the `__file__`
   trap first (§2) → `tests/test.sh` (§4.2).
5. Author `solution/solve.sh` (used by the oracle agent, and it's what step
   6's two-run check needs to exercise the real path — treat it as
   required, not optional, since step 6 can't be completed without it).
6. Validate per §6 — **both halves of step 3: pristine scores 0, oracle
   scores 1** (§10.1) — not just `is_valid_dir`. If the pristine workspace
   scores non-zero, fix the shipped `environment/workspace/` (don't ship
   the answer) and add a `NOTE` to `environment/Dockerfile` explaining what
   changed and why, matching the style of the existing `NOTE`s in the
   corpus — this documentation step is not optional either; three
   already-fixed tasks in this corpus shipped without one and had to be
   backfilled.
7. Land the task at `harbor/tasks/<domain>--<taskid>/` — flat, one level,
   nowhere else.

---

## 9. Running the corpus: registry vs. flat directory

All 46 tasks are now converted and live under `harbor/tasks/`. This section
documents the two ways to select them for a run, resolves D10's slice
sub-question with real counts (not the plan's estimate), and closes out the
oracle-coverage question. Everything below was re-verified live this session
against Harbor v0.22.0 (`harbor.models.job.config.DatasetConfig`,
`harbor.models.registry.Registry`, `harbor.models.task.task.Task`) — source
citations are file paths under Harbor's own `src/harbor/`.

### 9.1 Two selection mechanisms

**Versioned dataset — `harbor/registry.json`.** A flat JSON array of two
`DatasetSpec` rows (`harbor.models.registry.Registry.from_path` parses the
file itself as the array — there is no wrapping object), built by reading
every task's `task.toml [metadata].slice`:

- `akm-tasks-train@1.0` — 27 tasks: the 26 train-sliced domain tasks plus
  `reference--example-task` (its own `task.toml` declares `slice = "train"`
  too — it is not special-cased out of the registry).
- `akm-tasks-eval@1.0` — 19 tasks: all eval-sliced domain tasks. The fixture
  task has no eval counterpart, so this slice is domain tasks only.

27 + 19 = 46 = the full corpus. No drift from the plan's estimate in either
direction — both domain conversions landed exactly on the projected split.

```sh
cd akm-bench   # registry.json paths are repo-root-relative — see §9.2
harbor run --registry-path harbor/registry.json -d akm-tasks-train@1.0 -a <agent> -m <model> ...
harbor run --registry-path harbor/registry.json -d akm-tasks-eval@1.0  -a <agent> -m <model> ...
```

**Flat directory — `-p harbor/tasks`.** `DatasetConfig(path=...)` lists the
directory with `iterdir()` (one level, confirmed in source —
`_get_local_task_configs`, `harbor/src/harbor/models/job/config.py`) and
keeps every entry that passes `Task.is_valid_dir`. This has no slice concept
at all — only `-i`/`--include-task-name` and `-x`/`--exclude-task-name` glob
filters on the directory basename (`harbor/src/harbor/cli/jobs.py`):

```sh
cd akm-bench
harbor run -p harbor/tasks -a <agent> -m <model> ...                            # all 46
harbor run -p harbor/tasks -x 'reference--example-task' -a <agent> -m <model> ...  # 45, fixture excluded
```

**Decision (item 2's "decide and document"):** the flat `-p harbor/tasks`
scan intentionally includes `reference--example-task` by default — it is a
real, valid Harbor task (§7's worked example), and excluding it silently
would make `-p harbor/tasks`'s count disagree with the registry's train
count (27) for no documented reason. Operators who want the "real corpus
only" count the legacy driver used (`src/corpus.ts`'s `isExampleTaskDir`
excluded `_example/*` from statistics) pass `-x 'reference--example-task'`
explicitly, same convention, opt-in rather than silent. (There is only ever
one fixture task, so the exclude filter names it exactly rather than
globbing a prefix.) There is no `-p` equivalent of the registry's train/eval
split — reproducing a slice via `-p` means passing every task name in that
slice to `-i`, one at a time, which is the entire reason `registry.json`
exists (D10) rather than relying on `-p` alone.

### 9.2 Registry path resolution — verified, not assumed

`RegistryTaskId.path` (`harbor.models.registry`) becomes a `LocalTaskId`
whose `get_local_path()` is `self.path.expanduser().resolve()`
(`harbor/src/harbor/models/task/id.py`). `.resolve()` resolves against the
**process's current working directory at the moment Harbor loads the
task** — there is no rebasing against `registry.json`'s own directory
anywhere in `DatasetConfig._get_registry_task_configs`
(`harbor/src/harbor/models/job/config.py`): it passes `task_id.path`
straight into `TaskConfig(path=task_id.path, ...)` unchanged.

Verified by construction, both ways, from a Python process with
`cwd = akm-bench` (the repo root):

```
registry.json paths written as "tasks/<name>"        → resolve to <repo-root>/tasks/<name>        → does NOT exist (19/19, 27/27 invalid)
registry.json paths written as "harbor/tasks/<name>"  → resolve to <repo-root>/harbor/tasks/<name>  → Task.is_valid_dir() true (19/19, 27/27 valid)
```

`harbor/registry.json` therefore stores every path **repo-root-relative**
(`harbor/tasks/<name>`), and every `--registry-path harbor/registry.json`
invocation must run with `cwd` at the akm-bench repo root — the same
convention every other command in this guide already uses (`-p
harbor/tasks`), so this adds no new operator habit, it just means: don't
`cd harbor/` first.

### 9.3 The join key, precisely

`benchmark-harness-consolidation.md` §3.1 already established that
`task.toml [metadata]` never reaches `result.json`. What actually lands in
`result.json`'s `task_name` field, traced through source
(`harbor/src/harbor/trial/trial.py`: `TrialResult(task_name=self.task.name,
...)`), is `Task.name` — which for a task whose `task.toml` has a `[task]`
section (every converted task has one) is `self.config.task.name` **verbatim
from `task.toml`**, i.e. `akm-bench/<domain>--<taskid>` — the org-prefixed
form, not the bare directory basename `<domain>--<taskid>`.

Verified live across all 46 converted tasks:
`task_name.split("/", 1)[-1]` (strip the `akm-bench/` prefix) equals the
directory basename **exactly, with no exceptions** — the analysis layer can
always recover `domain`/`slice`/`difficulty`/etc. by stripping the org
prefix off `result.json`'s `task_name` and looking up that string as a
`harbor/tasks/` subdirectory.

**This wasn't always true, and the history is worth keeping because the
trap is easy to reintroduce.** `reference--example-task`'s domain
(`_example`) is the one domain in the corpus that starts with `_`, which
`ORG_NAME_PATTERN` (`harbor/src/harbor/constants.py`) forbids in the *name*
half of `[task].name` — so `[task].name` has always been
`"akm-bench/reference--example-task"`, underscore dropped, never
`"akm-bench/_example--example-task"`. The first conversion pass dropped the
underscore *only* there and kept it in the directory basename
(`_reference--example-task`), reasoning that the directory name should
preserve the real legacy identity. That reasoning was sound for
`metadata.legacy_task_id` (which does carry `_example/example-task`, and
should) and wrong for the directory basename: it made this the one task
in the whole corpus where `task_name.split("/", 1)[-1]`
(`"reference--example-task"`) didn't equal the directory basename
(`"_reference--example-task"`) — a permanent special case for every
consumer of `result.json.task_name`, existing solely to preserve
information `metadata.legacy_task_id` already preserves losslessly. Fixed
by renaming the directory to drop the underscore too, so the join key rule
above now has no exceptions and never needs one for this corpus. If a
future domain agent hits the same shape of problem (an org-prefix
constraint forces `[task].name` to differ from the obvious directory name),
resolve it the same way: change the directory basename to match
`[task].name`'s stripped form, not the other way around, and let
`legacy_task_id` carry whatever identity information that costs you.

For every other purpose — `-i`/`-x` glob filters (`-p` form),
`DatasetConfig.task_names` (registry form), and `RegistryTaskId.name` in
`harbor/registry.json` itself — the string in play is the bare directory
basename (`LocalTaskId.get_name()` = `self.path.expanduser().resolve().name`
for the `-p` form; the registry's own `name` field, which this conversion
set to the directory basename, for the registry form). Only the analysis
layer's read of `result.json.task_name` needs the prefix-stripping rule
above; every CLI-level task selector already matches on the plain basename
— and, now, so does the stripped `result.json.task_name`.

### 9.4 Real resolution counts (this session, Harbor v0.22.0)

| Mechanism | Query | Result |
| --- | --- | --- |
| Registry | `akm-tasks-train@1.0` via `harbor/registry.json` | 27/27 resolve to a `Task.is_valid_dir()`-true local path |
| Registry | `akm-tasks-eval@1.0` via `harbor/registry.json` | 19/19 resolve to a `Task.is_valid_dir()`-true local path |
| Flat `-p` | `DatasetConfig(path="harbor/tasks")`, no filter | 46/46 valid task dirs |
| Flat `-p` + exclude | same, `exclude_task_names=["reference--example-task"]` | 45/46 (fixture task dropped) |

No count differs from the plan's projected 27 train / 19 eval split — both
domain conversions landed exactly on target, and no domain agent flagged a
discrepancy.

### 9.5 No-oracle list

Every one of the 46 converted tasks ships a `solution/solve.sh`. Checked
functionally, not just for file presence: for each task, `solution/solve.sh`
was run inside a freshly seeded copy of `environment/workspace/` (an empty
directory for the one task with no workspace), then the task's real verifier
was run against the result exactly as it runs in Harbor — `tests/verify.sh`
for script-verified tasks, `pytest tests/` for pytest-verified ones — and its
exit code checked. This is §6 step 3's procedure, batched across the whole
corpus instead of one task at a time.

**Result: all 46/46 pass. The no-oracle list is empty.** No task in the
current corpus lacks a working oracle solution, and none of the previously
flagged trap cases (§2's `__file__`-path bug, §5's once-unresolvable
`inkwell/workflow-configure-scaling` gold_ref — now resolved, §3's
deliberately-underivable-without-akm `repeated-fail-opencode-provider-token`
pair) prevent their oracle from passing — the gold_ref/underivability issues
are about what a *baseline agent* can discover, not about whether a
solution exists that satisfies the verifier.

**`oracle == 1` is only half the check.** §10.1 adds the other half: the same
verifier must also score **0** against the pristine workspace. Five tasks
passed the oracle check here while silently failing that one — see §10.

---

## 10. Execution validation (the pass that runs everything)

Structural validation (§6) proves a task *parses*. It cannot tell you whether
the task *measures anything*. This section records the execution-validation
pass and the two rules it added.

### 10.1 The two-run rule

Every converted task must be run twice against its own real verifier, with no
Docker daemon involved:

| Run | `/app` seeded with | Required reward |
| --- | --- | --- |
| **pristine** | `environment/workspace/` exactly as the Dockerfile's `COPY workspace/ /app/` leaves it — no agent action at all | **0** |
| **oracle** | pristine, then `solution/solve.sh` applied | **1** |

`oracle == 1` alone is not enough. A task whose **pristine** run already scores
1 ships the answer in its own workspace: it is unfailable, contributes a
guaranteed +1 to both arms, and measures nothing. Eight legacy fixtures had
this shape; all eight now ship a workspace that scores 0 until the agent
acts — `az-cli/keyvault-secret-set`, `az-cli/query-by-tag`,
`opencode/agents-md-akm-snippet`, `opencode/select-correct-skill`,
`opencode/system-prompt-snippet`,
`workflow-compliance/abstention-rust-async-haiku`,
`workflow-compliance/feedback-trap-az-tag-list`, and
`workflow-compliance/repeated-fail-opencode-disable-provider`. Every one of
the eight carries a `NOTE` in its `environment/Dockerfile` explaining what
the legacy fixture shipped and why this conversion doesn't ship it — write
one on every task you fix this way (§8 step 6); the first pass on this
corpus fixed the fixture on all eight but only wrote the `NOTE` on five of
them, and the missing three had to be backfilled.

The docker-free rig is a small wrapper that (a) copies `environment/workspace/`
into a tmp `/app`, (b) copies `tests/` into a tmp `/tests` the way Harbor does,
(c) rewrites the two container-absolute paths in a *copy* of `tests/test.sh`
(`/logs` → tmp, `/tests` → tmp) and changes nothing else, and (d) supplies on
the host exactly what each `environment/Dockerfile` installs — stock `bash`,
`/usr/bin/jq` for the two tasks that apt-install it, and a venv pinned to the
same `pytest==8.4.1 pytest-json-ctrf==0.3.5 pyyaml` for the 17 pytest tasks.
Everything else about the container (base image, `WORKDIR`, layer caching) is
irrelevant to the reward and is *not* simulated. Current status: **46/46
pristine=0, oracle=1**; 17/17 pytest tasks also emit `/logs/verifier/ctrf.json`,
and no task writes `reward.json` — the reward is always the single `reward.txt`
float that Harbor's `_parse_reward_text` turns into `{"reward": <float>}` (D4).

### 10.2 The derivability rule

A converted task must also be *solvable by an agent*, not merely by
`solve.sh`. The check: diff the pristine `/app` against the post-oracle `/app`,
tokenize the added content, and confirm each distinctive token is visible
somewhere the agent can reach — `instruction.md`, the shipped workspace, or the
task's own stash. A token that appears in **none** of those is knowable only to
`solve.sh`, so every real trial in **both** arms scores 0 and the task is dead
weight.

One task failed this: `workflow-compliance--repeated-fail-opencode-disable-provider`.
Its verifier hard-requires the literal `shredder/qwen/qwen3.6-35b-a3b`, which
appears in no instruction, no workspace, and nowhere in the `noisy` stash
(`grep -r shredder harbor/stashes/noisy` → no hits). The legacy fixture hid this
by shipping a pre-solved `opencode.json`; removing that (rule 10.1) turned an
unfailable task into an unpassable one.

### 10.3 The seeded-workspace exception

`workflow-compliance--repeated-fail-opencode-disable-provider` is the **only**
task in the corpus whose `environment/workspace/` content was *authored* rather
than ported. It now ships a starting `config/opencode.json` that is
deliberately not a passing state but from which every value the verifier
checks is derivable:

- the `model` string — the file declares provider `shredder` with a single
  entry under `models`, and the `noisy` stash's opencode skill states that
  `model` is a provider-qualified `"<provider>/<model>"` string;
- `"openai": false` — the stash skill states a provider is disabled by setting
  it to `false`;
- `"apiKey": "{env:OPENAI_API_KEY}"` — the seed carries the shell-style
  `"$OPENAI_API_KEY"` spelling, and the stash skill states env placeholders
  must be kept in the `{env:NAME}` form. The env var *name* is visible in the
  seed; only the *form* has to be looked up.

That keeps the task's design intent (a repeated-failure trigger whose answer
lives in the stash, not the prompt) while making it winnable. The rationale is
repeated in full in the task's own `environment/Dockerfile` so it is not lost
if this document is. Do not extend this exception to other tasks without the
same evidence: a verifier-required literal that is provably invisible everywhere.

### 10.4 akm-referencing lines in workspace files: what actually shipped

The legacy workspaces carried three kinds of akm references, handled
differently — this section describes the SHIPPED tree (verified by grep), not
intermediate conversion passes:

1. **`workspace/AGENTS.md` files (5 tasks)** — pure akm-arm scaffolding ("You
   MUST run `akm search` before attempting the task"). **Dropped entirely** for
   arm neutrality. (In `opencode/agents-md-akm-snippet` and
   `opencode/select-correct-skill` that legacy file is also the task's own
   graded deliverable, and is now named `workspace/agent-guidance.md` — see
   §1's instruction-file note. It is still dropped.)
2. **`Use \`akm search ...\`` hint lines and retired-grammar commands
   (`akm show skill:inkwell`, `akm workflow next 'workflow:...'`) in READMEs
   (12 lines across docker-homelab and inkwell)** — **deleted, not rewritten.**
   No shipped `environment/` file contains an akm invocation in either grammar
   (grep returns zero hits). Deleting rather than rewriting keeps the two arms
   maximally symmetric: neither arm is told a tool exists.
3. **"Consult the `<domain>` skill for ..." prose (11 READMEs: drillbit ×7,
   inkwell ×4)** — **kept verbatim.** This is legacy-faithful (both arms saw it
   under the old driver, both see it now), but it points the baseline arm at a
   "skill" it cannot access. Whether these lines should also be deleted is a
   **design question for the corpus owner, not a conversion defect** — deleting
   them would change task difficulty relative to the legacy corpus, so the
   conversion preserved them and flags the question here.

Exception to (2): tasks whose GRADED SUBJECT MATTER is an akm command (the
`opencode` domain's `agents-md-akm-snippet`, and the
`workflow-compliance--repeated-fail-opencode-*` family whose verifier checks
for literal `akm-search-query:` / `akm-show-ref: skill:opencode` provenance
lines) keep those strings — there they are the deliverable, not scaffolding.
Note the `skill:opencode` literal is the retired 0.7 spelling, kept because the
verifier greps for it verbatim (legacy-faithful); an akm-arm agent may notice
real akm 0.9.1 rejects that spelling. Changing it means changing verifier and
instruction together — corpus-owner decision.

### 10.5 A repo-root `pytest` run collected the task verifiers — and died

Running bare `pytest` at the repo root aborted the **entire** suite:

```
!!!!!!!!!!!!!!!!!!! Interrupted: 17 errors during collection !!!!!!!!!!!!!!!!!!!
```

Every one was an `import file mismatch`: each converted
`harbor/tasks/<task>/tests/test_*.py` shares its module basename with the
unconverted twin still sitting at
`fixtures/corpus/tasks/<domain>/<task>/tests/test_*.py`, and with no
`__init__.py` in either tree pytest's rootdir-relative module naming collides
the two. Because these are *collection* errors, nothing in `harbor/tests/`
ran at all.

Fixed with `harbor/tasks/conftest.py` (`collect_ignore_glob =
["*/tests/test_*.py"]`). Task verifiers are container artifacts — Harbor copies
them to `/tests` and runs them with cwd `/app` — so collecting them from the
repo root is always wrong, with or without the basename collision. The conftest
sits one level **above** every task directory, so Harbor never copies it into a
container and `DatasetConfig._get_local_task_configs`'s one-level
`path.iterdir()` scan skips it (a file is not a valid task dir). Verified after
adding it: repo-root collection is clean (18 tests, 0 errors) and
`-p harbor/tasks` still resolves 46/46.

Also removed: `tests/.pytest_cache/` and `tests/__pycache__/`, present in all
17 pytest task dirs. They are git-ignored (`**/__pycache__/` in the root
`.gitignore`), so `git status` never showed them — but Harbor copies `tests/`
by filesystem, not by git, so they would have shipped into `/tests`. Any local
pytest run regenerates them; delete before committing.
