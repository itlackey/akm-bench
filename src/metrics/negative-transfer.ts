/**
 * akm-bench negative-transfer metrics (#260).
 */

import type { RunResult } from "../driver";
import type { PerTaskMetrics } from "./outcome";

// ── Negative-transfer + domain diagnostics (#260) ──────────────────────────

/**
 * One regressed-task row: a task where AKM hurt pass rate relative to noakm.
 * `delta` is `akm - noakm` (negative for regressions); kept identical to the
 * sign convention used everywhere else in the bench. `severity` is the
 * positive magnitude (`noakm - akm`) — convenient for sums and sorting.
 */
export interface RegressedTaskRow {
  taskId: string;
  domain: string;
  noakmPassRate: number;
  akmPassRate: number;
  /** `akm - noakm`, negative for regressions. */
  delta: number;
  /** `noakm - akm`, positive for regressions. */
  severity: number;
}

/**
 * Negative-transfer aggregate (#260). Counts and severity sum across tasks
 * where `akm.passRate < noakm.passRate`. `topRegressedTasks` is sorted by
 * largest negative AKM delta first (most-severe regressions on top), with
 * `taskId` as the deterministic tiebreaker.
 */
export interface NegativeTransferAggregate {
  count: number;
  /** Sum of `noakm_pass_rate - akm_pass_rate` over regressed tasks. ≥ 0. */
  severity: number;
  topRegressedTasks: RegressedTaskRow[];
}

/**
 * Per-domain aggregate row (#260). One entry per domain present in the
 * corpus. Pass rate, tokens-per-pass, and wallclock are means across the
 * tasks in that domain (each task contributes once, K seeds already
 * collapsed into PerTaskMetrics). `tokensPerPassDelta` is `null` when
 * either arm has no measured passes.
 */
export interface DomainAggregateRow {
  domain: string;
  taskCount: number;
  /** Tasks within this domain where akm pass rate regressed. */
  regressionCount: number;
  passRateNoakm: number;
  passRateAkm: number;
  /** `akm - noakm`. Positive when AKM helped this domain. */
  passRateDelta: number;
  /** `akm - noakm`. `null` if either arm has no measured passes for this domain. */
  tokensPerPassDelta: number | null;
  /** `akm - noakm`, ms. */
  wallclockMsDelta: number;
}

/**
 * Asset-regression-candidate row (#260). An asset that was loaded by the
 * AKM agent during one or more regressed tasks. `regressedTaskCount` is the
 * number of distinct regressed task IDs that loaded this asset (de-duped
 * across seeds) — operators care about cross-task reach, not seed-level
 * load volume.
 */
export interface AssetRegressionCandidateRow {
  assetRef: string;
  regressedTaskCount: number;
  /** Distinct regressed task IDs that loaded this asset, sorted ascending. */
  regressedTaskIds: string[];
  /** Total seed-level load count across all regressed tasks (raw volume). */
  totalLoadCount: number;
}

/**
 * Extract the domain prefix from a task ID. The corpus convention is
 * `<domain>/<task-name>`; we split on the first `/`. Tasks lacking a slash
 * fall back to the literal `unknown` bucket so they aggregate predictably
 * rather than producing per-task domains-of-one.
 */
export function domainOfTaskId(taskId: string): string {
  const idx = taskId.indexOf("/");
  if (idx <= 0) return "unknown";
  return taskId.slice(0, idx);
}

/**
 * Compute the negative-transfer aggregate over a set of per-task entries
 * (one entry per task; both arms already aggregated into PerTaskMetrics).
 *
 * A task is "regressed" when `akm.passRate < noakm.passRate`. Ties (equal
 * pass rate, including 0=0) are NOT regressions. `topRegressedTasks` is
 * sorted by `severity` descending then `taskId` ascending so output is
 * deterministic.
 */
export function computeNegativeTransfer(
  tasks: ReadonlyArray<{ id: string; noakm: PerTaskMetrics; akm: PerTaskMetrics }>,
): NegativeTransferAggregate {
  const regressed: RegressedTaskRow[] = [];
  for (const t of tasks) {
    const delta = t.akm.passRate - t.noakm.passRate;
    if (delta >= 0) continue;
    regressed.push({
      taskId: t.id,
      domain: domainOfTaskId(t.id),
      noakmPassRate: t.noakm.passRate,
      akmPassRate: t.akm.passRate,
      delta,
      severity: -delta,
    });
  }
  regressed.sort((a, b) => {
    if (b.severity !== a.severity) return b.severity - a.severity;
    return a.taskId.localeCompare(b.taskId);
  });
  const severity = regressed.reduce((acc, r) => acc + r.severity, 0);
  return { count: regressed.length, severity, topRegressedTasks: regressed };
}

/**
 * Compute per-domain aggregates over a set of per-task entries. Each task
 * contributes once to its domain (K seeds already collapsed). Output rows
 * are sorted by `domain` ascending so JSON / markdown are byte-stable.
 *
 * Domain extraction uses `domainOfTaskId` (split on first `/`).
 */
export function computeDomainAggregates(
  tasks: ReadonlyArray<{ id: string; noakm: PerTaskMetrics; akm: PerTaskMetrics }>,
): DomainAggregateRow[] {
  const buckets = new Map<string, Array<{ id: string; noakm: PerTaskMetrics; akm: PerTaskMetrics }>>();
  for (const t of tasks) {
    const d = domainOfTaskId(t.id);
    let arr = buckets.get(d);
    if (!arr) {
      arr = [];
      buckets.set(d, arr);
    }
    arr.push(t);
  }
  const rows: DomainAggregateRow[] = [];
  for (const [domain, group] of buckets) {
    const n = group.length;
    let noakmSum = 0;
    let akmSum = 0;
    let wallNoakm = 0;
    let wallAkm = 0;
    let regressionCount = 0;
    const noakmTpp: number[] = [];
    const akmTpp: number[] = [];
    for (const t of group) {
      noakmSum += t.noakm.passRate;
      akmSum += t.akm.passRate;
      wallNoakm += t.noakm.wallclockMs;
      wallAkm += t.akm.wallclockMs;
      if (t.akm.passRate < t.noakm.passRate) regressionCount += 1;
      if (t.noakm.tokensPerPass !== null) noakmTpp.push(t.noakm.tokensPerPass);
      if (t.akm.tokensPerPass !== null) akmTpp.push(t.akm.tokensPerPass);
    }
    const passRateNoakm = noakmSum / n;
    const passRateAkm = akmSum / n;
    const meanNoakmTpp = noakmTpp.length === 0 ? null : noakmTpp.reduce((a, b) => a + b, 0) / noakmTpp.length;
    const meanAkmTpp = akmTpp.length === 0 ? null : akmTpp.reduce((a, b) => a + b, 0) / akmTpp.length;
    const tokensPerPassDelta = meanNoakmTpp === null || meanAkmTpp === null ? null : meanAkmTpp - meanNoakmTpp;
    rows.push({
      domain,
      taskCount: n,
      regressionCount,
      passRateNoakm,
      passRateAkm,
      passRateDelta: passRateAkm - passRateNoakm,
      tokensPerPassDelta,
      wallclockMsDelta: wallAkm / n - wallNoakm / n,
    });
  }
  rows.sort((a, b) => a.domain.localeCompare(b.domain));
  return rows;
}

/**
 * Compute asset-regression-candidate rows (#260). Walks the AKM-arm runs,
 * keeps only those whose `taskId` is in `regressedTaskIds`, and tallies how
 * often each loaded asset shows up. `regressedTaskCount` (distinct task IDs
 * touched) is the primary sort key — assets that hurt many tasks are more
 * actionable than assets that flooded one task across seeds.
 *
 * Sort: regressedTaskCount desc, totalLoadCount desc, assetRef asc.
 */
export function computeAssetRegressionCandidates(
  regressedTaskIds: ReadonlyArray<string>,
  akmRuns: ReadonlyArray<RunResult>,
): AssetRegressionCandidateRow[] {
  const regressed = new Set(regressedTaskIds);
  if (regressed.size === 0) return [];
  const taskIdsByAsset = new Map<string, Set<string>>();
  const totalLoadByAsset = new Map<string, number>();
  for (const run of akmRuns) {
    if (!regressed.has(run.taskId)) continue;
    const assets = run.assetsLoaded ?? [];
    for (const ref of assets) {
      let bucket = taskIdsByAsset.get(ref);
      if (!bucket) {
        bucket = new Set<string>();
        taskIdsByAsset.set(ref, bucket);
      }
      bucket.add(run.taskId);
      totalLoadByAsset.set(ref, (totalLoadByAsset.get(ref) ?? 0) + 1);
    }
  }
  const rows: AssetRegressionCandidateRow[] = [];
  for (const [assetRef, taskIds] of taskIdsByAsset) {
    rows.push({
      assetRef,
      regressedTaskCount: taskIds.size,
      regressedTaskIds: [...taskIds].sort(),
      totalLoadCount: totalLoadByAsset.get(assetRef) ?? 0,
    });
  }
  rows.sort((a, b) => {
    if (b.regressedTaskCount !== a.regressedTaskCount) return b.regressedTaskCount - a.regressedTaskCount;
    if (b.totalLoadCount !== a.totalLoadCount) return b.totalLoadCount - a.totalLoadCount;
    return a.assetRef.localeCompare(b.assetRef);
  });
  return rows;
}
