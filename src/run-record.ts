/**
 * akm-bench run-record serialization helpers (#249).
 *
 * This module breaks the metrics/report import cycle by holding the compact
 * persisted `runs[]` row shape shared by both domains.
 */

import type { TaskMetadata } from "./corpus";
import type { RunResult } from "./driver";
import type { PerAssetAttribution } from "./metrics/attribution";
import type { FailureModeAggregate } from "./metrics/failure-modes";
import type { CorpusDelta, CorpusMetrics, PerTaskMetrics } from "./metrics/outcome";
import type { GoldRankRunRecord, SearchBridgeMetrics } from "./metrics/search-bridge";
import type { TrajectoryAggregate } from "./trajectory";
import type { WorkflowCheckResult } from "./workflow-evaluator";

/**
 * Compact serialised RunResult row persisted into the §13.3 JSON envelope
 * under the top-level `runs[]` key (#249).
 *
 * One row per `(task, arm, seed)` execution, both `noakm` and `akm`. Contains
 * enough fields to recompute every aggregate metric (per-task, trajectory,
 * failure-mode, search-bridge, attribution) plus task metadata, but
 * deliberately omits the full `events[]` and unbounded `verifierStdout` so the
 * envelope stays compact. Older artefacts that pre-date this field are still
 * valid: callers that need run-level data should fall back to the per-task
 * aggregate path.
 */
export interface RunRecordSerialized {
  task_id: string;
  arm: string;
  seed: number;
  model: string;
  outcome: string;
  /**
   * Spread of `RunResult.tokens` so future fields flow through
   * automatically without a renderer change. Today the shape is
   * `{input: number, output: number}` with optional `measurement`.
   */
  tokens: Record<string, unknown>;
  /**
   * Per-run request/token telemetry captured by the driver.
   */
  request_metrics?: {
    total_requests: number;
    total_tokens: number;
    source: string;
    steps: Array<{
      request_index: number;
      input: number;
      output: number;
      total: number;
    }>;
  };
  wallclock_ms: number;
  verifier_exit_code: number;
  trajectory: {
    correct_asset_loaded: boolean | null;
    feedback_recorded: boolean | null;
  };
  assets_loaded: string[];
  failure_mode: string | null;
  termination_cause: string | null;
  first_error_line: string | null;
}

/**
 * Per-task envelope inside `tasks[]`. Mirrors the §13.3 layout: `noakm` and
 * `akm` are PerTaskMetrics, `delta` is the akm − noakm difference.
 */
export interface UtilityReportTaskEntry {
  id: string;
  noakm: PerTaskMetrics;
  akm: PerTaskMetrics;
  delta: CorpusDelta;
  /**
   * Per-task synthetic-arm metrics (#261). Present only on reports built by
   * `runUtility({ includeSynthetic: true, ... })`. When absent the per-task
   * row in the §13.3 envelope omits the `synthetic` key entirely so the
   * default two-arm envelope is byte-identical to the pre-#261 output.
   */
  synthetic?: PerTaskMetrics;
  /**
   * Optional workflow-compliance fraction `[0, 1]` for the akm arm (#255 +
   * #262). When present the corpus_coverage section folds it into the mean
   * compliance per `memory_ability` / `task_family` group.
   */
  workflowCompliance?: number;
}

/**
 * Top-level §13.3 input. The runner produces this; `renderUtilityReport`
 * stamps it into the canonical shape (snake-case keys, percentages, etc.).
 */
export interface UtilityRunReport {
  timestamp: string;
  branch: string;
  commit: string;
  model: string;
  corpus: {
    domains: number;
    tasks: number;
    slice: "all" | "train" | "eval";
    seedsPerArm: number;
    /**
     * Identity stamps used by `bench compare` to refuse cross-corpus diffs
     * (#250). All four are populated by `runUtility` at finalize time. Older
     * reports (pre-#250) lack these keys and degrade to a warning instead of
     * a refusal — see `compareReports`.
     */
    selectedTaskIds?: string[];
    taskCorpusHash?: string;
    fixtures?: Record<string, string>;
    fixtureContentHash?: string;
  };
  aggregateNoakm: CorpusMetrics;
  aggregateAkm: CorpusMetrics;
  aggregateDelta: CorpusDelta;
  /**
   * Synthetic-arm corpus aggregate (#261). Present only when `runUtility`
   * was called with `includeSynthetic: true`. Renderers gate every
   * synthetic-related output (`arms.synthetic`, `akm_over_synthetic_lift`,
   * markdown subsection) on the presence of this field so the default
   * two-arm envelope stays byte-identical to the pre-#261 shape.
   */
  aggregateSynth?: CorpusMetrics;
  trajectoryAkm: TrajectoryAggregate;
  /**
   * Failure-mode taxonomy aggregate (§6.6). Counts and per-task breakdown
   * across every failed akm-arm run in the corpus. Empty `byLabel` /
   * `byTask` when no runs failed.
   */
  failureModes: FailureModeAggregate;
  tasks: UtilityReportTaskEntry[];
  warnings: string[];
  /**
   * Per-asset attribution rows (§6.5). Populated by the runner; aggregated
   * across every akm-arm RunResult. Older artefacts without this field
   * remain valid (callers should default to an empty `{ rows: [], totalAkmRuns: 0 }`).
   */
  perAsset?: PerAssetAttribution;
  /**
   * Raw akm-arm RunResults retained on the report for in-process consumers
   * (the masked-corpus helper, attribution post-processing). NOT serialised
   * into the §13.3 JSON envelope — too large and not part of the locked
   * contract. The field is on the in-memory shape only.
   */
  akmRuns?: RunResult[];
  /**
   * Raw RunResults across both arms (`noakm` + `akm`), retained on the
   * report so `buildUtilityJson` can serialise the compact §13.3 `runs[]`
   * array (#249). Populated by the runner. When omitted, the envelope simply
   * does not gain a `runs` key — backward-compat with code paths that
   * construct a UtilityRunReport without raw runs.
   */
  allRuns?: RunResult[];
  /**
   * Task metadata for in-process consumers (the masked-corpus helper needs
   * to remap each task's stash to a tmp dir). Not serialised into the §13.3
   * envelope — the existing `tasks[]` carries the public per-task aggregates.
   */
  taskMetadata?: TaskMetadata[];
  /**
   * Per-(akm-arm, goldRef) gold-rank records. Populated by the runner; read
   * by `computeSearchBridge`. Empty when no corpus tasks carry a `goldRef`.
   */
  goldRankRecords?: GoldRankRunRecord[];
  /**
   * §6.7 search-pipeline bridge metrics. Always present on populated runs;
   * an "empty" SearchBridgeMetrics envelope renders as the N/A sentence.
   */
  searchBridge?: SearchBridgeMetrics;
  /**
   * Per-(akm-arm-run, spec) workflow compliance results (#257). Populated by
   * `runUtility` when at least one workflow spec applies. Aggregated into the
   * top-level `workflow` block at JSON-render time, and rendered as the
   * `## Workflow compliance` markdown section. Empty array (or missing field)
   * renders an empty `workflow` object — never crashes.
   */
  workflowChecks?: WorkflowCheckResult[];
  baselineByTaskId?: Record<string, number>;
}

/**
 * Project a RunResult onto its compact serialised form for the §13.3 JSON
 * envelope (#249). Mirrors the field list in the issue body.
 *
 * Token-shape seam: `tokens` is spread verbatim from `result.tokens` so when
 * #252 adds a `measurement` field the renderer doesn't need a code change.
 * Do NOT hardcode `{input, output}` projections here.
 */
export function serializeRunForReport(result: RunResult): RunRecordSerialized {
  return {
    task_id: result.taskId,
    arm: result.arm,
    seed: result.seed,
    model: result.model,
    outcome: result.outcome,
    // Token-shape seam: spread verbatim so any additional fields (e.g.
    // `measurement`) are carried forward without a renderer change.
    tokens: { ...result.tokens },
    ...(result.requestMetrics
      ? {
          request_metrics: {
            total_requests: result.requestMetrics.totalRequests,
            total_tokens: result.requestMetrics.totalTokens,
            source: result.requestMetrics.source,
            steps: result.requestMetrics.steps.map((step) => ({
              request_index: step.requestIndex,
              input: step.input,
              output: step.output,
              total: step.total,
            })),
          },
        }
      : {}),
    wallclock_ms: result.wallclockMs,
    verifier_exit_code: result.verifierExitCode,
    trajectory: {
      correct_asset_loaded: result.trajectory.correctAssetLoaded,
      feedback_recorded: result.trajectory.feedbackRecorded,
    },
    assets_loaded: [...(result.assetsLoaded ?? [])],
    failure_mode: result.failureMode ?? null,
    termination_cause: result.terminationCause ?? null,
    first_error_line: result.firstErrorLine ?? null,
  };
}
