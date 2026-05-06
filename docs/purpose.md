# akm-bench — Status, Gaps, and Definition of Done

This document captures where `akm-bench` is today, what it's missing relative to its strategic role, and what "done" looks like for the v1.0 of the repo. Companion document: [akm-eval-status.md](./akm-eval-status.md).

## Strategic role

`akm-bench` produces **the numbers nothing else in the ecosystem can produce**. It exists because akm has properties no public benchmark measures: per-asset attribution (which skill/script/lesson actually contributed to an outcome) and self-improvement over time (does an agent equipped with akm get better at a task family across runs as akm absorbs lessons via `feedback → reflect → propose → distill`?).

Where `akm-eval` answers "does akm hold up against established baselines?", `akm-bench` answers "what does akm uniquely *do*?"

This makes akm-bench the higher-stakes repo of the two. akm-eval's headline number is a credibility floor. akm-bench's headline number is the actual akm value proposition, expressed numerically. If akm-bench works and produces the temporal-improvement number, the rest of the akm story becomes much easier to tell.

---

## Gap Analysis

### Current state

**Built and shipped:**
- TypeScript/Bun project, CLI at `src/cli.ts`
- Docker wrapper at `bin/akm-bench`
- opencode-driven, with `--akm-mode installed|source|version` for testing the baked image, local checkouts, or published AKM builds
- Static utility benchmarking with multi-seed support: `akm`, `noakm`, and optional `synthetic` arms on the same fixture set
- `compare` subcommand for diffing two saved reports
- `attribute` subcommand for per-asset attribution — which akm assets contributed to which outcomes
- `evolve` subcommand implementing the longitudinal feedback/distill/reflect/re-evaluate loop
- Built-in first-party corpus under `fixtures/corpus/tasks/` spanning multiple domains, plus custom fixtures via `--fixtures-dir`
- Versioned reference-suite definition in `fixtures/reference/v1/README.md` plus canonical config at `config/reference-suite-v1.json`
- Workflow-compliance, failure-mode, search-bridge, overhead, token-coverage, and negative-transfer reporting in the utility report envelope
- Multi-seed and parallelism support
- Sample configs (`config/nano-quick.json`, `config/full.json`, `config/failing-tasks.json`, `config/curate-test.json`)
- Reference workflow, attribution schema, and lesson lifecycle docs in `docs/`
- CI on every push and PR via `.github/workflows/ci.yml`
- Local model support (LM Studio, Ollama)

**Repository status:**
- 22 commits, 0 stars, non-empty `results/`
- MPL-2.0 license
- opencode is the only supported agent runner

### Strategic gaps

These are the gaps between current state and akm-bench's strategic role. Closing these is what turns the repo from "a useful A/B harness" into "the source of akm's most important numbers."

**1. The temporal self-improvement loop exists in code and is now documented, but it still lacks published reference outputs.**

This is the single most important gap. The akm-bench differentiator — the number nothing else can produce — is the delta across this protocol:

- **Run 1 (cold):** agent has akm but no accumulated lessons. Runs the canonical task suite.
- **Self-improvement step:** akm runs `feedback → reflect → propose → distill` over the run-1 transcripts. Resulting lessons are accepted into the stash.
- **Run 2 (warm):** same agent + akm + new lessons. Runs the same task suite.
- **Output:** delta(warm, cold), with attribution showing which lessons came from run-1 transcripts and which of those fired in run-2.

What's currently in the repo is both *static utility benchmarking* and an implemented `evolve` track, but the temporal track is still strategically underexposed:

- It is now surfaced in `README.md` and backed by `docs/reference-workflow.md` and `docs/lesson-lifecycle.md`.
- It still does not have published reference outputs, so outsiders still cannot cite or reproduce the headline number.

The visibility problem is largely solved. The remaining strategic gap is publication and reproducibility of the headline temporal result.

**2. The repo now has a versioned reference-suite definition, but not published reference scores.**

The repo already ships a substantial first-party corpus in `fixtures/corpus/tasks/` and now has a frozen reference-suite definition in `fixtures/reference/v1/README.md` plus canonical config in `config/reference-suite-v1.json`. What is still missing is the documented score and published artifacts so "akm-bench reference suite v1, model X, score Y" becomes a stable thing people can cite.

Without a canonical suite, any number akm-bench produces is unverifiable and any claim built on it is suspect.

**3. opencode is the only supported agent runner.**

Same concern as akm-eval. If akm's pitch is runner-agnostic, the benchmark should be too. At least one alternate runner (Claude Code or a generic OpenAI-compatible adapter) needs to exist for v1.0. Otherwise akm-bench's results carry an asterisk: "akm-bench measures akm + opencode," not "akm."

### Tactical gaps

- No published reference results for a versioned canonical suite
- All three protocol docs shipped (`docs/protocol-static-ab.md`, `docs/protocol-attribution.md`, `docs/protocol-temporal.md`)
- Result schemas verified against docs; all three report types match their contracts
- CI runs `bun run check` plus deterministic CLI smoke against `config/reference-suite-v1.json`
- Same MPL-2.0 license question as akm-eval

### Cross-repo gaps (shared with akm-eval)

- No published reference results in either repo
- opencode coupling in both
- Same MPL-2.0 license question

### Priority order

1. **Surface and document the temporal self-improvement loop.** Highest leverage by a wide margin. The code exists, but without first-class docs and reference outputs, akm-bench still undersells its most important differentiator.
2. **Publish reference results for the canonical suite.** The reference-suite definition now exists; what is missing is the documented score and checked-in artifacts.
3. Publish first reference run on the canonical suite.
4. Add a second agent runner.
5. Document the `attribute` output schema as a public contract.

---

## Definition of Done

akm-bench is "done" when it produces a number that nothing else in the agent-tooling ecosystem can produce, and that number is reproducible by an outsider.

### Required benchmark protocols

Three protocols, each with documented output:

**1. Static A/B** ✅ (already shipped)

With-akm vs without-akm on a fixed corpus, same model, same time. Output: delta + per-seed variance. Useful as a baseline and as a sanity check.

**2. Per-asset attribution** ✅ (shipped, now documented)

For each successful task, which akm assets fired and contributed to the outcome. Output schema must be documented in `docs/attribution-schema.md` so consumers can build on it.

**3. Temporal self-improvement** (implemented, documented, but not yet published as a reference result)

Two-run protocol with a self-improvement step in between, as described in the gap analysis. Specific requirements:

- Multiple seeds per stage (cold, warm) so the warm-cold delta can be checked against within-condition variance
- Statistical guard: the warm-cold delta must exceed 2× the within-condition standard deviation to count as "improvement detected." Anything weaker is reported as "indistinguishable from noise" — explicitly, not silently.
- Lessons-trace output: for each task in run-2, which lessons (proposed in the self-improvement step) fired during execution, and which of those came from which run-1 transcripts. This closes the attribution loop end-to-end.
- Reproducibility: same seeds + same model + same lesson-acceptance policy → same delta.

### Required canonical fixture set

- Versioned reference-suite definition in `fixtures/reference/v1/`, with a documented canonical task list and settings
- Tasks span at least three categories (file manipulation, shell automation, simple code transforms — the exact categories matter less than the diversity)
- Each task has documented success criteria and an **automated evaluator** — no LLM-judge for the canonical suite. LLM judges are appropriate for akm-eval where they match third-party protocol; akm-bench's reference suite needs deterministic grading because the temporal protocol's statistical guard depends on it.
- Versioned (`fixtures/reference/v1/`, `v2/`, etc.) so future expansions don't invalidate published comparisons
- Reference scores published in `results/reference/v1/` for at least one model on each protocol

### Required infrastructure

- At least two supported agent runners (opencode + one other)
- Documented output schema for all three protocols, in `docs/`
- Where applicable, schema-compatible output with akm-eval — at minimum, shared model/seed/commit-SHA fields so cross-repo dashboards become possible
- CI running on every PR, with deterministic CLI smoke path for the canonical suite
- Reproducible Docker image with version-pinned akm and runner versions

### Required documentation

- First-class benchmark docs in `README.md`, `docs/reference-workflow.md`, and protocol-specific docs for each benchmark
- Fixture authoring guide (`docs/custom-benchmarks.md` already exists — keep current)
- Lesson lifecycle documentation: what `feedback/reflect/propose/distill` actually does to the stash, with worked examples (`docs/lesson-lifecycle.md`)
- Reference-suite README at `fixtures/reference/v1/README.md` documenting the canonical scores, the model used, and the conditions

### Required published results

- One full reference run per protocol on the canonical fixture set, in `results/reference/`
- A blog post or technical writeup with the temporal-loop numbers — this is the headline result for the entire akm story and deserves its own writeup, not just a row in a results table
- Results checked into `results/reference/`, labeled with model + commit SHA + date

### Quality gates

- The temporal protocol's "improvement" must be statistically distinguishable from seed noise (the 2× rule above). Reports that don't meet this bar are explicitly labeled "no improvement detected" rather than reported as small positive numbers.
- Attribution output is machine-readable and documented; consumers can build dashboards on it without reverse-engineering the format.
- Fixture evaluators are deterministic. Run the same task with the same agent output → same score, every time.
- The canonical suite is versioned and immutable within a version. New tasks go into v2; v1's score stays comparable forever.

### Non-goals (explicit)

- **Will not run third-party benchmarks.** SWE-Bench, LongMemEval, BEAM, etc. live in akm-eval. akm-bench is for akm-specific protocols only.
- **Will not benchmark *agents*.** akm-bench measures akm's effect on agents. The agent runner is a fixed dependency; akm is the variable. If the agent runner gets better, that improves all of akm-bench's baselines uniformly — it doesn't change the akm-vs-no-akm or warm-vs-cold deltas, which is the whole point.
- **Will not provide a hosted leaderboard.** Reference results are git-versioned; comparison is somebody else's problem.
- **Will not implement its own LLM client, vector store, or memory backend.** akm-bench drives akm and an agent runner; both are external dependencies.
- **Will not use LLM judges for the canonical suite.** The temporal protocol's statistical guard requires deterministic grading. LLM judges are fine for custom user-supplied fixtures where the user accepts the variance; the canonical suite has stricter requirements.
- **Will not declare improvement on small or noisy deltas.** A 1% warm-cold delta with 3% within-condition standard deviation is not improvement; it is noise. The repo will say so plainly rather than report a number that looks like a result.

### Out of scope for v1.0

Valuable but explicitly deferred:

- More than two agent runners
- Web UI for browsing attribution traces
- Multi-agent / agent-collaboration benchmarks
- Cross-task lesson transfer measurement (lessons from task family A improving task family B) — this is the v2 differentiator, after temporal self-improvement on a single family is proven
- Cost / token accounting per-asset (would let attribution scoring weight by cost, which is interesting but not required)

---

## Consensus implementation plan

After reviewing the repo against this document, the shortest credible path to finishing `akm-bench` is not to add broad new platform surface area. It is to package, document, and publish the strongest parts of what already exists.

### What the review team agreed on

- `akm-bench` already has the core implementation for all three strategic ideas: static utility measurement, per-asset attribution, and temporal self-improvement via `evolve`.
- The highest-value work left is productization: make the temporal loop first-class, freeze a canonical reference suite, publish reference artifacts, and add the minimum guardrails required to defend the results.
- The repo should explicitly treat `opencode` as the v1 runner. A second runner is valuable, but it is not the simplest or highest-leverage way to complete v1.
- The reference suite should be a curated selection of existing deterministic tasks, not a large new fixture-authoring project.

### Recommended v1 scope

- One supported runner: `opencode`
- One versioned canonical suite: `fixtures/reference/v1/`
- Three published protocol outputs: static utility, attribution, temporal evolve
- One statistical guard on temporal claims so reports can say either "improvement detected" or "no improvement detected"
- Minimal CI that protects the harness from regression

### Phase 1: Freeze the reference suite

- Create `fixtures/reference/v1/README.md`
- Select 8-12 existing deterministic tasks from `fixtures/corpus/tasks/`
- Ensure the selection spans at least three categories or domains
- Document the exact task IDs, verifier types, seeds, and immutability policy

This should reuse the current corpus rather than duplicating tasks into a new tree unless duplication is required for versioning clarity.

### Phase 2: Make the temporal loop first-class

- Add first-class `README.md` coverage for the `evolve` workflow
- Add a compact reference workflow doc covering static, attribution, and temporal runs end-to-end
- Add a sample reference config for the canonical suite
- Make the operator story clear: utility is the baseline, attribution explains asset contribution, and `evolve` is the differentiating benchmark

### Phase 3: Add the minimum temporal statistics guard

- Extend evolve reporting with the warm-cold delta and within-condition variance summary
- Implement the existing 2x-noise rule from this document
- Emit an explicit interpretation field so the result is labeled either `improvement_detected` or `no_improvement_detected`

This is the minimum needed to keep temporal claims defensible without turning v1 into a larger research project.

### Phase 4: Publish reference artifacts

- Add `results/reference/v1/`
- Check in one canonical static utility run
- Check in one canonical attribution artifact derived from that utility run
- Check in one canonical temporal evolve run
- Add a `results/reference/v1/SUMMARY.md` file with model, seeds, commit SHA, date, exact commands, and headline numbers

This is the step that turns `akm-bench` from an internal harness into a citable benchmark.

### Phase 5: Add minimal CI protection

- Add `.github/workflows/ci.yml`
- Run `bun run check` on every PR
- If feasible, add the smallest deterministic smoke path that exercises report generation without requiring a heavyweight live-model benchmark

### Deliverables for v1

- `fixtures/reference/v1/README.md`
- Reference run config(s) for the canonical suite
- `docs/reference-workflow.md`
- `docs/attribution-schema.md`
- `docs/lesson-lifecycle.md`
- Updated `README.md` with first-class `evolve` coverage
- Temporal report output that includes the noise/significance guard
- `results/reference/v1/utility-*.json`
- `results/reference/v1/attribute-*.json`
- `results/reference/v1/evolve-*.json`
- `results/reference/v1/SUMMARY.md`
- `.github/workflows/ci.yml`

### Explicit deferrals

These are worthwhile, but they should not block v1:

- A second agent runner
- Deep schema convergence with `akm-eval`
- A hosted dashboard or attribution UI
- A blog post or launch writeup as a release gate
- Transcript-granular lesson provenance beyond what is needed for the v1 temporal report
