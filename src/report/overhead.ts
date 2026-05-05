/**
 * akm-bench AKM overhead report block (#263).
 */

import type { TaskMetadata } from "../corpus";
import {
  type AkmOverheadAggregate,
  type AkmOverheadPerRun,
  aggregateAkmOverhead,
  computeAkmOverhead,
} from "../metrics/overhead";
import type { UtilityRunReport } from "../run-record";

// ── AKM overhead block (#263) ──────────────────────────────────────────────

/**
 * Build the §13.3 `akm_overhead` block from the akm-arm RunResults and (when
 * supplied) per-task metadata. `taskMetadata` lets us split irrelevant from
 * relevant asset loads and compute time-to-first-correct-asset; without it
 * those fields surface as `null` rather than misleading zeros.
 */
export function buildAkmOverheadBlock(input: UtilityRunReport): {
  per_run: ReturnType<typeof serialiseAkmOverheadPerRun>[];
  aggregate: ReturnType<typeof serialiseAkmOverheadAggregate>;
} {
  const akmRuns = input.akmRuns ?? [];
  const meta = new Map<string, Pick<TaskMetadata, "goldRef" | "expectedTransferFrom">>();
  for (const t of input.taskMetadata ?? []) {
    meta.set(t.id, { goldRef: t.goldRef, expectedTransferFrom: t.expectedTransferFrom });
  }
  const perRun = computeAkmOverhead(akmRuns, { taskMetadata: meta });
  const aggregate = aggregateAkmOverhead(perRun, akmRuns);
  return {
    per_run: perRun.map(serialiseAkmOverheadPerRun),
    aggregate: serialiseAkmOverheadAggregate(aggregate),
  };
}

function serialiseAkmOverheadPerRun(row: AkmOverheadPerRun): {
  task_id: string;
  arm: string;
  seed: number;
  outcome: string;
  search_count: number;
  show_count: number;
  feedback_count: number;
  positive_feedback_count: number;
  negative_feedback_count: number;
  total_tool_calls: number;
  assets_loaded_count: number;
  irrelevant_assets_loaded_count: number | null;
  time_to_first_search_ms: number | null;
  time_to_first_correct_asset_ms: number | null;
  context_bytes_loaded: number | null;
  asset_bytes_loaded: number | null;
} {
  return {
    task_id: row.taskId,
    arm: row.arm,
    seed: row.seed,
    outcome: row.outcome,
    search_count: row.searchCount,
    show_count: row.showCount,
    feedback_count: row.feedbackCount,
    positive_feedback_count: row.positiveFeedbackCount,
    negative_feedback_count: row.negativeFeedbackCount,
    total_tool_calls: row.totalToolCalls,
    assets_loaded_count: row.assetsLoadedCount,
    irrelevant_assets_loaded_count: row.irrelevantAssetsLoadedCount,
    time_to_first_search_ms: row.timeToFirstSearchMs,
    time_to_first_correct_asset_ms: row.timeToFirstCorrectAssetMs,
    context_bytes_loaded: row.contextBytesLoaded,
    asset_bytes_loaded: row.assetBytesLoaded,
  };
}

function serialiseAkmOverheadAggregate(agg: AkmOverheadAggregate): {
  total_runs: number;
  passing_runs: number;
  mean_search_count: number;
  mean_show_count: number;
  mean_feedback_count: number;
  mean_tool_calls: number;
  mean_assets_loaded: number;
  mean_irrelevant_assets_loaded: number | null;
  mean_time_to_first_search_ms: number | null;
  mean_time_to_first_correct_asset_ms: number | null;
  mean_context_bytes_loaded: number | null;
  mean_asset_bytes_loaded: number | null;
  total_tool_calls: number;
  tool_calls_per_success: number | null;
  cost_per_success: number | null;
  search_engagement_rate: number;
  show_engagement_rate: number;
  feedback_engagement_rate: number;
  search_to_show_ratio: number | null;
  mean_positive_feedback_count: number;
  mean_negative_feedback_count: number;
} {
  return {
    total_runs: agg.totalRuns,
    passing_runs: agg.passingRuns,
    mean_search_count: agg.meanSearchCount,
    mean_show_count: agg.meanShowCount,
    mean_feedback_count: agg.meanFeedbackCount,
    mean_tool_calls: agg.meanToolCalls,
    mean_assets_loaded: agg.meanAssetsLoaded,
    mean_irrelevant_assets_loaded: agg.meanIrrelevantAssetsLoaded,
    mean_time_to_first_search_ms: agg.meanTimeToFirstSearchMs,
    mean_time_to_first_correct_asset_ms: agg.meanTimeToFirstCorrectAssetMs,
    mean_context_bytes_loaded: agg.meanContextBytesLoaded,
    mean_asset_bytes_loaded: agg.meanAssetBytesLoaded,
    total_tool_calls: agg.totalToolCalls,
    tool_calls_per_success: agg.toolCallsPerSuccess,
    cost_per_success: agg.costPerSuccess,
    search_engagement_rate: agg.searchEngagementRate,
    show_engagement_rate: agg.showEngagementRate,
    feedback_engagement_rate: agg.feedbackEngagementRate,
    search_to_show_ratio: agg.searchToShowRatio,
    mean_positive_feedback_count: agg.meanPositiveFeedbackCount,
    mean_negative_feedback_count: agg.meanNegativeFeedbackCount,
  };
}

/**
 * Render the §13.3 AKM overhead summary as a compact markdown section (#263).
 * Skipped entirely when the corpus had no akm-arm runs so the report stays
 * tight on the no-akm code path.
 */
export function renderAkmOverheadSection(input: UtilityRunReport): string {
  const akmRuns = input.akmRuns ?? [];
  if (akmRuns.length === 0) return "";
  const meta = new Map<string, Pick<TaskMetadata, "goldRef" | "expectedTransferFrom">>();
  for (const t of input.taskMetadata ?? []) {
    meta.set(t.id, { goldRef: t.goldRef, expectedTransferFrom: t.expectedTransferFrom });
  }
  const perRun = computeAkmOverhead(akmRuns, { taskMetadata: meta });
  const agg = aggregateAkmOverhead(perRun, akmRuns);
  const lines: string[] = [];
  lines.push("## AKM overhead");
  lines.push("");
  lines.push(`- runs: ${agg.totalRuns} (${agg.passingRuns} passed)`);
  lines.push(
    `- tool calls: search=${formatMean(agg.meanSearchCount)} show=${formatMean(agg.meanShowCount)} feedback=${formatMean(agg.meanFeedbackCount)} (mean per run)`,
  );
  lines.push(`- total tool calls: ${agg.totalToolCalls} (mean ${formatMean(agg.meanToolCalls)} per run)`);
  lines.push(
    `- tool_calls_per_success: ${agg.toolCallsPerSuccess === null ? "n/a" : formatMean(agg.toolCallsPerSuccess)}`,
  );
  lines.push(`- assets loaded (mean unique per run): ${formatMean(agg.meanAssetsLoaded)}`);
  lines.push(`- irrelevant assets loaded (mean per tagged run): ${formatNullableMean(agg.meanIrrelevantAssetsLoaded)}`);
  lines.push(`- time_to_first_search: ${formatNullableMs(agg.meanTimeToFirstSearchMs)}`);
  lines.push(`- time_to_first_correct_asset: ${formatNullableMs(agg.meanTimeToFirstCorrectAssetMs)}`);
  lines.push(`- context_bytes_loaded: ${formatNullableBytes(agg.meanContextBytesLoaded)}`);
  lines.push(`- asset_bytes_loaded: ${formatNullableBytes(agg.meanAssetBytesLoaded)}`);
  lines.push(`- cost_per_success: ${agg.costPerSuccess === null ? "n/a" : formatMean(agg.costPerSuccess)} tokens`);
  return lines.join("\n");
}

function formatMean(value: number): string {
  return value.toFixed(2);
}

function formatNullableMean(value: number | null): string {
  return value === null ? "n/a" : value.toFixed(2);
}

function formatNullableMs(value: number | null): string {
  return value === null ? "n/a" : `${Math.round(value)}ms`;
}

function formatNullableBytes(value: number | null): string {
  return value === null ? "n/a" : `${Math.round(value)} bytes`;
}
