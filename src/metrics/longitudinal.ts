/**
 * akm-bench longitudinal metrics (§6.4).
 */

import type { UtilityRunReport } from "../run-record";
import type { FailureMode } from "./failure-modes";

// ── Longitudinal metrics (§6.4) ────────────────────────────────────────────

/** Per-task longitudinal degradation row. */
export interface DegradationRow {
  taskId: string;
  prePassRate: number;
  postPassRate: number;
  delta: number;
  /** Failure-mode label for the post arm if the task failed (for §6.6 cross-link). */
  failureMode: FailureMode | null;
}

/** Longitudinal metrics envelope (§6.4). */
export interface LongitudinalMetrics {
  /** `pass_rate(post) - pass_rate(pre)`, akm arm of each report. */
  improvementSlope: number;
  /** `pass_rate(post) - pass_rate(synthetic)`. */
  overSyntheticLift: number;
  /**
   * Number of eval tasks where pass_rate(post) < pass_rate(pre) by more than
   * 1 seed (i.e. `pre - post > 1 / seedsPerArm`). Lists the offending tasks
   * with their post-arm failureMode label.
   */
  degradationCount: number;
  degradations: DegradationRow[];
  /** Echo of the pre / post / synthetic akm pass rates for the report header. */
  prePassRate: number;
  postPassRate: number;
  syntheticPassRate: number;
}

/**
 * Compute longitudinal metrics from three §13.3 utility-shaped reports. Each
 * input report is expected to share the same eval-slice corpus, with one arm
 * driving the akm side: `pre` = pre-evolve stash, `post` = evolved stash,
 * `synthetic` = no-stash scratchpad arm.
 *
 * The "arm" we read off each report is `aggregateAkm.passRate` — the runners
 * produce the akm arm for all three (synthetic is just the akm arm with a
 * stripped stashDir; pre/post differ by stash content). `seedsPerArm` for
 * the degradation threshold is taken from the post report's corpus envelope.
 */
export function computeLongitudinalMetrics(
  preReport: UtilityRunReport,
  postReport: UtilityRunReport,
  syntheticReport: UtilityRunReport,
): LongitudinalMetrics {
  const prePassRate = preReport.aggregateAkm.passRate;
  const postPassRate = postReport.aggregateAkm.passRate;
  const syntheticPassRate = syntheticReport.aggregateAkm.passRate;

  const seedsPerArm = Math.max(1, postReport.corpus.seedsPerArm);
  const oneSeedFraction = 1 / seedsPerArm;

  // Per-task degradation: outer-join pre and post on task id.
  const preTasks = new Map<string, UtilityRunReport["tasks"][number]>();
  for (const t of preReport.tasks) preTasks.set(t.id, t);
  const postTasks = new Map<string, UtilityRunReport["tasks"][number]>();
  for (const t of postReport.tasks) postTasks.set(t.id, t);

  // Index post failure-mode labels by task id (one mode per task — first
  // failed run wins; matches the §6.6 by-task aggregate's natural ordering).
  const postFailureByTask: Record<string, FailureMode | undefined> = {};
  const postFailureByTaskMap = postReport.failureModes?.byTask ?? {};
  for (const [taskId, byMode] of Object.entries(postFailureByTaskMap)) {
    const labels = Object.keys(byMode) as FailureMode[];
    if (labels.length > 0) postFailureByTask[taskId] = labels[0];
  }

  const degradations: DegradationRow[] = [];
  const allIds = new Set<string>();
  for (const id of preTasks.keys()) allIds.add(id);
  for (const id of postTasks.keys()) allIds.add(id);
  for (const id of [...allIds].sort()) {
    const pre = preTasks.get(id);
    const post = postTasks.get(id);
    if (!pre || !post) continue;
    const preRate = pre.akm.passRate;
    const postRate = post.akm.passRate;
    const dropped = preRate - postRate;
    if (dropped > oneSeedFraction) {
      degradations.push({
        taskId: id,
        prePassRate: preRate,
        postPassRate: postRate,
        delta: postRate - preRate,
        failureMode: postFailureByTask[id] ?? null,
      });
    }
  }

  return {
    improvementSlope: postPassRate - prePassRate,
    overSyntheticLift: postPassRate - syntheticPassRate,
    degradationCount: degradations.length,
    degradations,
    prePassRate,
    postPassRate,
    syntheticPassRate,
  };
}
