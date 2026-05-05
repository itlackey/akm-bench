/**
 * akm-bench AKM overhead metrics (#263).
 */

import type { TaskMetadata } from "../corpus";
import type { RunResult } from "../driver";
import { normalizeRunToTrace, type WorkflowTraceEvent, type WorkflowTraceEventType } from "../workflow-trace";

// ── AKM overhead + tool-use efficiency (#263) ──────────────────────────────

/**
 * Per-run AKM overhead record (#263).
 *
 * Counts and timings derived from a single RunResult by reusing #254's
 * `normalizeRunToTrace`. Counts are always numeric (≥ 0). Timings and byte
 * sizes are `null` when the run did not provide enough evidence to compute
 * them — they are NEVER zero-filled, because zero is a meaningful value
 * (e.g. "first search at t=0ms") that would silently mask missing data.
 *
 * Definitions:
 * - `searchCount` / `showCount` / `feedbackCount`: count of `akm_search`,
 *   `akm_show`, and `akm_feedback` events in the normalised trace.
 * - `totalToolCalls`: sum of the three counts above. The minimal
 *   "AKM tool-use" footprint we surface today; if/when we recognise more
 *   verbs as tool-calls (`akm_reflect`, `akm_distill`, `akm_propose`,
 *   `akm_proposal_accept`) they will be folded in here additively.
 * - `assetsLoadedCount`: count of UNIQUE assetRefs from `akm_show` events.
 * - `irrelevantAssetsLoadedCount`: count of unique `akm_show` assetRefs that
 *   are NOT the task's `goldRef` AND NOT in `expectedTransferFrom`. When the
 *   task has neither metadata field, every loaded asset is considered
 *   irrelevant for accounting — there is no way to know what was relevant.
 *   When the task is unknown to the caller (no metadata supplied) the count
 *   is `null` rather than zero, since we cannot judge relevance.
 * - `timeToFirstSearchMs`: `(ts of first akm_search) - (run start ts)`. Run
 *   start is the earliest parseable `ts` in the trace. `null` when no
 *   `akm_search` event has a parseable ts, or when no run-start anchor
 *   exists.
 * - `timeToFirstCorrectAssetMs`: `(ts of first akm_show whose assetRef
 *   matches goldRef) - (run start ts)`. `null` when the task has no
 *   `goldRef`, no matching show event was found, or timestamps are missing.
 * - `contextBytesLoaded` / `assetBytesLoaded`: byte sizes of context /
 *   loaded assets. Not currently captured by the trace; always `null` until
 *   evidence is wired through. Documented here as a contract: callers MUST
 *   treat `null` as "unavailable" and never assume zero.
 */
export interface AkmOverheadPerRun {
  taskId: string;
  arm: string;
  seed: number;
  outcome: RunResult["outcome"];
  searchCount: number;
  showCount: number;
  feedbackCount: number;
  /** Count of `akm feedback --positive` invocations in this run. */
  positiveFeedbackCount: number;
  /** Count of `akm feedback --negative` invocations in this run. */
  negativeFeedbackCount: number;
  totalToolCalls: number;
  assetsLoadedCount: number;
  /** `null` when relevance cannot be judged (no task metadata supplied). */
  irrelevantAssetsLoadedCount: number | null;
  /** ms; `null` when unavailable (NOT zero). */
  timeToFirstSearchMs: number | null;
  /** ms; `null` when unavailable (NOT zero). */
  timeToFirstCorrectAssetMs: number | null;
  /** Bytes; `null` when unavailable (NOT zero). */
  contextBytesLoaded: number | null;
  /** Bytes; `null` when unavailable (NOT zero). */
  assetBytesLoaded: number | null;
}

/**
 * Aggregate AKM overhead block emitted into the §13.3 utility envelope (#263).
 *
 * `meanAssetsLoaded` etc. are means over `runs.length` (not "runs that loaded
 * something"); zero-call runs contribute zeros to the numerator. This keeps
 * the aggregate comparable across arms regardless of how many runs actually
 * touched AKM.
 *
 * Cross-run timings (`meanTimeToFirstSearchMs`, etc.) skip per-run `null`s
 * — a missing timing must not silently pull the mean toward zero. When NO
 * run provided a timing the aggregate value is `null`.
 *
 * `toolCallsPerSuccess` = `totalToolCalls / passingRuns`. `null` when no
 * runs passed (avoids `Infinity`). `costPerSuccess` is `null` unless every
 * passing run has parsed token measurement — partial coverage yields
 * `null` because mixed measurement statuses cannot be averaged honestly.
 */
export interface AkmOverheadAggregate {
  totalRuns: number;
  passingRuns: number;
  meanSearchCount: number;
  meanShowCount: number;
  meanFeedbackCount: number;
  meanToolCalls: number;
  meanAssetsLoaded: number;
  meanIrrelevantAssetsLoaded: number | null;
  meanTimeToFirstSearchMs: number | null;
  meanTimeToFirstCorrectAssetMs: number | null;
  meanContextBytesLoaded: number | null;
  meanAssetBytesLoaded: number | null;
  /** `totalToolCalls` summed across runs. */
  totalToolCalls: number;
  /** `totalToolCalls / passingRuns`. `null` when `passingRuns === 0`. */
  toolCallsPerSuccess: number | null;
  /**
   * Mean (input+output) tokens across passing runs whose `tokenMeasurement`
   * is `"parsed"`. `null` when:
   * - `passingRuns === 0`, OR
   * - any passing run lacks parsed token measurement (mixing parsed with
   *   missing/unsupported is dishonest), OR
   * - none of the passing runs has `tokenMeasurement === "parsed"`.
   */
  costPerSuccess: number | null;
  /** Fraction of runs (0–1) that invoked `akm search` at least once. */
  searchEngagementRate: number;
  /** Fraction of runs (0–1) that invoked `akm show` at least once. */
  showEngagementRate: number;
  /** Fraction of runs (0–1) that invoked `akm feedback` at least once. */
  feedbackEngagementRate: number;
  /**
   * `showSum / searchSum` across all runs. `null` when no run invoked search
   * (avoids division by zero). Values < 1 indicate agents that search but never
   * load; values > 1 indicate multi-load-per-search behaviour.
   */
  searchToShowRatio: number | null;
  meanPositiveFeedbackCount: number;
  meanNegativeFeedbackCount: number;
}

/**
 * Optional inputs for `computeAkmOverhead`.
 *
 * `taskMetadata` is consulted to compute `irrelevantAssetsLoadedCount` and
 * `timeToFirstCorrectAssetMs`. Callers that do not have task metadata to
 * hand can omit it; the per-run record will degrade gracefully (relevant
 * fields become `null`). The map is keyed by `taskId`.
 */
export interface AkmOverheadOptions {
  /** Lookup of task metadata used for relevance / gold-ref scoring. */
  taskMetadata?: ReadonlyMap<string, Pick<TaskMetadata, "goldRef" | "expectedTransferFrom">>;
}

/**
 * Verb counts considered "AKM tool calls" for `totalToolCalls`. We
 * deliberately keep this list small — each verb folded in MUST be a
 * user-initiated CLI invocation, not a background bookkeeping event.
 * Adding new verbs here is additive and changes only `totalToolCalls`.
 */
export const AKM_TOOL_CALL_TYPES: ReadonlySet<WorkflowTraceEventType> = new Set<WorkflowTraceEventType>([
  "akm_search",
  "akm_show",
  "akm_feedback",
]);

/**
 * Compute per-run AKM overhead records by replaying #254's normalised trace.
 *
 * Pure function: never mutates `runs` and never reads disk. The optional
 * `taskMetadata` lookup is used only to label loads as relevant / irrelevant
 * and to compute `timeToFirstCorrectAssetMs`.
 *
 * Returned array length matches `runs.length`; element order matches input
 * order. Runs whose trace contains no AKM events still produce a record
 * with all counts at zero and timings at `null`.
 */
export function computeAkmOverhead(
  runs: ReadonlyArray<RunResult>,
  options: AkmOverheadOptions = {},
): AkmOverheadPerRun[] {
  const out: AkmOverheadPerRun[] = [];
  for (const run of runs) {
    out.push(perRun(run, options.taskMetadata));
  }
  return out;
}

function perRun(run: RunResult, taskMetadata: AkmOverheadOptions["taskMetadata"]): AkmOverheadPerRun {
  const trace = normalizeRunToTrace(run);
  const events = trace.events;

  let searchCount = 0;
  let showCount = 0;
  let feedbackCount = 0;
  let positiveFeedbackCount = 0;
  let negativeFeedbackCount = 0;
  const uniqueShowRefs = new Set<string>();

  for (const ev of events) {
    if (ev.type === "akm_search") searchCount += 1;
    else if (ev.type === "akm_show") {
      showCount += 1;
      if (typeof ev.assetRef === "string" && ev.assetRef.length > 0) {
        uniqueShowRefs.add(ev.assetRef);
      }
    } else if (ev.type === "akm_feedback") {
      feedbackCount += 1;
      // Polarity is carried in args as "--positive" or "--negative".
      // Events sourced from events.jsonl also have args populated by
      // normalizeRunToTrace. Absence of both flags is treated as unknown
      // (contributes to feedbackCount but not to either polarity counter).
      if (ev.args?.includes("--positive")) positiveFeedbackCount += 1;
      else if (ev.args?.includes("--negative")) negativeFeedbackCount += 1;
    }
  }
  const totalToolCalls = searchCount + showCount + feedbackCount;

  // Run-start anchor: earliest parseable ts in the trace. We use the trace
  // (not RunResult.events directly) so harness lifecycle markers, when
  // supplied, can serve as the anchor for stdout-derived events that lack a
  // native ts.
  const runStartMs = earliestEventMs(events);

  const timeToFirstSearchMs = computeFirstEventOffsetMs(events, runStartMs, (ev) => ev.type === "akm_search");

  // Resolve task metadata once. Missing metadata means we can't judge
  // relevance — emit null counts rather than zero.
  const meta = taskMetadata?.get(run.taskId);
  const goldRef = meta?.goldRef;
  const transferFrom = meta?.expectedTransferFrom ?? [];
  const knownRelevant = new Set<string>();
  if (typeof goldRef === "string" && goldRef.length > 0) knownRelevant.add(goldRef);
  for (const r of transferFrom) {
    if (typeof r === "string" && r.length > 0) knownRelevant.add(r);
  }

  let irrelevantAssetsLoadedCount: number | null;
  if (!meta) {
    // No metadata: cannot tell relevant from irrelevant. Surface null.
    irrelevantAssetsLoadedCount = null;
  } else {
    let count = 0;
    for (const ref of uniqueShowRefs) {
      if (!knownRelevant.has(ref)) count += 1;
    }
    irrelevantAssetsLoadedCount = count;
  }

  let timeToFirstCorrectAssetMs: number | null = null;
  if (typeof goldRef === "string" && goldRef.length > 0) {
    timeToFirstCorrectAssetMs = computeFirstEventOffsetMs(
      events,
      runStartMs,
      (ev) => ev.type === "akm_show" && ev.assetRef === goldRef,
    );
  }

  return {
    taskId: run.taskId,
    arm: run.arm,
    seed: run.seed,
    outcome: run.outcome,
    searchCount,
    showCount,
    feedbackCount,
    positiveFeedbackCount,
    negativeFeedbackCount,
    totalToolCalls,
    assetsLoadedCount: uniqueShowRefs.size,
    irrelevantAssetsLoadedCount,
    timeToFirstSearchMs,
    timeToFirstCorrectAssetMs,
    // Byte sizes are not yet wired through the trace (#254 does not capture
    // payload sizes). Callers MUST treat null as "unavailable", not zero.
    contextBytesLoaded: null,
    assetBytesLoaded: null,
  };
}

/**
 * Aggregate per-run AKM overhead records into the corpus-wide block (#263).
 *
 * Pure: never mutates `perRun`. When `perRun` is empty, returns a zero/null
 * envelope so callers can render a "no AKM activity" section without
 * branching. `passingRuns === 0` always implies `toolCallsPerSuccess === null`
 * and `costPerSuccess === null`.
 */
export function aggregateAkmOverhead(
  perRun: ReadonlyArray<AkmOverheadPerRun>,
  rawRuns: ReadonlyArray<RunResult> = [],
): AkmOverheadAggregate {
  const n = perRun.length;
  if (n === 0) {
    return {
      totalRuns: 0,
      passingRuns: 0,
      meanSearchCount: 0,
      meanShowCount: 0,
      meanFeedbackCount: 0,
      meanToolCalls: 0,
      meanAssetsLoaded: 0,
      meanIrrelevantAssetsLoaded: null,
      meanTimeToFirstSearchMs: null,
      meanTimeToFirstCorrectAssetMs: null,
      meanContextBytesLoaded: null,
      meanAssetBytesLoaded: null,
      totalToolCalls: 0,
      toolCallsPerSuccess: null,
      costPerSuccess: null,
      searchEngagementRate: 0,
      showEngagementRate: 0,
      feedbackEngagementRate: 0,
      searchToShowRatio: null,
      meanPositiveFeedbackCount: 0,
      meanNegativeFeedbackCount: 0,
    };
  }

  let searchSum = 0;
  let showSum = 0;
  let feedbackSum = 0;
  let toolCallsSum = 0;
  let assetsSum = 0;

  let irrelevantSum = 0;
  let irrelevantCount = 0;

  let firstSearchSum = 0;
  let firstSearchCount = 0;
  let firstCorrectSum = 0;
  let firstCorrectCount = 0;

  let contextBytesSum = 0;
  let contextBytesCount = 0;
  let assetBytesSum = 0;
  let assetBytesCount = 0;

  // Build a quick lookup for token measurement off `rawRuns` so the cost-
  // per-success calc can honour the parsed/missing/unsupported distinction
  // without forcing the caller to project tokens onto AkmOverheadPerRun.
  const rawByKey = new Map<string, RunResult>();
  for (const r of rawRuns) {
    rawByKey.set(`${r.taskId} ${r.arm} ${r.seed}`, r);
  }

  let passingRuns = 0;
  let parsedPassTokenSum = 0;
  let parsedPassCount = 0;
  let anyPassMissingMeasurement = false;

  let searchEngagedRuns = 0;
  let showEngagedRuns = 0;
  let feedbackEngagedRuns = 0;
  let positiveFeedbackSum = 0;
  let negativeFeedbackSum = 0;

  for (const row of perRun) {
    searchSum += row.searchCount;
    showSum += row.showCount;
    feedbackSum += row.feedbackCount;
    toolCallsSum += row.totalToolCalls;
    assetsSum += row.assetsLoadedCount;

    if (row.searchCount > 0) searchEngagedRuns += 1;
    if (row.showCount > 0) showEngagedRuns += 1;
    if (row.feedbackCount > 0) feedbackEngagedRuns += 1;
    positiveFeedbackSum += row.positiveFeedbackCount;
    negativeFeedbackSum += row.negativeFeedbackCount;

    if (row.irrelevantAssetsLoadedCount !== null) {
      irrelevantSum += row.irrelevantAssetsLoadedCount;
      irrelevantCount += 1;
    }
    if (row.timeToFirstSearchMs !== null) {
      firstSearchSum += row.timeToFirstSearchMs;
      firstSearchCount += 1;
    }
    if (row.timeToFirstCorrectAssetMs !== null) {
      firstCorrectSum += row.timeToFirstCorrectAssetMs;
      firstCorrectCount += 1;
    }
    if (row.contextBytesLoaded !== null) {
      contextBytesSum += row.contextBytesLoaded;
      contextBytesCount += 1;
    }
    if (row.assetBytesLoaded !== null) {
      assetBytesSum += row.assetBytesLoaded;
      assetBytesCount += 1;
    }

    if (row.outcome === "pass") {
      passingRuns += 1;
      const raw = rawByKey.get(`${row.taskId} ${row.arm} ${row.seed}`);
      // Treat absent tokenMeasurement as `parsed` for backward compat with
      // older artefacts (mirrors `isMeasured` behaviour above).
      const measurement = raw?.tokenMeasurement ?? "parsed";
      if (raw && measurement === "parsed") {
        parsedPassTokenSum += raw.tokens.input + raw.tokens.output;
        parsedPassCount += 1;
      } else if (raw) {
        anyPassMissingMeasurement = true;
      } else {
        // No matching raw run supplied — cannot honour cost-per-success.
        anyPassMissingMeasurement = true;
      }
    }
  }

  const toolCallsPerSuccess = passingRuns === 0 ? null : toolCallsSum / passingRuns;
  // Cost-per-success: null unless EVERY passing run has parsed measurement.
  // Mixed measurement statuses cannot be averaged honestly (issue #252).
  const costPerSuccess =
    passingRuns === 0 || anyPassMissingMeasurement || parsedPassCount === 0
      ? null
      : parsedPassTokenSum / parsedPassCount;

  const searchToShowRatio = searchSum === 0 ? null : showSum / searchSum;

  return {
    totalRuns: n,
    passingRuns,
    meanSearchCount: searchSum / n,
    meanShowCount: showSum / n,
    meanFeedbackCount: feedbackSum / n,
    meanToolCalls: toolCallsSum / n,
    meanAssetsLoaded: assetsSum / n,
    meanIrrelevantAssetsLoaded: irrelevantCount === 0 ? null : irrelevantSum / irrelevantCount,
    meanTimeToFirstSearchMs: firstSearchCount === 0 ? null : firstSearchSum / firstSearchCount,
    meanTimeToFirstCorrectAssetMs: firstCorrectCount === 0 ? null : firstCorrectSum / firstCorrectCount,
    meanContextBytesLoaded: contextBytesCount === 0 ? null : contextBytesSum / contextBytesCount,
    meanAssetBytesLoaded: assetBytesCount === 0 ? null : assetBytesSum / assetBytesCount,
    totalToolCalls: toolCallsSum,
    toolCallsPerSuccess,
    costPerSuccess,
    searchEngagementRate: searchEngagedRuns / n,
    showEngagementRate: showEngagedRuns / n,
    feedbackEngagementRate: feedbackEngagedRuns / n,
    searchToShowRatio,
    meanPositiveFeedbackCount: positiveFeedbackSum / n,
    meanNegativeFeedbackCount: negativeFeedbackSum / n,
  };
}

/** Earliest parseable ts (ms epoch) among events; null when none. */
function earliestEventMs(events: ReadonlyArray<WorkflowTraceEvent>): number | null {
  let earliest: number | null = null;
  for (const ev of events) {
    const ms = parseTsToMs(ev.ts);
    if (ms === null) continue;
    if (earliest === null || ms < earliest) earliest = ms;
  }
  return earliest;
}

/**
 * Find the first event matching `predicate`, parse its ts, and return
 * `(ts - runStartMs)`. Returns `null` if no matching event has a parseable
 * ts, if `runStartMs` is null, or if the offset would be negative (a clock
 * inversion we refuse to silently coerce to zero).
 */
function computeFirstEventOffsetMs(
  events: ReadonlyArray<WorkflowTraceEvent>,
  runStartMs: number | null,
  predicate: (ev: WorkflowTraceEvent) => boolean,
): number | null {
  if (runStartMs === null) return null;
  for (const ev of events) {
    if (!predicate(ev)) continue;
    const ms = parseTsToMs(ev.ts);
    if (ms === null) continue;
    const offset = ms - runStartMs;
    if (offset < 0) return null;
    return offset;
  }
  return null;
}

/** Parse an ISO ts to ms-epoch; null when missing or unparseable. */
function parseTsToMs(ts: string | undefined): number | null {
  if (typeof ts !== "string" || ts.length === 0) return null;
  const ms = Date.parse(ts);
  if (Number.isNaN(ms)) return null;
  return ms;
}
