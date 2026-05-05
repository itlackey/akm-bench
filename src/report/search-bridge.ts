/**
 * akm-bench search-bridge report block (§6.7).
 */

import { histogramKeys, type SearchBridgeMetrics } from "../metrics/search-bridge";

/**
 * §6.7 envelope. We expose `null` for percentiles that fell into the missing
 * bucket so JSON consumers don't choke on `Infinity`.
 */
export function serialiseSearchBridge(s: SearchBridgeMetrics): object {
  return {
    runs_observed: s.runsObserved,
    searches_observed: s.searchesObserved,
    gold_rank_distribution: s.goldRankDistribution,
    gold_rank_p50: percentileForJson(s.goldRankP50),
    gold_rank_p90: percentileForJson(s.goldRankP90),
    gold_at_rank_1: s.goldAtRank1,
    gold_missing: s.goldMissing,
    pass_rate_by_rank: s.passRateByRank.map((e) => ({
      rank: e.rank,
      pass_rate: e.passRate,
      run_count: e.runCount,
    })),
  };
}

function percentileForJson(value: number | null): number | string | null {
  if (value === null) return null;
  if (!Number.isFinite(value)) return "missing";
  return value;
}

// ── Search-pipeline bridge (§6.7) markdown ─────────────────────────────────

/**
 * Render the §6.7 search-pipeline bridge as a markdown section.
 *
 * When the corpus has no gold-ref tasks (or simply no `akm search`
 * invocations), the section collapses to a single "(N/A)" sentence so the
 * report stays compact.
 */
export function renderSearchBridgeTable(metrics: SearchBridgeMetrics): string {
  const lines: string[] = [];
  lines.push("## Search → outcome bridge");
  lines.push("");

  if (metrics.searchesObserved === 0 && metrics.runsObserved === 0) {
    lines.push("(no gold-ref tasks in corpus; bridge metrics N/A)");
    return lines.join("\n");
  }

  // Histogram of gold rank.
  lines.push("| rank | count |");
  lines.push("|------|-------|");
  for (const k of histogramKeys()) {
    const count = metrics.goldRankDistribution[k] ?? 0;
    lines.push(`| ${k} | ${count} |`);
  }
  lines.push("");

  // Summary line.
  const p50 = formatRank(metrics.goldRankP50);
  const p90 = formatRank(metrics.goldRankP90);
  lines.push(
    `p50=${p50}, p90=${p90}, gold_at_rank_1=${formatPercent(metrics.goldAtRank1)}, gold_missing=${formatPercent(
      metrics.goldMissing,
    )}`,
  );
  lines.push("");

  // pass_rate_by_rank.
  lines.push("| rank | pass_rate | run_count |");
  lines.push("|------|-----------|-----------|");
  if (metrics.passRateByRank.length === 0) {
    lines.push("| (no runs with `akm search` invocations) | — | 0 |");
  } else {
    for (const entry of metrics.passRateByRank) {
      lines.push(`| ${entry.rank} | ${entry.passRate.toFixed(2)} | ${entry.runCount} |`);
    }
  }
  return lines.join("\n");
}

function formatRank(value: number | null): string {
  if (value === null) return "n/a";
  if (!Number.isFinite(value)) return "missing";
  return value.toFixed(1);
}

function formatPercent(value: number | null): string {
  if (value === null) return "n/a";
  return `${(value * 100).toFixed(1)}%`;
}
