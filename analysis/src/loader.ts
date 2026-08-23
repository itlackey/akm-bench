/**
 * Trial loader (implementation brief §6 / plan phase P1): walk a Harbor jobs
 * directory and produce normalized `TrialRecord` rows.
 *
 * Layout this reads (verified against Harbor v0.22.0 source — see
 * docs/plans/benchmark-harness-decisions.md D12 and
 * docs/plans/benchmark-harness-consolidation.md §3.1, and the VERIFIED HARBOR
 * RESULT CONTRACT this module was built against):
 *
 *   <jobsDir>/<job>/result.json          <- JobResult SUMMARY. NEVER read for
 *                                            trial data: Harbor writes it with
 *                                            `exclude_trial_results=True`
 *                                            (`harbor/job.py`), so
 *                                            `trial_results` is never on disk
 *                                            at the job level.
 *   <jobsDir>/<job>/lock.json            <- JobLock. Carries `harbor.version`;
 *                                            read by `report.ts`, not here.
 *   <jobsDir>/<job>/<trial>/result.json  <- TrialResult. ONE per trial. Trial
 *                                            dirs are DIRECT children of the
 *                                            job dir (`TrialPaths.result_path`
 *                                            is `trial_dir / "result.json"`,
 *                                            and `trial_dir` is never nested
 *                                            under a further job-owned
 *                                            subdirectory).
 *
 * `<jobsDir>` may itself contain more than one job (multiple `harbor run`
 * invocations pointed at the same parent directory) — every direct
 * subdirectory is walked as a candidate job, and every direct subdirectory of
 * THAT which contains a readable `result.json` is walked as a candidate
 * trial. Anything else (stray files, a job dir with no trials yet) is
 * skipped, not an error.
 *
 * This module is deliberately the ONLY place that parses raw Harbor JSON.
 * Every field access below is defensive (Harbor's own schema marks most of
 * these fields `Optional`) — a malformed or unexpectedly-shaped
 * `result.json` produces a warning via `onWarning`, never a thrown
 * exception, so one bad trial can never abort a whole-corpus analysis run.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { TokenUsage, TrialProvenance, TrialRecord, TrialTiming, TrialTimingWindow } from "./types";

/**
 * Derive the A/B grouping key for a trial.
 *
 * Deliberately NOT Harbor's own `evals` key
 * (`JobStats.format_agent_evals_key`: `{agent}__{model}__{dataset}` or
 * `{agent}__{dataset}`), which is ambiguous whenever any component itself
 * contains `__` — and this repo's own Harbor-generated trial names
 * (`<task[:32]>__<shortuuid7>`) are proof `__` shows up in the wild. `//` is
 * used as the model separator here for the same reason: an agent name or
 * version containing `@` is far more Harbor-idiomatic (`opencode-ai@1.18.21`
 * lives inside `AgentInfo.version`) than one containing `//`.
 *
 * Three components, each load-bearing:
 *
 * 1. `agentName@agentVersion` — `AgentInfo.name` / `.version`.
 * 2. The model, rebuilt as `provider/name`. VERIFIED against Harbor v0.22.0:
 *    `BaseAgent.to_agent_info()` splits `model_name` on the first `/` and
 *    stores the halves SEPARATELY — `ModelInfo.name` is the BARE model and
 *    `ModelInfo.provider` the prefix. Rebuilding `provider/name` here is what
 *    keeps `anthropic/claude-sonnet-4-5` and `bedrock/claude-sonnet-4-5` from
 *    sharing one arm label, and what keeps the provider in the published
 *    provenance manifest at all (brief §6): the arm label is the only place
 *    the rendered report names a model.
 * 3. A short digest of `config.agent.kwargs`, appended only when that object
 *    is non-empty.
 *
 * Component 3 is not decoration. Harbor's agent identity is `(name, version)`
 * and nothing else, so two arms of the SAME custom agent that differ only in
 * their kwargs report byte-identical `agent_info`. The akm-static vs
 * akm-accumulating pair in `harbor/jobs/tb2-ab.yaml` and
 * `harbor/jobs/swebench-ab.yaml` — identical but for `shared_bundle_path` —
 * is exactly that case, and decision D7 of
 * docs/plans/benchmark-harness-decisions.md forbids pooling them ("do not
 * pool it with the static arm"). Without the digest they collapse into one
 * row whose mean describes neither arm. Folding it in makes "same arm label
 * ⇒ same resolved agent config" a structural invariant instead of a warning
 * printed underneath an already-wrong number.
 *
 * `AkmOpenCode` additionally reports a distinct `agent_info.name` for the
 * accumulating arm (`akm-opencode-accumulating`), which fixes the same
 * collision inside Harbor's OWN artifacts. This digest is the belt to that
 * braces: it also covers results produced before that change, and any future
 * kwarg (`stash_root`, `akm_plugin_spec`, `seed_library_dir`, ...) that
 * changes an arm without changing its name.
 */
export function deriveArm(
  agentName: string,
  agentVersion: string,
  modelName: string | null,
  modelProvider: string | null = null,
  agentKwargs: Record<string, unknown> = {},
): string {
  const model = modelName === null ? "none" : modelProvider ? `${modelProvider}/${modelName}` : modelName;
  const base = `${agentName}@${agentVersion}//${model}`;
  return Object.keys(agentKwargs).length === 0 ? base : `${base}#${agentKwargsDigest(agentKwargs).slice(0, 8)}`;
}

/** Recursively sort object keys so a digest is invariant under field reordering. */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) out[key] = sortKeysDeep(record[key]);
    return out;
  }
  return value;
}

/**
 * A short, stable digest of an arm's `config.agent.kwargs` — sorted-keys JSON
 * so field reordering never changes it. Truncated to 16 hex chars: this is a
 * change-detection fingerprint, not a security digest. `deriveArm()` appends
 * the first 8 of those to the arm label; `report.ts` prints all 16 in its
 * provenance block.
 */
export function agentKwargsDigest(kwargs: Record<string, unknown>): string {
  const stable = JSON.stringify(sortKeysDeep(kwargs));
  return createHash("sha256").update(stable).digest("hex").slice(0, 16);
}

export interface LoadJobsOptions {
  /**
   * Called once per trial (or job) directory that could not be turned into a
   * `TrialRecord` — an unreadable/unparseable `result.json`, or one missing
   * the fields a record cannot be built without. Default: warnings are
   * swallowed. Callers that want disclosure (see `report.ts`) should pass a
   * collector.
   */
  onWarning?: (message: string) => void;
}

/**
 * Walk `jobsDir` and return every trial found as a `TrialRecord`.
 *
 * Returns `[]` (never throws) when `jobsDir` does not exist — callers degrade
 * the same way `corpus.ts` and the legacy `src/corpus.ts` do for a missing
 * corpus directory.
 */
export function loadJobs(jobsDir: string, options: LoadJobsOptions = {}): TrialRecord[] {
  const warn = options.onWarning ?? (() => {});
  const records: TrialRecord[] = [];
  if (!isDirectory(jobsDir)) return records;

  for (const jobId of listSubdirectories(jobsDir)) {
    const jobDir = path.join(jobsDir, jobId);
    for (const trialName of listSubdirectories(jobDir)) {
      const trialDir = path.join(jobDir, trialName);
      const resultPath = path.join(trialDir, "result.json");
      if (!fs.existsSync(resultPath)) continue; // not a trial dir (e.g. a `steps/` or scratch dir)

      let raw: unknown;
      try {
        raw = JSON.parse(fs.readFileSync(resultPath, "utf8"));
      } catch (err) {
        warn(`${resultPath}: could not read/parse result.json (${errorMessage(err)})`);
        continue;
      }

      const record = parseTrialResult(raw, { jobId, trialName, trialDir });
      if (!record) {
        warn(
          `${resultPath}: not a recognizable Harbor TrialResult (missing task_name / agent_info.name / agent_info.version)`,
        );
        continue;
      }
      records.push(record);
    }
  }
  return records;
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function listSubdirectories(dir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ── Defensive JSON extraction ────────────────────────────────────────────
// Harbor's own field is Optional in the pydantic model but this module never
// trusts that the JSON on disk agrees — every accessor below tolerates a
// missing key, a null, or a value of the wrong type.

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** `verifier_result.rewards` is `dict[str, float | int] | null` on the Python side; drop any non-numeric entries defensively rather than propagating a `NaN`. */
function asNumberRecord(value: unknown): Record<string, number> | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const out: Record<string, number> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry === "number" && Number.isFinite(entry)) out[key] = entry;
  }
  return out;
}

function asStringRecord(value: unknown): Record<string, string> {
  const record = asRecord(value);
  if (!record) return {};
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry === "string") out[key] = entry;
  }
  return out;
}

function asTimingWindow(value: unknown): TrialTimingWindow | null {
  const record = asRecord(value);
  if (!record) return null;
  return {
    startedAt: asNullableString(record.started_at),
    finishedAt: asNullableString(record.finished_at),
  };
}

interface TokenTotals {
  inputTokens: number | null;
  cacheTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
}

/** Read one `AgentContext`-shaped object (`n_input_tokens` / `n_cache_tokens` / `n_output_tokens` / `cost_usd`). */
function readAgentContext(value: unknown): TokenTotals {
  const record = asRecord(value);
  if (!record) return { inputTokens: null, cacheTokens: null, outputTokens: null, costUsd: null };
  return {
    inputTokens: asNullableNumber(record.n_input_tokens),
    cacheTokens: asNullableNumber(record.n_cache_tokens),
    outputTokens: asNullableNumber(record.n_output_tokens),
    costUsd: asNullableNumber(record.cost_usd),
  };
}

/**
 * Fallback token/cost aggregation for multi-step trials, mirroring Harbor's
 * own `TrialResult.compute_token_cost_totals`: single-step trials record one
 * `AgentContext` at `agent_result`; multi-step trials never populate that and
 * instead record one per step at `step_results[i].agent_result`. A field is
 * summed across steps that reported it and left null only when NO step
 * reported it at all — never coerced to 0.
 *
 * Reward and `errored` are read from the TRIAL-level `verifier_result` /
 * `exception_info` only (not per-step) — this loader targets the
 * single-step `opencode run` trials this benchmark actually produces (see
 * docs/harbor-p0.md); multi-step support here is limited to not silently
 * dropping token/cost data, not full per-step fidelity.
 */
function aggregateStepTokenTotals(stepResults: unknown): TokenTotals {
  const totals: TokenTotals = { inputTokens: null, cacheTokens: null, outputTokens: null, costUsd: null };
  if (!Array.isArray(stepResults)) return totals;

  let sawInput = false;
  let sawCache = false;
  let sawOutput = false;
  let sawCost = false;
  for (const step of stepResults) {
    const stepRecord = asRecord(step);
    if (!stepRecord) continue;
    const ctx = readAgentContext(stepRecord.agent_result);
    if (ctx.inputTokens !== null) {
      totals.inputTokens = (totals.inputTokens ?? 0) + ctx.inputTokens;
      sawInput = true;
    }
    if (ctx.cacheTokens !== null) {
      totals.cacheTokens = (totals.cacheTokens ?? 0) + ctx.cacheTokens;
      sawCache = true;
    }
    if (ctx.outputTokens !== null) {
      totals.outputTokens = (totals.outputTokens ?? 0) + ctx.outputTokens;
      sawOutput = true;
    }
    if (ctx.costUsd !== null) {
      totals.costUsd = (totals.costUsd ?? 0) + ctx.costUsd;
      sawCost = true;
    }
  }
  if (!sawInput) totals.inputTokens = null;
  if (!sawCache) totals.cacheTokens = null;
  if (!sawOutput) totals.outputTokens = null;
  if (!sawCost) totals.costUsd = null;
  return totals;
}

interface TrialLocation {
  jobId: string;
  trialName: string;
  trialDir: string;
}

/**
 * Parse one `result.json` payload into a `TrialRecord`. Returns `undefined`
 * when the payload is missing the identity fields a record cannot exist
 * without (`task_name`, `agent_info.name`, `agent_info.version`) — every
 * other field degrades to null/empty rather than rejecting the trial.
 */
export function parseTrialResult(raw: unknown, location: TrialLocation): TrialRecord | undefined {
  const root = asRecord(raw);
  if (!root) return undefined;

  const taskName = asString(root.task_name);
  const agentInfo = asRecord(root.agent_info);
  const agentName = agentInfo ? asString(agentInfo.name) : undefined;
  const agentVersion = agentInfo ? asString(agentInfo.version) : undefined;
  if (!taskName || !agentName || !agentVersion) return undefined;

  const modelInfo = agentInfo ? asRecord(agentInfo.model_info) : undefined;
  const modelName = modelInfo ? asNullableString(modelInfo.name) : null;
  const modelProvider = modelInfo ? asNullableString(modelInfo.provider) : null;

  const config = asRecord(root.config);
  const agentConfig = config ? asRecord(config.agent) : undefined;
  const provenance: TrialProvenance = {
    taskChecksum: asString(root.task_checksum) ?? "",
    agentKwargs: (agentConfig ? asRecord(agentConfig.kwargs) : undefined) ?? {},
    agentImportPath: agentConfig ? asNullableString(agentConfig.import_path) : null,
    agentEnv: agentConfig ? asStringRecord(agentConfig.env) : {},
  };

  const verifierResult = asRecord(root.verifier_result);
  const rewards = verifierResult ? (asNumberRecord(verifierResult.rewards) ?? null) : null;
  const reward = rewards && typeof rewards.reward === "number" ? rewards.reward : null;
  const otherRewards: Record<string, number> = {};
  if (rewards) {
    for (const [key, value] of Object.entries(rewards)) {
      if (key !== "reward") otherRewards[key] = value;
    }
  }

  const exceptionInfo = asRecord(root.exception_info);
  const errored = exceptionInfo !== undefined;
  const exceptionType = exceptionInfo ? (asString(exceptionInfo.exception_type) ?? "UnknownException") : null;

  // Single-step trials: `agent_result` at the trial root. Multi-step trials
  // leave that null and record per-step contexts instead — see
  // `aggregateStepTokenTotals`.
  const topLevelContext = readAgentContext(root.agent_result);
  const hasTopLevelUsage =
    topLevelContext.inputTokens !== null ||
    topLevelContext.cacheTokens !== null ||
    topLevelContext.outputTokens !== null ||
    topLevelContext.costUsd !== null;
  const tokenTotals = hasTopLevelUsage ? topLevelContext : aggregateStepTokenTotals(root.step_results);
  const tokens: TokenUsage = {
    inputTokens: tokenTotals.inputTokens,
    cacheTokens: tokenTotals.cacheTokens,
    outputTokens: tokenTotals.outputTokens,
    costUsd: tokenTotals.costUsd,
  };

  const timing: TrialTiming = {
    environmentSetup: asTimingWindow(root.environment_setup),
    agentSetup: asTimingWindow(root.agent_setup),
    agentExecution: asTimingWindow(root.agent_execution),
    verifier: asTimingWindow(root.verifier),
  };

  return {
    jobId: location.jobId,
    trialName: location.trialName,
    trialDir: location.trialDir,
    taskName,
    arm: deriveArm(agentName, agentVersion, modelName, modelProvider, provenance.agentKwargs),
    agentName,
    agentVersion,
    modelName,
    modelProvider,
    source: asNullableString(root.source),
    rewards,
    reward,
    otherRewards,
    tokens,
    errored,
    exceptionType,
    startedAt: asNullableString(root.started_at),
    finishedAt: asNullableString(root.finished_at),
    timing,
    provenance,
  };
}
