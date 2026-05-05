/**
 * akm-bench compare report block (§8).
 */

import type { CompareResult, CompareTaskRow, DeltaSign } from "../metrics/compare";

// ── Compare rendering (§8) ─────────────────────────────────────────────────

/**
 * Render a CompareResult as a deterministic markdown diff.
 *
 * Determinism: no timestamps, no run IDs, no git SHAs in the body — the diff
 * is a pure function of the two inputs' aggregated numbers and per-task
 * tables. Per-task rows are sorted alphabetically (already done by
 * `compareReports`, but re-asserted here defensively).
 *
 * Refusal cases (model mismatch, hash mismatch, schema/track issues) render
 * as a single error block instead of a diff table — there's nothing
 * actionable to show, and the operator's recovery path is in the message.
 */
export function renderCompareMarkdown(result: CompareResult): string {
  if (!result.ok) {
    return renderCompareFailure(result);
  }
  return renderCompareSuccess(result);
}

function renderCompareFailure(result: Extract<CompareResult, { ok: false }>): string {
  const lines: string[] = [];
  lines.push(`# akm-bench compare — refused (${result.reason})`);
  lines.push("");
  lines.push(result.message);
  if (result.reason === "model_mismatch" && result.baseModel !== undefined && result.currentModel !== undefined) {
    lines.push("");
    lines.push(`- base model:    \`${result.baseModel}\``);
    lines.push(`- current model: \`${result.currentModel}\``);
  }
  if (
    result.reason === "hash_mismatch" &&
    result.baseFixtureContentHash !== undefined &&
    result.currentFixtureContentHash !== undefined
  ) {
    lines.push("");
    lines.push(`- base fixture hash:    \`${String(result.baseFixtureContentHash)}\``);
    lines.push(`- current fixture hash: \`${String(result.currentFixtureContentHash)}\``);
    if (result.affectedFixtures && result.affectedFixtures.length > 0) {
      lines.push("");
      lines.push("affected fixtures:");
      for (const f of result.affectedFixtures) lines.push(`- ${f}`);
    }
  }
  if (result.reason === "corpus_mismatch") {
    if (result.baseTaskCorpusHash !== undefined || result.currentTaskCorpusHash !== undefined) {
      lines.push("");
      lines.push(`- base taskCorpusHash:    \`${String(result.baseTaskCorpusHash ?? "n/a")}\``);
      lines.push(`- current taskCorpusHash: \`${String(result.currentTaskCorpusHash ?? "n/a")}\``);
    }
    if (result.baseSelectedTaskIds && result.currentSelectedTaskIds) {
      const baseSet = new Set(result.baseSelectedTaskIds);
      const currentSet = new Set(result.currentSelectedTaskIds);
      const addedToCurrent = result.currentSelectedTaskIds.filter((id) => !baseSet.has(id)).sort();
      const droppedFromBase = result.baseSelectedTaskIds.filter((id) => !currentSet.has(id)).sort();
      if (addedToCurrent.length > 0) {
        lines.push("");
        lines.push("only in current:");
        for (const id of addedToCurrent) lines.push(`- ${id}`);
      }
      if (droppedFromBase.length > 0) {
        lines.push("");
        lines.push("only in base:");
        for (const id of droppedFromBase) lines.push(`- ${id}`);
      }
    }
  }
  return lines.join("\n");
}

function renderCompareSuccess(result: Extract<CompareResult, { ok: true }>): string {
  const lines: string[] = [];
  lines.push(`# akm-bench compare — \`${result.currentModel}\``);
  lines.push("");
  if (result.baseFixtureContentHash !== null || result.currentFixtureContentHash !== null) {
    const b = result.baseFixtureContentHash === null ? "n/a" : `\`${result.baseFixtureContentHash}\``;
    const c = result.currentFixtureContentHash === null ? "n/a" : `\`${result.currentFixtureContentHash}\``;
    lines.push(`fixture-content hash: base=${b}, current=${c}`);
    lines.push("");
  }
  lines.push("## Aggregate (akm arm, current − base)");
  lines.push("");
  lines.push("| metric | delta | direction |");
  lines.push("|--------|-------|-----------|");
  lines.push(
    `| pass_rate | ${signedFixed(result.aggregate.passRateDelta, 2)} | ${signGlyph(result.aggregate.passRateSign)} |`,
  );
  lines.push(
    `| tokens_per_pass | ${nullableSignedFixed(result.aggregate.tokensPerPassDelta, 0)} | ${signGlyph(result.aggregate.tokensPerPassSign)} |`,
  );
  lines.push(
    `| wallclock_ms | ${signedFixed(result.aggregate.wallclockMsDelta, 0)} | ${signGlyph(result.aggregate.wallclockMsSign)} |`,
  );
  lines.push("");
  lines.push("## Per-task (akm arm)");
  lines.push("");
  lines.push("| task | base pass_rate | current pass_rate | delta | dir | base stdev | current stdev |");
  lines.push("|------|----------------|-------------------|-------|-----|------------|---------------|");
  const sorted = [...result.perTask].sort((a, b) => a.id.localeCompare(b.id));
  for (const row of sorted) lines.push(perTaskCompareRow(row));
  if (result.warnings.length > 0) {
    lines.push("");
    lines.push("## Warnings");
    lines.push("");
    for (const w of result.warnings) lines.push(`- ${w}`);
  }
  return lines.join("\n");
}

function perTaskCompareRow(row: CompareTaskRow): string {
  const baseRate = row.baseMetrics === null ? "n/a" : row.baseMetrics.pass_rate.toFixed(2);
  const currentRate = row.currentMetrics === null ? "n/a" : row.currentMetrics.pass_rate.toFixed(2);
  const delta = row.delta.passRate === null ? "n/a" : signedFixed(row.delta.passRate, 2);
  const dir = signGlyph(row.signMarker);
  const baseStdev = row.baseMetrics === null ? "n/a" : row.baseMetrics.pass_rate_stdev.toFixed(2);
  const currentStdev = row.currentMetrics === null ? "n/a" : row.currentMetrics.pass_rate_stdev.toFixed(2);
  const idCell = row.presence === "both" ? row.id : `${row.id} _(${row.presence})_`;
  return `| ${idCell} | ${baseRate} | ${currentRate} | ${delta} | ${dir} | ${baseStdev} | ${currentStdev} |`;
}

function signGlyph(sign: DeltaSign): string {
  if (sign === "improve") return "▲";
  if (sign === "regress") return "▼";
  return "▬";
}

function signedFixed(value: number, digits: number): string {
  // Treat numerical zero (or values that round to "-0.00") as "0" so we
  // never emit a misleading "+0.00" or "-0.00" in deterministic output.
  const fixed = value.toFixed(digits);
  if (fixed === "-0" || /^-0\.0+$/.test(fixed)) return (0).toFixed(digits);
  if (value === 0) return fixed;
  return value > 0 ? `+${fixed}` : fixed;
}

function nullableSignedFixed(value: number | null, digits: number): string {
  if (value === null) return "n/a";
  return signedFixed(value, digits);
}
