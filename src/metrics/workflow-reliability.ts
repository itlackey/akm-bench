/**
 * akm-bench workflow reliability metrics (#258).
 */

import type { WorkflowCheckResult, WorkflowCheckStatus } from "../workflow-evaluator";

// ── Workflow reliability (#258) ────────────────────────────────────────────

/**
 * Per-workflow reliability row.
 *
 * `pass_at_k`: fraction of tasks where AT LEAST ONE seed produced a `pass`
 * workflow check for this workflow id. Group by task first, then ask
 * "did the agent ever comply?".
 *
 * `pass_all_k`: fraction of tasks where ALL K seeds produced a `pass`
 * workflow check for this workflow id. Tasks with mixed pass/non-pass
 * outcomes count against this metric — partial/fail/harness_error are NOT
 * compliant.
 *
 * `tasks` is the count of distinct task ids that contributed at least one
 * applicable seed (i.e., a `pass`/`partial`/`fail`/`harness_error` status).
 * `not_applicable` rows are excluded from the denominator.
 *
 * `k` is the maximum seed count observed across this workflow's tasks; it
 * is descriptive only — pass_at_k and pass_all_k are computed per-task on
 * that task's actual seed count, then averaged over tasks.
 */
export interface WorkflowReliabilityRow {
  workflow_id: string;
  pass_at_k: number;
  pass_all_k: number;
  tasks: number;
  k: number;
}

/**
 * Corpus-wide reliability aggregate.
 *
 * `pass_at_k` / `pass_all_k` are weighted averages over `(workflow_id, task)`
 * groups: every (workflow, task) pair contributes equally. This avoids a
 * workflow with many tasks dominating one with few. `groups` is the total
 * number of (workflow_id, task) groups counted; `tasks` is the count of
 * distinct task ids that appeared in at least one group.
 */
export interface WorkflowReliabilityCorpus {
  pass_at_k: number;
  pass_all_k: number;
  groups: number;
  tasks: number;
}

/**
 * Output of `computeWorkflowReliability`.
 *
 * `byWorkflow` is keyed by `workflow_id` for stable lookup.
 * `corpus` is the cross-workflow rollup.
 *
 * Empty input yields zeroed-out fields so renderers can branch on
 * `groups === 0` rather than handling undefined.
 */
export interface WorkflowReliabilityResult {
  byWorkflow: Record<string, WorkflowReliabilityRow>;
  corpus: WorkflowReliabilityCorpus;
}

/**
 * Bucket a workflow check status onto pass / non-pass for reliability.
 *
 * Reliability is a strict pass-or-not metric (issue #258). Anything other
 * than `pass` (including `partial`, `fail`, `harness_error`) counts as a
 * non-pass. `not_applicable` returns `null` so the caller can skip the
 * entire (task, seed) pair — it never contributes to either numerator or
 * denominator.
 */
function bucketReliabilityStatus(status: WorkflowCheckStatus): "pass" | "non_pass" | null {
  if (status === "not_applicable") return null;
  if (status === "pass") return "pass";
  return "non_pass";
}

/**
 * Compute workflow reliability metrics (`pass@k` and `pass^k`) per workflow
 * and corpus-wide from a flat list of `WorkflowCheckResult`.
 *
 * Methodology (per #258 review addendum):
 *   1. Filter out `not_applicable` checks entirely.
 *   2. For each `(workflow_id, task_id)` group, collapse seeds to the set
 *      of statuses observed.
 *   3. `pass_at_k` per task = 1 if at least one seed is `pass`, else 0.
 *   4. `pass_all_k` per task = 1 if every seed is `pass`, else 0.
 *   5. Per-workflow row averages over its task set.
 *   6. Corpus rollup averages over every (workflow, task) group equally.
 *
 * Pure: never mutates `checks`. Returns a stable shape for empty input.
 */
export function computeWorkflowReliability(checks: ReadonlyArray<WorkflowCheckResult>): WorkflowReliabilityResult {
  // Group by (workflow_id, task_id) → list of statuses across seeds.
  // Use Map<string, Map<string, WorkflowCheckStatus[]>> so iteration order
  // is insertion order (deterministic given deterministic input).
  const grouped = new Map<string, Map<string, WorkflowCheckStatus[]>>();

  for (const c of checks) {
    if (bucketReliabilityStatus(c.status) === null) continue;
    let perWorkflow = grouped.get(c.workflowId);
    if (!perWorkflow) {
      perWorkflow = new Map<string, WorkflowCheckStatus[]>();
      grouped.set(c.workflowId, perWorkflow);
    }
    const list = perWorkflow.get(c.taskId);
    if (list) list.push(c.status);
    else perWorkflow.set(c.taskId, [c.status]);
  }

  const byWorkflow: Record<string, WorkflowReliabilityRow> = {};
  let corpusPassAtKSum = 0;
  let corpusPassAllKSum = 0;
  let corpusGroupCount = 0;
  const corpusTasks = new Set<string>();

  for (const [workflowId, perTask] of grouped) {
    let passAtKSum = 0;
    let passAllKSum = 0;
    let kMax = 0;
    for (const [taskId, statuses] of perTask) {
      if (statuses.length > kMax) kMax = statuses.length;
      const allPass = statuses.every((s) => s === "pass");
      const anyPass = statuses.some((s) => s === "pass");
      if (anyPass) passAtKSum += 1;
      if (allPass) passAllKSum += 1;
      corpusPassAtKSum += anyPass ? 1 : 0;
      corpusPassAllKSum += allPass ? 1 : 0;
      corpusGroupCount += 1;
      corpusTasks.add(taskId);
    }
    const taskCount = perTask.size;
    byWorkflow[workflowId] = {
      workflow_id: workflowId,
      pass_at_k: taskCount === 0 ? 0 : passAtKSum / taskCount,
      pass_all_k: taskCount === 0 ? 0 : passAllKSum / taskCount,
      tasks: taskCount,
      k: kMax,
    };
  }

  const corpus: WorkflowReliabilityCorpus = {
    pass_at_k: corpusGroupCount === 0 ? 0 : corpusPassAtKSum / corpusGroupCount,
    pass_all_k: corpusGroupCount === 0 ? 0 : corpusPassAllKSum / corpusGroupCount,
    groups: corpusGroupCount,
    tasks: corpusTasks.size,
  };

  return { byWorkflow, corpus };
}
