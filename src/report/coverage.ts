/**
 * akm-bench corpus coverage report block (#262).
 */

import type { MemoryAbility, TaskMetadata } from "../corpus";
import {
  aggregateByMemoryAbility,
  aggregateByTaskFamily,
  type CategoryAggregateRow,
  type CorpusCoverage,
  computeCorpusCoverage,
  type PerTaskTagEntry,
} from "../metrics/memory-ops";
import type { UtilityRunReport } from "../run-record";

// ── Corpus coverage block (#262) ───────────────────────────────────────────

/**
 * Build the §13.3 `corpus_coverage` block from a UtilityRunReport (#262).
 * Folds three pieces:
 * - `coverage`: counts per `memory_ability` (closed set + `untagged`) and
 *   `task_family`. Operators see at a glance which abilities the corpus
 *   covers and which are missing.
 * - `by_memory_ability` / `by_task_family`: per-category aggregates of pass
 *   rate, akm − noakm delta, negative transfer count, and (when supplied)
 *   workflow-compliance mean.
 *
 * When the runner did not plumb `taskMetadata` (legacy code paths) we emit a
 * skeleton block with zero counts so JSON consumers don't see the key flicker
 * in and out depending on the runner version.
 */
export function buildCorpusCoverageBlock(input: UtilityRunReport): {
  coverage: CorpusCoverage;
  by_memory_ability: ReturnType<typeof serialiseCategoryRow>[];
  by_task_family: ReturnType<typeof serialiseCategoryRow>[];
} {
  const taskMetadata = input.taskMetadata ?? [];
  const metaById = new Map<string, TaskMetadata>();
  for (const m of taskMetadata) metaById.set(m.id, m);

  const tagEntries: PerTaskTagEntry[] = input.tasks.map((t) => {
    const meta = metaById.get(t.id);
    const entry: PerTaskTagEntry = {
      id: t.id,
      noakm: t.noakm,
      akm: t.akm,
    };
    if (meta?.memoryAbility) entry.memoryAbility = meta.memoryAbility;
    if (meta?.taskFamily) entry.taskFamily = meta.taskFamily;
    if (meta?.workflowFocus) entry.workflowFocus = meta.workflowFocus;
    if (typeof t.workflowCompliance === "number" && Number.isFinite(t.workflowCompliance)) {
      entry.workflowCompliance = t.workflowCompliance;
    }
    return entry;
  });

  const coverage = computeCorpusCoverage(taskMetadata);
  const byAbility = aggregateByMemoryAbility(tagEntries);
  const byFamily = aggregateByTaskFamily(tagEntries);

  return {
    coverage,
    by_memory_ability: byAbility.map(serialiseCategoryRow),
    by_task_family: byFamily.map(serialiseCategoryRow),
  };
}

function serialiseCategoryRow(row: CategoryAggregateRow): {
  category: string;
  task_count: number;
  pass_rate_noakm: number;
  pass_rate_akm: number;
  pass_rate_delta: number;
  negative_transfer_count: number;
  workflow_compliance: number | null;
} {
  return {
    category: row.category,
    task_count: row.taskCount,
    pass_rate_noakm: row.passRateNoakm,
    pass_rate_akm: row.passRateAkm,
    pass_rate_delta: row.passRateDelta,
    negative_transfer_count: row.negativeTransferCount,
    workflow_compliance: row.workflowCompliance,
  };
}

export function renderCorpusCoverageSection(input: UtilityRunReport): string {
  const block = buildCorpusCoverageBlock(input);
  const taggedAbility = Object.entries(block.coverage.memoryAbilityCounts).some(([k, v]) => k !== "untagged" && v > 0);
  if (!taggedAbility) return "";

  const lines: string[] = [];
  lines.push("## Corpus coverage");
  lines.push("");
  lines.push("| memory_ability | tasks |");
  lines.push("|----------------|-------|");
  // Sort keys: known abilities alphabetically, `untagged` last.
  const counts = block.coverage.memoryAbilityCounts;
  const knownKeys = Object.keys(counts)
    .filter((k) => k !== "untagged")
    .sort();
  for (const k of knownKeys) lines.push(`| ${k} | ${counts[k as MemoryAbility]} |`);
  if ((counts.untagged ?? 0) > 0) lines.push(`| untagged | ${counts.untagged} |`);

  if (block.by_memory_ability.length > 0) {
    lines.push("");
    lines.push("### By memory_ability");
    lines.push("");
    const anyCompliance = block.by_memory_ability.some((r) => r.workflow_compliance !== null);
    if (anyCompliance) {
      lines.push("| memory_ability | tasks | noakm | akm | delta | neg.transfer | workflow_compliance |");
      lines.push("|----------------|-------|-------|-----|-------|--------------|---------------------|");
    } else {
      lines.push("| memory_ability | tasks | noakm | akm | delta | neg.transfer |");
      lines.push("|----------------|-------|-------|-----|-------|--------------|");
    }
    for (const row of block.by_memory_ability) {
      const base = `| ${row.category} | ${row.task_count} | ${row.pass_rate_noakm.toFixed(2)} | ${row.pass_rate_akm.toFixed(2)} | ${signed(row.pass_rate_delta.toFixed(2))} | ${row.negative_transfer_count} |`;
      if (anyCompliance) {
        const wc = row.workflow_compliance === null ? "n/a" : row.workflow_compliance.toFixed(2);
        lines.push(`${base} ${wc} |`);
      } else {
        lines.push(base);
      }
    }
  }

  const families = block.by_task_family;
  if (families.length >= 2) {
    lines.push("");
    lines.push("### By task_family");
    lines.push("");
    lines.push("| task_family | tasks | noakm | akm | delta |");
    lines.push("|-------------|-------|-------|-----|-------|");
    for (const row of families) {
      lines.push(
        `| ${row.category} | ${row.task_count} | ${row.pass_rate_noakm.toFixed(2)} | ${row.pass_rate_akm.toFixed(2)} | ${signed(row.pass_rate_delta.toFixed(2))} |`,
      );
    }
  }

  return lines.join("\n");
}

function signed(text: string): string {
  if (text.startsWith("-")) return text;
  if (text === "0" || text === "0.00" || text === "0.0") return text;
  return `+${text}`;
}
