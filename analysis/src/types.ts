/**
 * Shared type definitions for the akm-bench / akm-eval analysis layer
 * (implementation brief §6 / plan phase P1).
 *
 * These types describe the NORMALIZED per-trial record produced by
 * `loadJobs()` (`loader.ts`) and consumed by every downstream module
 * (`corpus.ts`, `stats.ts`, `report.ts`). They are deliberately decoupled
 * from Harbor's own pydantic models — Harbor's `TrialResult` JSON shape is
 * an internal implementation detail pinned at v0.22.0
 * (docs/plans/benchmark-harness-decisions.md D12), not a documented
 * contract. `loader.ts` is the ONLY module that reads raw Harbor JSON;
 * everything downstream works off `TrialRecord`.
 */

/** Token / cost accounting for one trial. Every field is null-safe: Harbor's
 * own `AgentContext` fields are all `Optional`, and a trial that errored
 * before the agent produced any usage has none of them. */
export interface TokenUsage {
  /** Total input tokens, INCLUDING cache reads (Harbor's own semantics — see `AgentContext.n_input_tokens`). */
  inputTokens: number | null;
  cacheTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
}

export interface TrialTimingWindow {
  startedAt: string | null;
  finishedAt: string | null;
}

/** Mirrors the four `TimingInfo` fields Harbor records at the trial level (`TrialResult`). */
export interface TrialTiming {
  environmentSetup: TrialTimingWindow | null;
  agentSetup: TrialTimingWindow | null;
  agentExecution: TrialTimingWindow | null;
  verifier: TrialTimingWindow | null;
}

export interface TrialProvenance {
  /** `TrialResult.task_checksum`. Empty string when Harbor's result omitted it (should not happen at v0.22.0, but never crash on it). */
  taskChecksum: string;
  /** `config.agent.kwargs` verbatim — the arm's full agent configuration (the load-bearing provenance field: this is how a job's `--ak ...` / `agents[].kwargs` actually resolved). */
  agentKwargs: Record<string, unknown>;
  /** `config.agent.import_path` — set when the job used a custom agent (e.g. `harbor.akm_opencode:AkmOpenCode`); null for a built-in agent referenced by `name` alone. */
  agentImportPath: string | null;
  /** `config.agent.env` — the per-trial env overlay. Harbor already redacts sensitive values before writing `result.json` (`templatize_sensitive_env`). */
  agentEnv: Record<string, string>;
}

/**
 * One row per Harbor trial (one direct child of `jobs/<job>/`).
 *
 * `arm` is DERIVED — see `deriveArm()` in `loader.ts` — and is never Harbor's
 * own `evals` grouping key (`{agent}__{model}__{dataset}`, built by
 * `JobStats.format_agent_evals_key`). That key is ambiguous whenever any
 * component itself contains `__`, and this codebase's own trial-name
 * generator (`<task[:32]>__<shortuuid7>`) is proof `__` is not a safe
 * separator here.
 */
export interface TrialRecord {
  /** Basename of `jobs/<job>/` — the job directory this trial was found under. */
  jobId: string;
  /** Basename of the trial directory (`<task[:32]>__<shortuuid7>` for a fresh trial). */
  trialName: string;
  /** Absolute path to the trial directory. */
  trialDir: string;
  /** `TrialResult.task_name`. The corpus join key (`corpus.ts`) is this value against a task dir's basename. */
  taskName: string;
  /** Derived arm label — see `deriveArm()`. */
  arm: string;
  agentName: string;
  agentVersion: string;
  modelName: string | null;
  modelProvider: string | null;
  /** `TrialResult.source` — the dataset/registry name Harbor ran this trial from, or null for an ad-hoc `-p <dir>` run. */
  source: string | null;
  /**
   * Every reward key Harbor's verifier reported, verbatim
   * (`verifier_result.rewards`). Null when the trial has no verifier result
   * at all (most commonly: it errored before verification ran).
   */
  rewards: Record<string, number> | null;
  /**
   * The canonical `"reward"` key (decision D4). Null when `rewards` is null
   * or has no `"reward"` entry — callers must never assume 0 for null; see
   * `stats.ts`'s explicit errored-trial policies for how 0-folding is done,
   * deliberately, in exactly two disclosed ways.
   */
  reward: number | null;
  /** `rewards` minus the canonical `"reward"` key. Empty object when there are no other keys (the common case under decision D4). */
  otherRewards: Record<string, number>;
  tokens: TokenUsage;
  /** True iff `TrialResult.exception_info` is present (the trial raised — e.g. Harbor's own `AkmPluginNotLoadedError` run-phase proof, or any setup/agent/verifier exception). */
  errored: boolean;
  /** `exception_info.exception_type`, e.g. `"AkmPluginNotLoadedError"`. Null when the trial did not error. */
  exceptionType: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  timing: TrialTiming;
  provenance: TrialProvenance;
}
