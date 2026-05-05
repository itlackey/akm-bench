/**
 * akm-bench workflow compliance report block (#257).
 */

import {
  computeWorkflowReliability,
  type WorkflowReliabilityCorpus,
  type WorkflowReliabilityRow,
} from "../metrics/workflow-reliability";
import type { UtilityRunReport } from "../run-record";
import type { WorkflowCheckResult, WorkflowCheckStatus, WorkflowViolationCode } from "../workflow-evaluator";

// ── Workflow compliance aggregation (#257) ─────────────────────────────────

/**
 * Top-violation entry with enough detail to identify which (task, seed)
 * caused each occurrence. The `evidence` array is capped at
 * `MAX_VIOLATION_EVIDENCE` per code so a pathological corpus cannot blow up
 * the report.
 */
const MAX_VIOLATION_EVIDENCE = 10;

/**
 * Maximum number of top-violation entries to surface in JSON / markdown.
 * Operators care about the head of the distribution; the long tail is
 * recoverable from `workflowChecks` if needed.
 */
const MAX_TOP_VIOLATIONS = 10;

interface WorkflowViolationEvidence {
  task_id: string;
  arm: string;
  seed: number;
  workflow_id: string;
  message?: string;
  expected?: string;
  observed?: string;
}

interface WorkflowTopViolation {
  code: WorkflowViolationCode;
  count: number;
  evidence: WorkflowViolationEvidence[];
}

interface WorkflowPerSpecAggregate {
  workflow_id: string;
  count: number;
  score: number;
  pass_rate: number;
  partial_rate: number;
  fail_rate: number;
  violation_count: number;
}

interface WorkflowOutcomeCounts {
  pass: number;
  partial: number;
  fail: number;
}

interface WorkflowCrossTabRow {
  task_outcome: string;
  pass: number;
  partial: number;
  fail: number;
  total: number;
}

/**
 * Workflow reliability sub-block (#258) attached under the existing #257
 * `workflow` envelope. Always present; `corpus.groups === 0` and an empty
 * `by_workflow` record indicate "no applicable checks contributed".
 */
interface WorkflowReliabilityBlock {
  by_workflow: Record<string, WorkflowReliabilityRow>;
  corpus: WorkflowReliabilityCorpus;
}

interface WorkflowAggregate {
  total_checks: number;
  applicable_checks: number;
  overall_compliance: number;
  strict_pass_rate: number;
  partial_pass_rate: number;
  fail_rate: number;
  violation_count: number;
  by_workflow: Record<string, WorkflowPerSpecAggregate>;
  top_violations: WorkflowTopViolation[];
  cross_tab: WorkflowCrossTabRow[];
  /** #258 reliability metrics (pass@k / pass^k). */
  reliability: WorkflowReliabilityBlock;
}

/**
 * Map a workflow check `status` onto the public pass/partial/fail bucket.
 * `not_applicable` returns `null` (excluded from the aggregate counts).
 * `harness_error` is bucketed as `fail` so corrupt traces are visibly
 * counted against compliance.
 */
function bucketWorkflowStatus(status: WorkflowCheckStatus): "pass" | "partial" | "fail" | null {
  if (status === "pass") return "pass";
  if (status === "partial") return "partial";
  if (status === "fail") return "fail";
  if (status === "harness_error") return "fail";
  return null; // not_applicable
}

/**
 * Compute the §257 `workflow` block from a flat list of `WorkflowCheckResult`.
 * Empty input yields an empty (zero-filled) aggregate so JSON consumers
 * always see the same shape.
 */
export function buildWorkflowAggregate(checks: readonly WorkflowCheckResult[]): WorkflowAggregate {
  // #258: Compute reliability up front so all early-return paths share the
  // same shape. Reliability tolerates empty input (`groups === 0`).
  const reliabilityResult = computeWorkflowReliability(checks);
  const reliability: WorkflowReliabilityBlock = {
    by_workflow: reliabilityResult.byWorkflow,
    corpus: reliabilityResult.corpus,
  };

  const empty: WorkflowAggregate = {
    total_checks: checks.length,
    applicable_checks: 0,
    overall_compliance: 0,
    strict_pass_rate: 0,
    partial_pass_rate: 0,
    fail_rate: 0,
    violation_count: 0,
    by_workflow: {},
    top_violations: [],
    cross_tab: [],
    reliability,
  };

  if (checks.length === 0) return empty;

  // Bucket counts (corpus-wide) and accumulate per-spec / per-violation /
  // cross-tab in a single pass.
  let strict = 0;
  let partial = 0;
  let fail = 0;
  let scoreSum = 0;
  let applicable = 0;
  let violationCount = 0;

  const perSpecAcc = new Map<
    string,
    { count: number; scoreSum: number; pass: number; partial: number; fail: number; violationCount: number }
  >();
  const violationAcc = new Map<WorkflowViolationCode, WorkflowViolationEvidence[]>();
  const crossTabAcc = new Map<string, WorkflowOutcomeCounts>();
  // We need each (task_outcome, run) bucketed against the WORST workflow
  // outcome that run produced — otherwise a run with one passing and one
  // failing spec gets double-counted across cross-tab rows. Reduce per-run.
  const runWorstOutcome = new Map<string, { taskOutcome: string; workflowOutcome: "pass" | "partial" | "fail" }>();
  // Track which run keys have at least one applicable check; non-applicable
  // runs do not contribute to the cross-tab.
  const runHasApplicable = new Set<string>();

  for (const c of checks) {
    const bucket = bucketWorkflowStatus(c.status);
    const runKey = `${c.taskId}::${c.arm}::${c.seed}`;

    // Per-spec: include `not_applicable` in the spec's `count` column
    // (operators want to see whether the spec ever fired) but exclude
    // it from rate denominators.
    const specEntry = perSpecAcc.get(c.workflowId) ?? {
      count: 0,
      scoreSum: 0,
      pass: 0,
      partial: 0,
      fail: 0,
      violationCount: 0,
    };
    specEntry.count += 1;
    if (bucket !== null) {
      specEntry.scoreSum += c.score;
      specEntry[bucket] += 1;
    }
    specEntry.violationCount += c.violations.length;
    perSpecAcc.set(c.workflowId, specEntry);

    if (bucket === null) continue;

    applicable += 1;
    scoreSum += c.score;
    violationCount += c.violations.length;
    runHasApplicable.add(runKey);

    if (bucket === "pass") strict += 1;
    else if (bucket === "partial") partial += 1;
    else fail += 1;

    // Per-violation evidence collection. Cap evidence per code so one noisy
    // failure mode cannot dominate the section.
    for (const v of c.violations) {
      const list = violationAcc.get(v.code) ?? [];
      if (list.length < MAX_VIOLATION_EVIDENCE) {
        const ev: WorkflowViolationEvidence = {
          task_id: c.taskId,
          arm: c.arm,
          seed: c.seed,
          workflow_id: c.workflowId,
        };
        if (v.message) ev.message = v.message;
        if (v.expected !== undefined) ev.expected = v.expected;
        if (v.observed !== undefined) ev.observed = v.observed;
        list.push(ev);
      }
      violationAcc.set(v.code, list);
    }

    // Cross-tab bookkeeping: keep the WORST workflow outcome per run so we
    // get one cell per run (not per (run × spec)).
    const taskOutcome = readCheckTaskOutcome(c) ?? "unknown";
    const worst = runWorstOutcome.get(runKey);
    if (!worst) {
      runWorstOutcome.set(runKey, { taskOutcome, workflowOutcome: bucket });
    } else if (severityRank(bucket) > severityRank(worst.workflowOutcome)) {
      worst.workflowOutcome = bucket;
    }
  }

  // Reduce runWorstOutcome into the public cross_tab rows. We always emit
  // entries for `pass` and `fail` task outcomes so the table shape is
  // stable; additional outcomes ("budget_exceeded", "harness_error",
  // "unknown") only appear when at least one run carried them.
  const stableOutcomes: string[] = ["pass", "fail"];
  for (const [, entry] of runWorstOutcome) {
    if (!stableOutcomes.includes(entry.taskOutcome) && entry.taskOutcome !== "unknown") {
      stableOutcomes.push(entry.taskOutcome);
    }
  }
  for (const [, entry] of runWorstOutcome) {
    const counts = crossTabAcc.get(entry.taskOutcome) ?? { pass: 0, partial: 0, fail: 0 };
    counts[entry.workflowOutcome] += 1;
    crossTabAcc.set(entry.taskOutcome, counts);
  }

  const cross_tab: WorkflowCrossTabRow[] = [];
  for (const outcome of stableOutcomes) {
    const counts = crossTabAcc.get(outcome) ?? { pass: 0, partial: 0, fail: 0 };
    cross_tab.push({
      task_outcome: outcome,
      pass: counts.pass,
      partial: counts.partial,
      fail: counts.fail,
      total: counts.pass + counts.partial + counts.fail,
    });
  }
  // Append "unknown" row only if any run actually carried it.
  if (crossTabAcc.has("unknown")) {
    const counts = crossTabAcc.get("unknown") ?? { pass: 0, partial: 0, fail: 0 };
    cross_tab.push({
      task_outcome: "unknown",
      pass: counts.pass,
      partial: counts.partial,
      fail: counts.fail,
      total: counts.pass + counts.partial + counts.fail,
    });
  }

  if (applicable === 0) {
    // Every check was `not_applicable`. Surface a non-empty `by_workflow`
    // (so operators see which specs ran) but leave the rate fields zeroed.
    const by_workflow: Record<string, WorkflowPerSpecAggregate> = {};
    for (const [id, e] of perSpecAcc) {
      by_workflow[id] = {
        workflow_id: id,
        count: e.count,
        score: 0,
        pass_rate: 0,
        partial_rate: 0,
        fail_rate: 0,
        violation_count: e.violationCount,
      };
    }
    return {
      total_checks: checks.length,
      applicable_checks: 0,
      overall_compliance: 0,
      strict_pass_rate: 0,
      partial_pass_rate: 0,
      fail_rate: 0,
      violation_count: 0,
      by_workflow,
      top_violations: [],
      cross_tab,
      reliability,
    };
  }

  const by_workflow: Record<string, WorkflowPerSpecAggregate> = {};
  for (const [id, e] of perSpecAcc) {
    const applicableForSpec = e.pass + e.partial + e.fail;
    const score = applicableForSpec === 0 ? 0 : e.scoreSum / applicableForSpec;
    const passRate = applicableForSpec === 0 ? 0 : e.pass / applicableForSpec;
    const partialRate = applicableForSpec === 0 ? 0 : e.partial / applicableForSpec;
    const failRate = applicableForSpec === 0 ? 0 : e.fail / applicableForSpec;
    by_workflow[id] = {
      workflow_id: id,
      count: e.count,
      score,
      pass_rate: passRate,
      partial_rate: partialRate,
      fail_rate: failRate,
      violation_count: e.violationCount,
    };
  }

  // Top-violation list: sort by count desc, tie-break alphabetically by
  // code so rendering is byte-stable.
  const top_violations: WorkflowTopViolation[] = [];
  for (const [code, evidence] of violationAcc) {
    top_violations.push({
      code,
      count: evidence.length, // bounded; raw count below for accuracy
      evidence,
    });
  }
  // Recount: `evidence.length` is capped at MAX_VIOLATION_EVIDENCE; we want
  // the true count for sorting/reporting. Re-derive from violationAcc by
  // scanning checks again — cheap.
  const trueCounts = new Map<WorkflowViolationCode, number>();
  for (const c of checks) {
    if (bucketWorkflowStatus(c.status) === null) continue;
    for (const v of c.violations) {
      trueCounts.set(v.code, (trueCounts.get(v.code) ?? 0) + 1);
    }
  }
  for (const tv of top_violations) {
    tv.count = trueCounts.get(tv.code) ?? tv.count;
  }
  top_violations.sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return a.code.localeCompare(b.code);
  });
  const trimmedViolations = top_violations.slice(0, MAX_TOP_VIOLATIONS);

  return {
    total_checks: checks.length,
    applicable_checks: applicable,
    overall_compliance: scoreSum / applicable,
    strict_pass_rate: strict / applicable,
    partial_pass_rate: partial / applicable,
    fail_rate: fail / applicable,
    violation_count: violationCount,
    by_workflow,
    top_violations: trimmedViolations,
    cross_tab,
    reliability,
  };
}

/**
 * Severity rank for cross-tab "WORST workflow outcome per run" reduction.
 * fail > partial > pass.
 */
function severityRank(b: "pass" | "partial" | "fail"): number {
  if (b === "fail") return 2;
  if (b === "partial") return 1;
  return 0;
}

/**
 * Recover the task-level outcome that produced a check, when available.
 * The check shape does not carry it directly; the runner stashes it on a
 * non-public side-channel field. Returns `undefined` when no task outcome
 * was attached (older callers, hand-written tests).
 */
function readCheckTaskOutcome(c: WorkflowCheckResult): string | undefined {
  return typeof c.taskOutcome === "string" ? c.taskOutcome : undefined;
}

/**
 * Render the §257 `## Workflow compliance` markdown section. Returns "" when
 * there are no checks so the report stays compact for runs without
 * applicable workflow specs.
 */
export function renderWorkflowComplianceSection(input: UtilityRunReport): string {
  const checks = input.workflowChecks ?? [];
  const agg = buildWorkflowAggregate(checks);
  if (agg.total_checks === 0) return "";

  const lines: string[] = [];
  lines.push("## Workflow compliance");
  lines.push("");
  if (agg.applicable_checks === 0) {
    lines.push("_No workflow specs applied to this corpus._");
    if (Object.keys(agg.by_workflow).length > 0) {
      lines.push("");
      lines.push(`Loaded specs (none matched the run): ${Object.keys(agg.by_workflow).sort().join(", ")}`);
    }
    return lines.join("\n");
  }

  lines.push(
    `overall_compliance=${agg.overall_compliance.toFixed(2)}, ` +
      `strict_pass_rate=${agg.strict_pass_rate.toFixed(2)}, ` +
      `partial_pass_rate=${agg.partial_pass_rate.toFixed(2)}, ` +
      `fail_rate=${agg.fail_rate.toFixed(2)}, ` +
      `violations=${agg.violation_count}`,
  );
  lines.push("");
  lines.push("### By workflow");
  lines.push("");
  lines.push("| workflow_id | applicable | score | pass | partial | fail | violations |");
  lines.push("|-------------|-----------:|------:|-----:|--------:|-----:|-----------:|");
  const sortedSpecs = Object.values(agg.by_workflow).sort((a, b) => a.workflow_id.localeCompare(b.workflow_id));
  for (const spec of sortedSpecs) {
    lines.push(
      `| ${spec.workflow_id} | ${spec.count} | ${spec.score.toFixed(2)} | ${spec.pass_rate.toFixed(2)} | ${spec.partial_rate.toFixed(2)} | ${spec.fail_rate.toFixed(2)} | ${spec.violation_count} |`,
    );
  }

  if (agg.top_violations.length > 0) {
    lines.push("");
    lines.push("### Top violations");
    lines.push("");
    lines.push("| code | count |");
    lines.push("|------|------:|");
    for (const tv of agg.top_violations) {
      lines.push(`| ${tv.code} | ${tv.count} |`);
    }
    // Surface the first evidence pointer per top-violation so operators can
    // jump to a concrete (task, seed) without parsing the JSON envelope.
    lines.push("");
    lines.push("### Violation evidence");
    lines.push("");
    lines.push("| code | task | seed | workflow | observed |");
    lines.push("|------|------|-----:|----------|----------|");
    for (const tv of agg.top_violations) {
      for (const ev of tv.evidence) {
        const observed = ev.observed ?? ev.message ?? "";
        lines.push(`| ${tv.code} | ${ev.task_id} | ${ev.seed} | ${ev.workflow_id} | ${truncateCell(observed)} |`);
      }
    }
  }

  if (agg.cross_tab.length > 0) {
    lines.push("");
    lines.push("### Task outcome × workflow outcome");
    lines.push("");
    lines.push("| task_outcome | wf_pass | wf_partial | wf_fail | total |");
    lines.push("|--------------|--------:|-----------:|--------:|------:|");
    for (const row of agg.cross_tab) {
      lines.push(`| ${row.task_outcome} | ${row.pass} | ${row.partial} | ${row.fail} | ${row.total} |`);
    }
  }

  // #258: Reliability sub-section. Skip when no group contributed (all
  // checks were `not_applicable` or input was empty).
  const reliability = agg.reliability;
  if (reliability.corpus.groups > 0) {
    lines.push("");
    lines.push("### Reliability (pass@k / pass^k)");
    lines.push("");
    lines.push(
      `corpus pass@k=${reliability.corpus.pass_at_k.toFixed(2)}, ` +
        `pass^k=${reliability.corpus.pass_all_k.toFixed(2)} ` +
        `(over ${reliability.corpus.groups} workflow×task groups, ${reliability.corpus.tasks} distinct tasks)`,
    );
    lines.push("");
    lines.push("| workflow_id | tasks | k | pass@k | pass^k |");
    lines.push("|-------------|------:|--:|-------:|-------:|");
    const sortedReliability = Object.values(reliability.by_workflow).sort((a, b) =>
      a.workflow_id.localeCompare(b.workflow_id),
    );
    for (const row of sortedReliability) {
      lines.push(
        `| ${row.workflow_id} | ${row.tasks} | ${row.k} | ${row.pass_at_k.toFixed(2)} | ${row.pass_all_k.toFixed(2)} |`,
      );
    }
    // Inconsistency callout: workflows where the agent CAN comply
    // (pass@k high) but does not RELIABLY comply (pass^k materially lower).
    // Threshold: pass@k ≥ 0.5 AND (pass@k − pass^k) ≥ 0.25.
    const INCONSISTENCY_GAP = 0.25;
    const PASS_AT_K_FLOOR = 0.5;
    const inconsistent = sortedReliability.filter(
      (r) => r.pass_at_k >= PASS_AT_K_FLOOR && r.pass_at_k - r.pass_all_k >= INCONSISTENCY_GAP,
    );
    if (inconsistent.length > 0) {
      lines.push("");
      lines.push("**Inconsistent workflows** (high pass@k but low pass^k — agent can comply but does not reliably):");
      lines.push("");
      for (const row of inconsistent) {
        lines.push(
          `- \`${row.workflow_id}\`: pass@k=${row.pass_at_k.toFixed(2)} vs pass^k=${row.pass_all_k.toFixed(2)} (gap ${(
            row.pass_at_k - row.pass_all_k
          ).toFixed(2)})`,
        );
      }
    }
  }

  return lines.join("\n");
}

/**
 * Trim a single cell so the markdown table stays scannable. We keep the
 * head 80 chars and append `…` when clamped.
 */
function truncateCell(s: string): string {
  if (s.length <= 80) return escapeMarkdownCell(s);
  return `${escapeMarkdownCell(s.slice(0, 80))}…`;
}

function escapeMarkdownCell(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
}
