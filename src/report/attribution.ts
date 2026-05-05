/**
 * akm-bench attribution report block (§6.5).
 */

import type { PerAssetAttribution } from "../metrics/attribution";

// ── Attribution table rendering (§6.5) ─────────────────────────────────────

/**
 * Threshold for the "highly loaded" slice — assets with a load count at or
 * above this fraction of the per-table maximum get bucketed into the "well
 * used and working" / "well used and not working" callout sections.
 */
const HIGH_LOAD_THRESHOLD = 0.5;

/**
 * Threshold for "working" pass-rate. An asset is "working" if its
 * load_pass_rate is at or above this; "not working" if below.
 */
const WORKING_PASS_RATE_THRESHOLD = 0.5;

/**
 * Render a per-asset attribution table as markdown. Sort order matches
 * `computePerAssetAttribution` (load count desc, pass rate desc, ref asc).
 *
 * The output has three sections:
 *   1. Full sorted table.
 *   2. "Well-used and working" callout — high load, high pass_rate.
 *   3. "Well-used and not working" callout — high load, low pass_rate.
 *
 * The two callouts are the actionable slices: the first is what curation
 * should preserve, the second is what should be improved or removed.
 */
export function renderAttributionTable(attr: PerAssetAttribution): string {
  const lines: string[] = [];
  lines.push("## Per-asset attribution");
  lines.push("");
  lines.push(`Total akm-arm runs aggregated: ${attr.totalAkmRuns}`);
  lines.push("");

  if (attr.rows.length === 0) {
    lines.push("_No assets were loaded by the agent during akm-arm runs._");
    return lines.join("\n");
  }

  lines.push("| asset_ref | load_count | load_count_passing | load_count_failing | load_pass_rate |");
  lines.push("|-----------|------------|--------------------|--------------------|----------------|");
  for (const row of attr.rows) {
    lines.push(
      `| \`${row.assetRef}\` | ${row.loadCount} | ${row.loadCountPassing} | ${row.loadCountFailing} | ${formatRate(row.loadPassRate)} |`,
    );
  }

  // Slice callouts. We compute the high-load threshold relative to the
  // top-loaded asset's count so this scales whether the corpus has 5 or 500
  // total runs.
  const topLoad = attr.rows[0]?.loadCount ?? 0;
  const highLoadCutoff = Math.max(1, Math.ceil(topLoad * HIGH_LOAD_THRESHOLD));
  const heavilyLoaded = attr.rows.filter((r) => r.loadCount >= highLoadCutoff);

  const working = heavilyLoaded.filter((r) => (r.loadPassRate ?? 0) >= WORKING_PASS_RATE_THRESHOLD);
  const notWorking = heavilyLoaded.filter((r) => (r.loadPassRate ?? 0) < WORKING_PASS_RATE_THRESHOLD);

  lines.push("");
  lines.push("### Well-used and working");
  lines.push("");
  if (working.length === 0) {
    lines.push("_None._");
  } else {
    for (const r of working) {
      lines.push(`- \`${r.assetRef}\` (load_count=${r.loadCount}, load_pass_rate=${formatRate(r.loadPassRate)})`);
    }
  }

  lines.push("");
  lines.push("### Well-used and NOT working");
  lines.push("");
  if (notWorking.length === 0) {
    lines.push("_None._");
  } else {
    for (const r of notWorking) {
      lines.push(`- \`${r.assetRef}\` (load_count=${r.loadCount}, load_pass_rate=${formatRate(r.loadPassRate)})`);
    }
  }

  return lines.join("\n");
}

function formatRate(value: number | null): string {
  if (value === null) return "n/a";
  return `${(value * 100).toFixed(1)}%`;
}
