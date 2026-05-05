/**
 * akm-bench memory-operation tag aggregations (#262).
 */

import { MEMORY_ABILITY_VALUES, type MemoryAbility, type TaskMetadata } from "../corpus";
import type { PerTaskMetrics } from "./outcome";

// ── Memory-operation tag aggregations (#262) ───────────────────────────────

/**
 * One per-task entry as consumed by `aggregateByMemoryAbility` /
 * `aggregateByTaskFamily`. Mirrors the runner's per-task envelope plus the
 * bag of optional memory-operation tags from `task.yaml`. Tasks may carry
 * arbitrary subsets of tags — aggregations skip rows where the keying tag
 * is undefined.
 */
export interface PerTaskTagEntry {
  id: string;
  noakm: PerTaskMetrics;
  akm: PerTaskMetrics;
  /** Optional memory-operation ability tag (#262). */
  memoryAbility?: MemoryAbility;
  /** Optional cross-task family identifier (#262). */
  taskFamily?: string;
  /** Optional declarative-workflow focus tag (#255 / #262). */
  workflowFocus?: string;
  /**
   * Optional workflow-compliance fraction `[0, 1]` for the akm arm. When
   * undefined the row is skipped from the workflow-compliance mean for the
   * group. The runner populates this from #255's per-task workflow trace.
   */
  workflowCompliance?: number;
}

/**
 * Per-category aggregate emitted by `aggregateByMemoryAbility` and
 * `aggregateByTaskFamily`. Each row carries:
 * - `taskCount`: number of tasks that fell into this category.
 * - `passRateNoakm` / `passRateAkm`: mean pass rate per arm.
 * - `passRateDelta`: `akm - noakm`. Positive = akm helped this category.
 * - `negativeTransferCount`: count of tasks where akm pass rate regressed.
 * - `workflowCompliance`: mean of `workflowCompliance` over rows where it
 *   was supplied; `null` when no rows in the category provided one.
 */
export interface CategoryAggregateRow {
  category: string;
  taskCount: number;
  passRateNoakm: number;
  passRateAkm: number;
  passRateDelta: number;
  negativeTransferCount: number;
  workflowCompliance: number | null;
}

function aggregateByKey(
  entries: ReadonlyArray<PerTaskTagEntry>,
  pickKey: (e: PerTaskTagEntry) => string | undefined,
): CategoryAggregateRow[] {
  const buckets = new Map<string, PerTaskTagEntry[]>();
  for (const entry of entries) {
    const key = pickKey(entry);
    if (!key) continue;
    let arr = buckets.get(key);
    if (!arr) {
      arr = [];
      buckets.set(key, arr);
    }
    arr.push(entry);
  }
  const rows: CategoryAggregateRow[] = [];
  for (const [category, group] of buckets) {
    const n = group.length;
    let noakmSum = 0;
    let akmSum = 0;
    let regressionCount = 0;
    let complianceSum = 0;
    let complianceCount = 0;
    for (const t of group) {
      noakmSum += t.noakm.passRate;
      akmSum += t.akm.passRate;
      if (t.akm.passRate < t.noakm.passRate) regressionCount += 1;
      if (typeof t.workflowCompliance === "number" && Number.isFinite(t.workflowCompliance)) {
        complianceSum += t.workflowCompliance;
        complianceCount += 1;
      }
    }
    rows.push({
      category,
      taskCount: n,
      passRateNoakm: noakmSum / n,
      passRateAkm: akmSum / n,
      passRateDelta: akmSum / n - noakmSum / n,
      negativeTransferCount: regressionCount,
      workflowCompliance: complianceCount === 0 ? null : complianceSum / complianceCount,
    });
  }
  rows.sort((a, b) => a.category.localeCompare(b.category));
  return rows;
}

/**
 * Aggregate per-task entries by `memoryAbility` (#262). Tasks lacking a tag
 * are skipped so the report only surfaces categories with explicit
 * coverage. Output rows are sorted by category for byte-stable JSON.
 *
 * The closed set of memory-ability values is exported as
 * {@link MEMORY_ABILITY_VALUES} from `corpus.ts`.
 */
export function aggregateByMemoryAbility(entries: ReadonlyArray<PerTaskTagEntry>): CategoryAggregateRow[] {
  return aggregateByKey(entries, (e) => e.memoryAbility);
}

/**
 * Aggregate per-task entries by `taskFamily` (#262). Tasks lacking a tag
 * are skipped. `taskFamily` follows the `<domain>/<short-name>` grammar —
 * tasks sharing a family are expected to transfer knowledge between each
 * other. Output rows are sorted by category for byte-stable JSON.
 */
export function aggregateByTaskFamily(entries: ReadonlyArray<PerTaskTagEntry>): CategoryAggregateRow[] {
  return aggregateByKey(entries, (e) => e.taskFamily);
}

/**
 * Build the corpus-coverage block for the §13.3 utility report (#262).
 *
 * Returns:
 * - `memoryAbilityCounts`: count of tagged tasks per memory-ability label
 *   across every value in {@link MEMORY_ABILITY_VALUES}. Untagged tasks are
 *   summed into `untagged`. Missing categories render as 0 — operators want
 *   to know which abilities the corpus does NOT cover.
 * - `taskFamilyCounts`: count of tagged tasks per family. Untagged tasks
 *   summed into `untagged`. Sorted for stable JSON output.
 * - `totalTasks`: total tasks supplied to the aggregator.
 */
export interface CorpusCoverage {
  totalTasks: number;
  memoryAbilityCounts: Record<MemoryAbility | "untagged", number>;
  taskFamilyCounts: Record<string, number>;
}

export function computeCorpusCoverage(
  tasks: ReadonlyArray<Pick<TaskMetadata, "memoryAbility" | "taskFamily">>,
): CorpusCoverage {
  const memoryAbilityCounts = {
    untagged: 0,
  } as Record<MemoryAbility | "untagged", number>;
  for (const ability of MEMORY_ABILITY_VALUES) {
    memoryAbilityCounts[ability] = 0;
  }
  const taskFamilyCounts: Record<string, number> = {};
  let untaggedFamily = 0;
  for (const task of tasks) {
    if (task.memoryAbility) {
      memoryAbilityCounts[task.memoryAbility] = (memoryAbilityCounts[task.memoryAbility] ?? 0) + 1;
    } else {
      memoryAbilityCounts.untagged += 1;
    }
    if (task.taskFamily) {
      taskFamilyCounts[task.taskFamily] = (taskFamilyCounts[task.taskFamily] ?? 0) + 1;
    } else {
      untaggedFamily += 1;
    }
  }
  if (untaggedFamily > 0) taskFamilyCounts.untagged = untaggedFamily;
  return {
    totalTasks: tasks.length,
    memoryAbilityCounts,
    taskFamilyCounts,
  };
}
