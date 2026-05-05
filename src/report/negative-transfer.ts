/**
 * akm-bench negative-transfer report block (#260).
 */

import {
  type AssetRegressionCandidateRow,
  computeAssetRegressionCandidates,
  computeDomainAggregates,
  computeNegativeTransfer,
  type DomainAggregateRow,
} from "../metrics/negative-transfer";
import type { UtilityRunReport } from "../run-record";

/** Snake-case wire shape for one row of `domain_level_deltas` (#260). */
export function serialiseDomainAggregate(row: DomainAggregateRow): {
  domain: string;
  task_count: number;
  regression_count: number;
  pass_rate_noakm: number;
  pass_rate_akm: number;
  pass_rate_delta: number;
  tokens_per_pass_delta: number | null;
  wallclock_ms_delta: number;
} {
  return {
    domain: row.domain,
    task_count: row.taskCount,
    regression_count: row.regressionCount,
    pass_rate_noakm: row.passRateNoakm,
    pass_rate_akm: row.passRateAkm,
    pass_rate_delta: row.passRateDelta,
    tokens_per_pass_delta: row.tokensPerPassDelta,
    wallclock_ms_delta: row.wallclockMsDelta,
  };
}

/** Snake-case wire shape for one row of `asset_regression_candidates` (#260). */
export function serialiseAssetRegressionCandidate(row: AssetRegressionCandidateRow): {
  asset_ref: string;
  regressed_task_count: number;
  regressed_task_ids: string[];
  total_load_count: number;
} {
  return {
    asset_ref: row.assetRef,
    regressed_task_count: row.regressedTaskCount,
    regressed_task_ids: row.regressedTaskIds,
    total_load_count: row.totalLoadCount,
  };
}

// ── Negative-transfer + domain diagnostics markdown (#260) ─────────────────

/**
 * Render the §260 negative-transfer section. Stays quiet when no
 * regressions exist — emits a single `## Negative transfer\n\nnone` block so
 * the report remains scannable for green corpora. When regressions exist,
 * renders headline counts, the top-regressed-task table, the per-domain
 * delta table, and the asset-regression-candidate table.
 */
export function renderNegativeTransferSection(input: UtilityRunReport): string {
  const negativeTransfer = computeNegativeTransfer(input.tasks);
  const lines: string[] = ["## Negative transfer", ""];
  if (negativeTransfer.count === 0) {
    lines.push("none");
    return lines.join("\n");
  }
  lines.push(
    `count=${negativeTransfer.count}, severity=${negativeTransfer.severity.toFixed(2)} (sum of noakm − akm pass rate over regressed tasks)`,
  );
  lines.push("");
  lines.push("### Top regressed tasks");
  lines.push("");
  lines.push("| task | domain | noakm | akm | delta |");
  lines.push("|------|--------|-------|-----|-------|");
  for (const row of negativeTransfer.topRegressedTasks) {
    lines.push(
      `| ${row.taskId} | ${row.domain} | ${row.noakmPassRate.toFixed(2)} | ${row.akmPassRate.toFixed(2)} | ${signed(row.delta.toFixed(2))} |`,
    );
  }

  const domainRows = computeDomainAggregates(input.tasks);
  if (domainRows.length > 0) {
    lines.push("");
    lines.push("### Domain-level deltas");
    lines.push("");
    lines.push(
      "| domain | tasks | regressions | noakm pass | akm pass | delta | tokens delta | wallclock delta (ms) |",
    );
    lines.push(
      "|--------|-------|-------------|------------|----------|-------|--------------|----------------------|",
    );
    for (const row of domainRows) {
      const tppDelta = row.tokensPerPassDelta === null ? "n/a" : signed(row.tokensPerPassDelta.toFixed(0));
      lines.push(
        `| ${row.domain} | ${row.taskCount} | ${row.regressionCount} | ${row.passRateNoakm.toFixed(2)} | ${row.passRateAkm.toFixed(2)} | ${signed(row.passRateDelta.toFixed(2))} | ${tppDelta} | ${signed(row.wallclockMsDelta.toFixed(0))} |`,
      );
    }
  }

  const candidates = computeAssetRegressionCandidates(
    negativeTransfer.topRegressedTasks.map((r) => r.taskId),
    input.akmRuns ?? [],
  );
  if (candidates.length > 0) {
    lines.push("");
    lines.push("### Asset regression candidates");
    lines.push("");
    lines.push("| asset_ref | regressed tasks | total loads |");
    lines.push("|-----------|-----------------|-------------|");
    for (const row of candidates) {
      lines.push(`| \`${row.assetRef}\` | ${row.regressedTaskCount} | ${row.totalLoadCount} |`);
    }
  }
  return lines.join("\n");
}

function signed(text: string): string {
  if (text.startsWith("-")) return text;
  if (text === "0" || text === "0.00" || text === "0.0") return text;
  return `+${text}`;
}
