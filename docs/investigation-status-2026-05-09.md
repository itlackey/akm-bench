# Investigation Status (2026-05-09)

## Scope

- Continue detailed validation of evolve-transfer instability.
- Pin benchmark runs to published AKM `0.7.4` (not moving dev wrapper targets).
- Review issue [#4](https://github.com/itlackey/akm-bench/issues/4) and propose a simplification plan.

## Commands and Artifacts

- Focused evolve eval-only sweeps (`--tasks workflow-compliance/repeated-fail-opencode-provider-token-eval`) produced:
  - `/tmp/opencode/bench-report-evolve-main-2e8b6d7-2026-05-09T05-35-02.356Z-shredder-qwen-qwen3.6-35b-a3b.json`
  - `/tmp/opencode/bench-report-evolve-main-2e8b6d7-2026-05-09T05-40-00.742Z-shredder-qwen-qwen3.6-35b-a3b.json`
- Full evolve-transfer sweeps (all 3 tasks):
  - `/tmp/opencode/bench-report-evolve-main-2e8b6d7-2026-05-09T05-47-50.232Z-shredder-qwen-qwen3.6-35b-a3b.json`
  - `/tmp/opencode/bench-report-evolve-main-2e8b6d7-2026-05-09T05-55-30.666Z-shredder-qwen-qwen3.6-35b-a3b.json`
- Pinned AKM 0.7.4 evolve transfer run:
  - command: `bun run src/cli.ts config/evolve-transfer-opencode.json --seeds 3 --json --akm-mode version --akm-version 0.7.4 --results-dir /tmp/opencode`
  - artifact: `/tmp/opencode/bench-report-evolve-main-2e8b6d7-2026-05-09T07-52-03.241Z-shredder-qwen-qwen3.6-35b-a3b.json`
- Pinned AKM 0.7.4 + explicit shredder config run:
  - command: `bun run src/cli.ts config/evolve-transfer-opencode-shredder.json --seeds 1 --json --akm-mode version --akm-version 0.7.4 --results-dir /tmp/opencode`
  - artifact: `/tmp/opencode/bench-report-evolve-main-2e8b6d7-2026-05-09T08-12-42.209Z-shredder-qwen-qwen3.6-35b-a3b.json`
- Budget matrix (shredder + AKM 0.7.4, seeds=1):
  - `budgetWallMs=120000` (config `evolve-transfer-opencode-shredder.json`):
    - artifact: `/tmp/opencode/bench-report-evolve-main-2e8b6d7-2026-05-09T17-10-57.963Z-shredder-qwen-qwen3.6-35b-a3b.json`
  - `budgetWallMs=180000` (config `evolve-transfer-opencode-shredder-b180.json`):
    - artifact: `/tmp/opencode/bench-report-evolve-main-2e8b6d7-2026-05-09T17-49-31.904Z-shredder-qwen-qwen3.6-35b-a3b.json`
  - `budgetWallMs=240000` (config `evolve-transfer-opencode-shredder-b240.json`):
    - artifact: `/tmp/opencode/bench-report-evolve-main-2e8b6d7-2026-05-09T17-57-30.562Z-shredder-qwen-qwen3.6-35b-a3b.json`
- Updated canonical shredder config baseline run (`budgetWallMs=240000` in `config/evolve-transfer-opencode-shredder.json`):
  - artifact: `/tmp/opencode/bench-report-evolve-main-2e8b6d7-2026-05-09T18-42-02.972Z-shredder-qwen-qwen3.6-35b-a3b.json`
- Default timeout change + rerun:
  - defaults updated to 10 minutes (`600000` ms) in runner/evolve/CLI defaults.
  - canonical shredder config updated to `budgetWallMs=600000`.
  - artifact: `/tmp/opencode/bench-report-evolve-main-2e8b6d7-2026-05-09T21-06-17.953Z-shredder-qwen-qwen3.6-35b-a3b.json`
- Additional pinned reruns with phase-timing instrumentation enabled:
  - all-negative train profile (`per_ref_feedback: positive=0, negative=2`, `refs_to_evolve=[skill:opencode]`):
    - `results/bench-report-evolve-main-2e8b6d7-2026-05-10T00-21-39.915Z-shredder-qwen-qwen3.6-35b-a3b.json`
    - `results/bench-report-evolve-main-2e8b6d7-2026-05-10T00-38-50.668Z-shredder-qwen-qwen3.6-35b-a3b.json`
  - mixed train profile (`per_ref_feedback: positive=1, negative=1`, `refs_to_evolve=[]`):
    - `results/bench-report-evolve-main-2e8b6d7-2026-05-10T00-40-59.581Z-shredder-qwen-qwen3.6-35b-a3b.json`
    - `results/bench-report-evolve-main-2e8b6d7-2026-05-10T00-42-28.280Z-shredder-qwen-qwen3.6-35b-a3b.json`

## Latest Findings

### 1) Termination diagnostics now validate assumptions

- New `runs[]` fields (`termination_cause`, `first_error_line`) consistently classify run endings.
- In non-timeout runs, causes align with verifier outcomes (`completed` for pass, `verifier_failed` for fail).
- In timeout-heavy runs, cause is explicitly `agent_timeout` with stable first error line.

### 2) Prior mixed failures were confounded by AKM command-surface drift

- Some earlier evolve runs emitted warnings showing Phase 2 command mismatch:
  - `Unknown command distill`
  - `Unknown command reflect`
  - `Unknown command proposal`
- This indicates a runtime mismatch between expected evolve command surface and whichever AKM binary was active in those runs.

### 3) With AKM pinned to published `0.7.4`, failures in this environment are primarily timeout-driven

- In pinned run `/tmp/opencode/bench-report-evolve-main-2e8b6d7-2026-05-09T07-52-03.241Z-shredder-qwen-qwen3.6-35b-a3b.json`:
  - `pre`: 3/3 `budget_exceeded`, cause `agent_timeout`
  - `post`: 3/3 `budget_exceeded`, cause `agent_timeout`
  - `synthetic`: 3/3 `budget_exceeded`, cause `agent_timeout`
- Warning evidence in same report:
  - `phase2.reflect_retry_timeout ...`
  - `phase2: akm reflect ... timed out after 300000ms`

### 4) Current instability attribution (updated)

- Dominant current failure mode under pinned `0.7.4`: runtime timeout pressure (`agent_timeout`), not schema/parser ambiguity.
- This means pre/post lift interpretation is currently low-confidence unless timeout pressure is reduced or budgets/provider throughput are adjusted.

### 5) Shredder + AKM 0.7.4 validation status

- Added explicit shredder config pair for reproducible pinned runs:
  - `config/opencode.shredder.json`
  - `config/evolve-transfer-opencode-shredder.json`
- Confirmed the evolve run executes with model `shredder/qwen/qwen3.6-35b-a3b` while pinned to AKM `0.7.4`.
- In this environment, pre/post/synthetic still hit `budget_exceeded` with `termination_cause=agent_timeout`, which validates runtime wiring and highlights remaining timeout pressure as the current blocker.

### 6) BudgetWallMs matrix result (120k / 180k / 240k)

- At `120000` ms: pre/post/synthetic were all `budget_exceeded` with `termination_cause=agent_timeout`.
- At `180000` ms: pre/post/synthetic were still all `budget_exceeded` with `termination_cause=agent_timeout`.
- At `240000` ms: timeout pressure cleared on eval-phase arms:
  - pre: `pass` (`completed`)
  - post: `pass` (`completed`)
  - synthetic: `fail` (`verifier_failed`), no timeout

Interpretation:

- For current shredder + AKM `0.7.4` runs in this task family, `budgetWallMs` must be near `240000` to avoid timeout-dominated evolve evals.
- 120s and 180s are below the practical knee-point and produce unreliable evolve comparisons.
- Single-seed reruns remain variable even at 240s; one baseline rerun at the new canonical config still produced `agent_timeout` across pre/post/synthetic. This indicates a wider runtime-variance component in addition to pure budget threshold effects.
- Even with a 10-minute default (`600000` ms), timeout pressure persists on pre/post for this environment/run (`agent_timeout` at 600s), while synthetic can still fail quickly via verifier (`verifier_failed`).

### 7) Phase-level diagnostics after Phase 2 isolation/retry changes

- Recent pinned runs split into two clear behavior classes:
  - **Class A (all-negative train signal)**: `refs_to_evolve=[skill:opencode]` triggers full Phase 2 (`distill` + `reflect`) and can still be slow/unstable.
  - **Class B (mixed train signal)**: `refs_to_evolve=[]` skips heavy proposal generation work and keeps Phase 2 overhead near-zero.
- Representative timings from pinned runs:
  - Class A worst case: `phase2.elapsed_ms=540709`, total `1504844` ms with reflect attempts `~240s + ~300s` and `agent_timeout` across all eval arms.
  - Class A improved case: `phase2.elapsed_ms=360303`, total `1024029` ms; eval arms complete (`pre/post pass`, `synthetic verifier_failed`) without arm timeout.
  - Class B steady cases: `phase2.elapsed_ms` around `123-140` ms, total around `83-92s`, with `pre/post pass` and `synthetic verifier_failed`.
- Interpretation:
  - Timeout risk now correlates strongly with whether Phase 1 produces all-negative feedback (which enables expensive reflect).
  - Added phase-level and per-command timing instrumentation is sufficient to attribute this bottleneck without ambiguous parser/schema explanations.
  - Practical policy implication: maintain pinned AKM `0.7.4`, keep Phase 2 gating explicit, and evaluate outcomes over replicate distributions instead of single-run snapshots.

## Issue #4 Review (Configuration/Fixture Simplification)

Issue reviewed: [#4](https://github.com/itlackey/akm-bench/issues/4)

Three plan variants were debated:

- **Runtime materialization from shared boilerplate (recommended)**
  - Add central `fixtures/boilerplate/` templates.
  - Extend task metadata with optional workspace boilerplate selector.
  - Materialize boilerplate at workspace seed time; task-local files override boilerplate.
  - Pros: least fixture drift/churn, incremental migration, low contributor overhead.

- **Build-time generated sync**
  - Keep task fixtures materialized on disk via `fixtures:sync` + CI drift check.
  - Pros: runtime remains simple, fully explicit fixture tree.
  - Cons: larger generated diffs/churn on template updates.

- **Minimal inheritance/templates approach**
  - Add light profile/template inheritance to reduce duplication without major orchestration.
  - Pros: low blast radius.
  - Cons: weaker long-term dedupe than full boilerplate materialization.

### Recommended plan

Proceed with runtime materialization first, phased:

1. Add optional boilerplate metadata + copy precedence tests.
2. Migrate repeated `workspace/AGENTS.md` clusters first.
3. Expand to other duplicated boilerplate files only where proven safe.

## Configuration Change Applied

- Updated `config/opencode.local.json` to LM Studio localhost + Qwen 3.5 9B defaults:
  - model: `local/qwen/qwen3.5-9b`
  - provider key: `local`
  - base URL: `http://127.0.0.1:1234/v1`

## Next Actions

1. Keep evolve investigations pinned with `--akm-mode version --akm-version 0.7.4` until command-surface compatibility checks are automated.
2. Run replicate sweeps for each shredder config variant (`phase2 on/off`, `240k/600k`) and compare distributions of `phase_timings.phase2.elapsed_ms`, `total_elapsed_ms`, and arm-level `termination_cause`.
3. If all-negative train slices remain frequent, tighten or simplify reflect retry policy further to cap worst-case Phase 2 wall time.
4. Implement issue #4 using the runtime boilerplate plan with strict precedence and migration guardrails.
