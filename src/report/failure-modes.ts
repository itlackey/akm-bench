/**
 * akm-bench failure-mode report block (§6.6).
 */

import type { FailureMode } from "../metrics/failure-modes";
import type { UtilityRunReport } from "../run-record";

// ── Failure-mode breakdown (§6.6) ──────────────────────────────────────────

/**
 * Render the §6.6 "Failure modes" markdown section. Lines are sorted by
 * descending count (ties broken alphabetically by label so output is
 * byte-stable). Each line:
 *
 *   `<label> — <count> (<percent>% of failed runs)`
 *
 * Returns an empty string when no failed runs exist (caller decides whether
 * to append a blank section header).
 */
export function renderFailureModeBreakdown(report: UtilityRunReport): string {
  const entries = Object.entries(report.failureModes.byLabel) as Array<[FailureMode, number]>;
  if (entries.length === 0) return "";
  const totalFailures = entries.reduce((acc, [, count]) => acc + count, 0);
  if (totalFailures === 0) return "";

  // Sort by descending count, tie-break alphabetically for determinism.
  entries.sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    return a[0].localeCompare(b[0]);
  });

  const lines: string[] = ["## Failure modes", ""];
  for (const [label, count] of entries) {
    const percent = ((count / totalFailures) * 100).toFixed(1);
    lines.push(`- ${label} — ${count} (${percent}% of failed runs)`);
  }
  return lines.join("\n");
}
