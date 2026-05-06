/**
 * akm-bench evolve-track report renderer (§6.3 + §6.4).
 */

import type { LessonMetrics, LessonRecord, PostTaskLessonLineage } from "../evolve-metrics";
import type { FeedbackIntegrityMetrics } from "../metrics/feedback-integrity";
import type { LearningCurve } from "../metrics/learning-curve";
import type { LongitudinalMetrics } from "../metrics/longitudinal";
import type { ProposalQualityMetrics } from "../metrics/proposal-quality";
import type { UtilityReportTaskEntry, UtilityRunReport } from "../run-record";
import type { BenchReportEnvelope } from "../tmp";
import { serialiseSearchBridge } from "./search-bridge";
import { renderUtilityReport } from "./utility-track";

type EvolveReportJson = BenchReportEnvelope & {
  warnings: string[];
  feedback_integrity?: object;
};

// ── Evolve-track report (§6.3 + §6.4) ──────────────────────────────────────

/**
 * Top-level evolve report shape. Mirrors `EvolveRunReport` from `evolve.ts`
 * — re-declared here as a structural subtype so report.ts has no cycle on
 * evolve.ts.
 */
export interface EvolveReportInput {
  timestamp: string;
  branch: string;
  commit: string;
  model: string;
  domain: string;
  seedsPerArm: number;
  proposals: ProposalQualityMetrics;
  /**
   * Per-lesson quality + reuse metrics (#264). Optional so older artefacts
   * pre-#264 keep rendering without the `lessons` JSON block. When omitted,
   * the markdown summary skips the lessons section entirely.
   */
  lessons?: LessonMetrics;
  /** Minimal warm/post task lineage for lessons that fired. */
  lessonLineage?: PostTaskLessonLineage;
  longitudinal: LongitudinalMetrics;
  /**
   * Feedback-signal integrity 2x2 confusion matrix (§6.8). When omitted,
   * the markdown summary surfaces the legacy `_feedback_agreement: pending_`
   * placeholder; the JSON envelope omits the `feedback_integrity` key so
   * older artefacts remain valid.
   */
  feedbackIntegrity?: FeedbackIntegrityMetrics;
  /**
   * §6.4 (issue #265) — learning curve across evolution episodes. Optional;
   * when omitted both the JSON envelope's `learning` key and the markdown
   * "Learning curve" section are suppressed so older artefacts remain
   * valid. `episode_index === 0` is the pre-evolution baseline.
   */
  learningCurve?: LearningCurve;
  arms: { pre: UtilityRunReport; post: UtilityRunReport; synthetic: UtilityRunReport };
  warnings: string[];
}

/**
 * Threshold below which the markdown summary prepends a warning marker
 * and the JSON envelope's `warnings[]` carries a structured
 * `feedback_agreement_below_threshold` entry. Track B's headline numbers
 * (`improvement_slope`, `over_synthetic_lift`) are unreliable when
 * Phase 1 feedback disagrees with run outcomes more than 20% of the
 * time. Spec §6.8.
 */
export const FEEDBACK_AGREEMENT_WARNING_THRESHOLD = 0.8;

function signedFixed(value: number, digits: number): string {
  const abs = value.toFixed(digits);
  return value > 0 ? `+${abs}` : abs;
}

/**
 * Render an evolve run as the §6.3+§6.4 JSON envelope plus a markdown
 * summary. Mirrors `renderUtilityReport` — caller wires stdout/stderr.
 */
export function renderEvolveReport(input: EvolveReportInput): { json: EvolveReportJson; markdown: string } {
  const json = buildEvolveJson(input);
  const markdown = buildEvolveMarkdown(input);
  return { json, markdown };
}

function buildEvolveJson(input: EvolveReportInput): EvolveReportJson {
  // For each arm we re-render the §13.3 utility envelope so downstream
  // consumers can treat each arm exactly like a `bench utility` artefact.
  const armEnvelope = (r: UtilityRunReport): ReturnType<typeof renderUtilityReport>["json"] =>
    renderUtilityReport(r).json;

  // §6.8 — derive an additive `warnings[]` entry when the headline
  // feedback_agreement falls below the trust threshold.
  const augmentedWarnings: string[] = [...input.warnings];
  if (input.feedbackIntegrity) {
    const agreement = input.feedbackIntegrity.aggregate.feedback_agreement;
    if (agreement < FEEDBACK_AGREEMENT_WARNING_THRESHOLD) {
      augmentedWarnings.push(
        `feedback_agreement_below_threshold: ${agreement.toFixed(2)} < ${FEEDBACK_AGREEMENT_WARNING_THRESHOLD.toFixed(2)} — Track B headline numbers (improvement_slope, over_synthetic_lift) may be unreliable until AGENTS.md guidance for \`akm feedback\` is tightened.`,
      );
    }
  }

  return {
    schemaVersion: 1,
    track: "evolve",
    branch: input.branch,
    commit: input.commit,
    timestamp: input.timestamp,
    agent: { harness: "opencode", model: input.model },
    corpus: {
      domain: input.domain,
      seedsPerArm: input.seedsPerArm,
    },
    proposals: {
      total_proposals: input.proposals.totalProposals,
      total_accepted: input.proposals.totalAccepted,
      acceptance_rate: input.proposals.acceptanceRate,
      lint_pass_rate: input.proposals.lintPassRate,
      rows: input.proposals.rows.map((r) => ({
        asset_ref: r.assetRef,
        proposal_count: r.proposalCount,
        lint_pass_count: r.lintPassCount,
        accepted_count: r.acceptedCount,
      })),
    },
    ...(input.lessons ? { lessons: serialiseLessons(input.lessons) } : {}),
    ...(input.lessonLineage ? { lesson_lineage: serialiseLessonLineage(input.lessonLineage) } : {}),
    longitudinal: {
      improvement_slope: input.longitudinal.improvementSlope,
      pre_pass_rate_stdev: input.longitudinal.prePassRateStdev,
      post_pass_rate_stdev: input.longitudinal.postPassRateStdev,
      significance_threshold: input.longitudinal.significanceThreshold,
      interpretation: input.longitudinal.interpretation,
      over_synthetic_lift: input.longitudinal.overSyntheticLift,
      degradation_count: input.longitudinal.degradationCount,
      pre_pass_rate: input.longitudinal.prePassRate,
      post_pass_rate: input.longitudinal.postPassRate,
      synthetic_pass_rate: input.longitudinal.syntheticPassRate,
      degradations: input.longitudinal.degradations.map((d) => ({
        task_id: d.taskId,
        pre_pass_rate: d.prePassRate,
        post_pass_rate: d.postPassRate,
        delta: d.delta,
        failure_mode: d.failureMode,
      })),
    },
    ...(input.learningCurve ? { learning: serialiseLearningCurve(input.learningCurve) } : {}),
    arms: {
      pre: armEnvelope(input.arms.pre),
      post: armEnvelope(input.arms.post),
      synthetic: armEnvelope(input.arms.synthetic),
    },
    perAsset: input.arms.post.perAsset
      ? {
          total_akm_runs: input.arms.post.perAsset.totalAkmRuns,
          rows: input.arms.post.perAsset.rows.map((r) => ({
            asset_ref: r.assetRef,
            load_count: r.loadCount,
            load_count_passing: r.loadCountPassing,
            load_count_failing: r.loadCountFailing,
            load_pass_rate: r.loadPassRate,
          })),
        }
      : { total_akm_runs: 0, rows: [] },
    failure_modes: {
      by_label: input.arms.post.failureModes.byLabel,
      by_task: input.arms.post.failureModes.byTask,
    },
    ...(input.arms.post.searchBridge ? { searchBridge: serialiseSearchBridge(input.arms.post.searchBridge) } : {}),
    ...(input.feedbackIntegrity ? { feedback_integrity: serialiseFeedbackIntegrity(input.feedbackIntegrity) } : {}),
    warnings: augmentedWarnings,
  };
}

/**
 * #264 — flatten the LessonMetrics envelope into JSON. Aggregate counters
 * sit alongside `lessons[]` so consumers can pick the headline numbers off
 * without walking every row.
 */
function serialiseLessons(metrics: LessonMetrics): object {
  return {
    lessons_created_count: metrics.lessons_created_count,
    lessons_accepted_count: metrics.lessons_accepted_count,
    proposal_lint_pass_rate: metrics.proposal_lint_pass_rate,
    proposal_acceptance_rate: metrics.proposal_acceptance_rate,
    lesson_reuse_rate: metrics.lesson_reuse_rate,
    lesson_reuse_success_rate: metrics.lesson_reuse_success_rate,
    lesson_negative_transfer_count: metrics.lesson_negative_transfer_count,
    lessons: metrics.lessons.map((l: LessonRecord) => ({
      ref: l.ref,
      source_failures: l.source_failures,
      lint_pass: l.lint_pass,
      accepted: l.accepted,
      first_reused_on: l.first_reused_on,
      reuse_count: l.reuse_count,
      reuse_pass_rate: l.reuse_pass_rate,
      negative_transfer_count: l.negative_transfer_count,
      leakage_risk: l.leakage_risk,
    })),
  };
}

function serialiseLessonLineage(lineage: PostTaskLessonLineage): object {
  return {
    post_tasks: lineage.post_tasks.map((task) => ({
      task_id: task.task_id,
      lessons: task.lessons.map((lesson) => ({
        ref: lesson.ref,
        accepted: lesson.accepted,
        fired_count: lesson.fired_count,
        source_failures: lesson.source_failures,
      })),
    })),
  };
}

/**
 * §6.4 (issue #265) — flatten a `LearningCurve` into its JSON envelope.
 * Mirrors the suggested shape from the issue body: an `episodes[]` block
 * with per-episode rows, plus the headline `learning_slope` and
 * `time_to_improvement`. `pass_rate_by_episode` is exposed as a flat array
 * for tools that want to plot without re-projecting the rows.
 */
function serialiseLearningCurve(curve: LearningCurve): {
  episodes: Array<{
    episode_index: number;
    pass_rate: number;
    delta_from_previous_episode: number;
    cumulative_feedback_events: number;
    cumulative_proposals_created: number;
    cumulative_proposals_accepted: number;
    cumulative_lessons_created: number;
    lesson_reuse_rate: number | null;
  }>;
  pass_rate_by_episode: number[];
  learning_slope: number;
  time_to_improvement: number | null;
} {
  return {
    episodes: curve.episodes.map((ep) => ({
      episode_index: ep.episode_index,
      pass_rate: ep.pass_rate,
      delta_from_previous_episode: ep.delta_from_previous_episode,
      cumulative_feedback_events: ep.cumulative_feedback_events,
      cumulative_proposals_created: ep.cumulative_proposals_created,
      cumulative_proposals_accepted: ep.cumulative_proposals_accepted,
      cumulative_lessons_created: ep.cumulative_lessons_created,
      lesson_reuse_rate: ep.lesson_reuse_rate,
    })),
    pass_rate_by_episode: curve.pass_rate_by_episode.slice(),
    learning_slope: curve.learning_slope,
    time_to_improvement: curve.time_to_improvement,
  };
}

/**
 * §6.4 (issue #265) — render a compact "Learning curve" markdown table.
 * One row per episode plus the headline slope + time-to-improvement.
 */
export function renderLearningCurveSection(curve: LearningCurve): string {
  const lines: string[] = [];
  lines.push("## Learning curve");
  lines.push("");
  lines.push(
    `learning_slope=${signedFixed(curve.learning_slope, 3)}, time_to_improvement=${
      curve.time_to_improvement === null ? "n/a" : String(curve.time_to_improvement)
    }`,
  );
  lines.push("");
  if (curve.episodes.length === 0) {
    lines.push("_No episodes recorded._");
    return lines.join("\n");
  }
  lines.push("| episode | pass_rate | Δ prev | feedback | proposals | accepted | lessons | reuse |");
  lines.push("|--------:|----------:|-------:|---------:|----------:|---------:|--------:|------:|");
  for (const ep of curve.episodes) {
    lines.push(
      `| ${ep.episode_index} | ${ep.pass_rate.toFixed(2)} | ${signedFixed(ep.delta_from_previous_episode, 2)} | ${ep.cumulative_feedback_events} | ${ep.cumulative_proposals_created} | ${ep.cumulative_proposals_accepted} | ${ep.cumulative_lessons_created} | ${
        ep.lesson_reuse_rate === null ? "n/a" : ep.lesson_reuse_rate.toFixed(2)
      } |`,
    );
  }
  return lines.join("\n");
}

/** §6.8 — flatten the FeedbackIntegrityMetrics envelope into JSON. */
function serialiseFeedbackIntegrity(metrics: FeedbackIntegrityMetrics): object {
  return {
    aggregate: {
      truePositive: metrics.aggregate.truePositive,
      falsePositive: metrics.aggregate.falsePositive,
      trueNegative: metrics.aggregate.trueNegative,
      falseNegative: metrics.aggregate.falseNegative,
      feedback_agreement: metrics.aggregate.feedback_agreement,
      false_positive_rate: metrics.aggregate.false_positive_rate,
      false_negative_rate: metrics.aggregate.false_negative_rate,
      feedback_coverage: metrics.aggregate.feedback_coverage,
    },
    perAsset: metrics.perAsset.map((row) => ({
      ref: row.ref,
      truePositive: row.truePositive,
      falsePositive: row.falsePositive,
      trueNegative: row.trueNegative,
      falseNegative: row.falseNegative,
      feedback_agreement: row.feedback_agreement,
      false_positive_rate: row.false_positive_rate,
      false_negative_rate: row.false_negative_rate,
    })),
  };
}

/**
 * Render the #264 lessons block — aggregate counters followed by one row
 * per lesson. Exported for tests so the rendered shape can be asserted
 * directly without going through `renderEvolveReport`.
 */
export function renderLessonsTable(metrics: LessonMetrics): string {
  const lines: string[] = [];
  lines.push("## Lessons");
  lines.push("");
  lines.push(
    `created=${metrics.lessons_created_count}, accepted=${metrics.lessons_accepted_count}, reuse_rate=${metrics.lesson_reuse_rate.toFixed(2)}, reuse_success_rate=${metrics.lesson_reuse_success_rate.toFixed(2)}, negative_transfer=${metrics.lesson_negative_transfer_count}`,
  );
  lines.push("");
  if (metrics.lessons.length === 0) {
    lines.push("_No lessons generated._");
    return lines.join("\n");
  }
  lines.push("| ref | accepted | lint | reuse | reuse_pass | first_reused_on | neg_transfer | leakage |");
  lines.push("|-----|----------|------|-------|------------|-----------------|--------------|---------|");
  for (const l of metrics.lessons) {
    lines.push(
      `| \`${l.ref}\` | ${l.accepted ? "yes" : "no"} | ${l.lint_pass ? "pass" : "fail"} | ${l.reuse_count} | ${l.reuse_pass_rate.toFixed(2)} | ${l.first_reused_on ?? "n/a"} | ${l.negative_transfer_count} | ${l.leakage_risk} |`,
    );
  }
  return lines.join("\n");
}

export function renderLessonLineageSection(lineage: PostTaskLessonLineage): string {
  const lines: string[] = [];
  lines.push("## Lesson lineage");
  lines.push("");
  if (lineage.post_tasks.length === 0) {
    lines.push("_No generated lessons fired on post-arm tasks._");
    return lines.join("\n");
  }

  lines.push("| post_task | lesson_ref | accepted | fired | phase1_source_failures |");
  lines.push("|-----------|------------|----------|-------|------------------------|");
  for (const task of lineage.post_tasks) {
    for (const lesson of task.lessons) {
      lines.push(
        `| ${task.task_id} | \`${lesson.ref}\` | ${lesson.accepted ? "yes" : "no"} | ${lesson.fired_count} | ${lesson.source_failures.length > 0 ? lesson.source_failures.join(", ") : "n/a"} |`,
      );
    }
  }
  return lines.join("\n");
}

/**
 * Render the §6.8 confusion-matrix table — aggregate 2×2 followed by
 * per-asset breakdown. Used by `renderEvolveReport`'s markdown body and
 * exported for tests.
 */
export function renderFeedbackIntegrityTable(metrics: FeedbackIntegrityMetrics): string {
  const lines: string[] = [];
  const agg = metrics.aggregate;
  lines.push("## Feedback-signal integrity");
  lines.push("");
  lines.push("|              | run passed | run failed |");
  lines.push("|--------------|-----------:|-----------:|");
  lines.push(`| feedback +   | ${agg.truePositive} (TP) | ${agg.falsePositive} (FP) |`);
  lines.push(`| feedback -   | ${agg.falseNegative} (FN) | ${agg.trueNegative} (TN) |`);
  lines.push("");
  lines.push("| metric | value |");
  lines.push("|--------|-------|");
  lines.push(`| feedback_agreement | ${agg.feedback_agreement.toFixed(2)} |`);
  lines.push(`| false_positive_rate | ${agg.false_positive_rate.toFixed(2)} |`);
  lines.push(`| false_negative_rate | ${agg.false_negative_rate.toFixed(2)} |`);
  lines.push(`| feedback_coverage | ${agg.feedback_coverage.toFixed(2)} |`);
  lines.push("");
  if (metrics.perAsset.length > 0) {
    lines.push("| ref | TP | FP | TN | FN | agreement | FP rate | FN rate |");
    lines.push("|-----|----|----|----|----|-----------|---------|---------|");
    for (const row of metrics.perAsset) {
      lines.push(
        `| \`${row.ref}\` | ${row.truePositive} | ${row.falsePositive} | ${row.trueNegative} | ${row.falseNegative} | ${formatNullableRate(row.feedback_agreement)} | ${formatNullableRate(row.false_positive_rate)} | ${formatNullableRate(row.false_negative_rate)} |`,
      );
    }
  } else {
    lines.push("_No feedback events recorded._");
  }
  return lines.join("\n");
}

function formatNullableRate(value: number | null): string {
  if (value === null) return "n/a";
  return value.toFixed(2);
}

function buildEvolveMarkdown(input: EvolveReportInput): string {
  const lines: string[] = [];
  lines.push(`# akm-bench evolve — ${input.model}`);
  lines.push("");
  lines.push(`branch \`${input.branch}\` @ \`${input.commit}\` — ${input.timestamp}`);
  lines.push(`corpus: domain=\`${input.domain}\`, seedsPerArm=${input.seedsPerArm}`);
  lines.push("");

  // §6.8 warning marker — prepended above the headline so operators can't
  // miss it. We also still surface the structured warning in `warnings[]`.
  if (
    input.feedbackIntegrity &&
    input.feedbackIntegrity.aggregate.feedback_agreement < FEEDBACK_AGREEMENT_WARNING_THRESHOLD
  ) {
    lines.push(
      `:warning: feedback_agreement = ${input.feedbackIntegrity.aggregate.feedback_agreement.toFixed(2)} — Track B headline numbers (improvement_slope, over_synthetic_lift) may be unreliable until AGENTS.md guidance for \`akm feedback\` is tightened.`,
    );
    lines.push("");
  }

  // Headline: improvement_slope.
  lines.push(
    `**improvement_slope: ${signedFixed(input.longitudinal.improvementSlope, 2)}** (post=${input.longitudinal.postPassRate.toFixed(2)}, pre=${input.longitudinal.prePassRate.toFixed(2)})`,
  );
  lines.push(
    `**${input.longitudinal.interpretation}** (delta ${signedFixed(input.longitudinal.improvementSlope, 2)} vs threshold ${input.longitudinal.significanceThreshold.toFixed(2)}; pre_stdev=${input.longitudinal.prePassRateStdev.toFixed(2)}, post_stdev=${input.longitudinal.postPassRateStdev.toFixed(2)})`,
  );
  // Second line: real feedback_agreement (per #244), or placeholder when
  // metrics not supplied.
  if (input.feedbackIntegrity) {
    lines.push(
      `**feedback_agreement: ${input.feedbackIntegrity.aggregate.feedback_agreement.toFixed(2)}** (coverage=${input.feedbackIntegrity.aggregate.feedback_coverage.toFixed(2)})`,
    );
  } else {
    lines.push("_feedback_agreement: pending (#244)_");
  }
  lines.push("");

  lines.push("## Longitudinal");
  lines.push("");
  lines.push("| metric | value |");
  lines.push("|--------|-------|");
  lines.push(`| improvement_slope | ${signedFixed(input.longitudinal.improvementSlope, 2)} |`);
  lines.push(`| interpretation | ${input.longitudinal.interpretation} |`);
  lines.push(`| pre_pass_rate_stdev | ${input.longitudinal.prePassRateStdev.toFixed(2)} |`);
  lines.push(`| post_pass_rate_stdev | ${input.longitudinal.postPassRateStdev.toFixed(2)} |`);
  lines.push(`| significance_threshold | ${input.longitudinal.significanceThreshold.toFixed(2)} |`);
  lines.push(`| over_synthetic_lift | ${signedFixed(input.longitudinal.overSyntheticLift, 2)} |`);
  lines.push(`| degradation_count | ${input.longitudinal.degradationCount} |`);
  lines.push(`| pre_pass_rate | ${input.longitudinal.prePassRate.toFixed(2)} |`);
  lines.push(`| post_pass_rate | ${input.longitudinal.postPassRate.toFixed(2)} |`);
  lines.push(`| synthetic_pass_rate | ${input.longitudinal.syntheticPassRate.toFixed(2)} |`);
  lines.push("");

  if (input.longitudinal.degradations.length > 0) {
    lines.push("### Degradations");
    lines.push("");
    lines.push("| task | pre | post | delta | failure_mode |");
    lines.push("|------|-----|------|-------|--------------|");
    for (const d of input.longitudinal.degradations) {
      lines.push(
        `| ${d.taskId} | ${d.prePassRate.toFixed(2)} | ${d.postPassRate.toFixed(2)} | ${signedFixed(d.delta, 2)} | ${d.failureMode ?? "n/a"} |`,
      );
    }
    lines.push("");
  }

  lines.push("## Proposals");
  lines.push("");
  lines.push(
    `acceptance_rate=${input.proposals.acceptanceRate.toFixed(2)}, lint_pass_rate=${input.proposals.lintPassRate.toFixed(2)}, total=${input.proposals.totalProposals}`,
  );
  lines.push("");
  if (input.proposals.rows.length > 0) {
    lines.push("| asset_ref | proposals | lint_pass | accepted |");
    lines.push("|-----------|-----------|-----------|----------|");
    for (const row of input.proposals.rows) {
      lines.push(`| \`${row.assetRef}\` | ${row.proposalCount} | ${row.lintPassCount} | ${row.acceptedCount} |`);
    }
    lines.push("");
  } else {
    lines.push("_No proposals generated._");
    lines.push("");
  }

  if (input.lessons) {
    lines.push(renderLessonsTable(input.lessons));
    lines.push("");
  }

  if (input.lessonLineage) {
    lines.push(renderLessonLineageSection(input.lessonLineage));
    lines.push("");
  }

  lines.push("## Per-task pre → post → synthetic");
  lines.push("");
  lines.push("| task | pre | post | synthetic | post − pre |");
  lines.push("|------|-----|------|-----------|------------|");
  const preTasks = new Map<string, UtilityReportTaskEntry>();
  for (const t of input.arms.pre.tasks) preTasks.set(t.id, t);
  const postTasks = new Map<string, UtilityReportTaskEntry>();
  for (const t of input.arms.post.tasks) postTasks.set(t.id, t);
  const synthTasks = new Map<string, UtilityReportTaskEntry>();
  for (const t of input.arms.synthetic.tasks) synthTasks.set(t.id, t);
  const allIds = new Set<string>([...preTasks.keys(), ...postTasks.keys(), ...synthTasks.keys()]);
  for (const id of [...allIds].sort()) {
    const pre = preTasks.get(id)?.akm.passRate;
    const post = postTasks.get(id)?.akm.passRate;
    const synth = synthTasks.get(id)?.akm.passRate;
    const delta = pre !== undefined && post !== undefined ? signedFixed(post - pre, 2) : "n/a";
    lines.push(
      `| ${id} | ${pre === undefined ? "n/a" : pre.toFixed(2)} | ${post === undefined ? "n/a" : post.toFixed(2)} | ${synth === undefined ? "n/a" : synth.toFixed(2)} | ${delta} |`,
    );
  }

  if (input.feedbackIntegrity) {
    lines.push("");
    lines.push(renderFeedbackIntegrityTable(input.feedbackIntegrity));
  }

  if (input.learningCurve) {
    lines.push("");
    lines.push(renderLearningCurveSection(input.learningCurve));
  }

  if (input.warnings.length > 0) {
    lines.push("");
    lines.push("## Warnings");
    lines.push("");
    for (const w of input.warnings) lines.push(`- ${w}`);
  }
  return lines.join("\n");
}
