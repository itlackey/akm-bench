/**
 * akm-bench utility-track report renderer (§13.3).
 */

import {
  computeAssetRegressionCandidates,
  computeDomainAggregates,
  computeNegativeTransfer,
} from "../metrics/negative-transfer";
import type { CorpusDelta, CorpusMetrics, PerTaskMetrics } from "../metrics/outcome";
import type { UtilityReportTaskEntry, UtilityRunReport } from "../run-record";
import { serializeRunForReport } from "../run-record";
import type { BenchReportEnvelope } from "../tmp";
import { buildCorpusCoverageBlock, renderCorpusCoverageSection } from "./coverage";
import { renderFailureModeBreakdown } from "./failure-modes";
import {
  renderNegativeTransferSection,
  serialiseAssetRegressionCandidate,
  serialiseDomainAggregate,
} from "./negative-transfer";
import { buildAkmOverheadBlock, renderAkmOverheadSection } from "./overhead";
import { renderSearchBridgeTable, serialiseSearchBridge } from "./search-bridge";
import { buildWorkflowAggregate, renderWorkflowComplianceSection } from "./workflow-compliance";

type UtilityReportJson = BenchReportEnvelope & {
  corpus: Record<string, unknown>;
  warnings: string[];
};

export function renderUtilityReport(input: UtilityRunReport): { json: UtilityReportJson; markdown: string } {
  const json = buildUtilityJson(input);
  const markdown = buildUtilityMarkdown(input);
  return { json, markdown };
}

function buildUtilityJson(input: UtilityRunReport): UtilityReportJson {
  const includeSynth = input.aggregateSynth !== undefined;
  const tasks = input.tasks.map((t) => ({
    id: t.id,
    noakm: serialisePerTaskMetrics(t.noakm),
    akm: serialisePerTaskMetrics(t.akm),
    delta: serialiseDelta(t.delta),
    // #261: per-task synthetic block is emitted ONLY when the runner opted
    // into the synthetic arm AND this task carries a synthetic aggregate.
    // When the arm was not run we leave the key absent — a missing arm is
    // not a zero-pass arm.
    ...(includeSynth && t.synthetic ? { synthetic: serialisePerTaskMetrics(t.synthetic) } : {}),
  }));

  // Negative-transfer + domain-level diagnostics (#260). Pure post-processing
  // off `input.tasks` and `input.akmRuns` — runner.ts is intentionally
  // untouched so this slots in alongside the per-task entries that already
  // carry both arms via UtilityReportTaskEntry.
  const negativeTransfer = computeNegativeTransfer(input.tasks);
  const domainDeltas = computeDomainAggregates(input.tasks);
  const assetRegressionCandidates = computeAssetRegressionCandidates(
    negativeTransfer.topRegressedTasks.map((r) => r.taskId),
    input.akmRuns ?? [],
  );

  // Token-measurement coverage (issue #252). Folds the corpus-wide picture so
  // operators can tell at a glance whether token economics are reliable. The
  // warning string mirrors what we add to `warnings[]` in markdown output.
  const tokenMeasurement = summariseTokenMeasurement(input);

  const warnings = [...input.warnings];
  if (tokenMeasurement.warning) warnings.push(tokenMeasurement.warning);

  const envelope: UtilityReportJson = {
    schemaVersion: 1,
    track: "utility",
    branch: input.branch,
    commit: input.commit,
    timestamp: input.timestamp,
    agent: { harness: "opencode", model: input.model },
    corpus: input.corpus,
    aggregate: {
      noakm: serialiseCorpus(input.aggregateNoakm),
      akm: serialiseCorpus(input.aggregateAkm),
      delta: serialiseDelta(input.aggregateDelta),
      // #261: synthetic aggregate is emitted ONLY when includeSynthetic
      // was set on the runner. Absent otherwise — byte-identical to the
      // pre-#261 envelope.
      ...(input.aggregateSynth ? { synthetic: serialiseCorpus(input.aggregateSynth) } : {}),
      // #261: akm_over_synthetic_lift = passRate(akm) - passRate(synthetic).
      // Only computed when the synthetic arm ran. Positive => AKM beats the
      // synthetic-notes baseline; non-positive flags AKM is not adding value
      // beyond what the model can synthesise on its own.
      ...(input.aggregateSynth
        ? { akm_over_synthetic_lift: input.aggregateAkm.passRate - input.aggregateSynth.passRate }
        : {}),
    },
    trajectory: {
      akm: {
        correct_asset_loaded: input.trajectoryAkm.correctAssetLoaded,
        feedback_recorded: input.trajectoryAkm.feedbackRecorded,
      },
    },
    failure_modes: {
      by_label: input.failureModes.byLabel,
      by_task: input.failureModes.byTask,
    },
    token_measurement: {
      total_runs: tokenMeasurement.totalRuns,
      runs_with_measured_tokens: tokenMeasurement.measuredRuns,
      runs_missing_measurement: tokenMeasurement.missingRuns,
      runs_unsupported_measurement: tokenMeasurement.unsupportedRuns,
      coverage: tokenMeasurement.coverage,
      reliable: tokenMeasurement.reliable,
    },
    tasks,
    negative_transfer_count: negativeTransfer.count,
    negative_transfer_severity: negativeTransfer.severity,
    top_regressed_tasks: negativeTransfer.topRegressedTasks.map((r) => ({
      task_id: r.taskId,
      domain: r.domain,
      noakm_pass_rate: r.noakmPassRate,
      akm_pass_rate: r.akmPassRate,
      delta: r.delta,
      severity: r.severity,
    })),
    domain_level_deltas: domainDeltas.map(serialiseDomainAggregate),
    asset_regression_candidates: assetRegressionCandidates.map(serialiseAssetRegressionCandidate),
    corpus_coverage: buildCorpusCoverageBlock(input),
    workflow: buildWorkflowAggregate(input.workflowChecks ?? []),
    warnings,
    ...(input.searchBridge ? { searchBridge: serialiseSearchBridge(input.searchBridge) } : {}),
    request_metrics: buildRequestMetricsBlock(input),
  };

  // Compact raw runs[] — additive top-level key (#249). One row per
  // (task, arm, seed) execution; both noakm and akm. Older artefacts that
  // pre-date this field stay valid because we only emit it when the runner
  // actually populated `allRuns`.
  if (input.allRuns) {
    envelope.runs = input.allRuns.map(serializeRunForReport);
  }

  // Baseline pass-rate map — additive top-level key. Emitted only when the
  // caller supplied a baseline through `loadBenchRunConfig`; legacy reports
  // stay byte-identical without it.
  if (input.baselineByTaskId) {
    envelope.baseline_by_task_id = { ...input.baselineByTaskId };
  }

  // Per-asset attribution is an additive top-level key (§6.5). Emit it only
  // when the runner populated it so older code paths (e.g. the empty-corpus
  // skeleton) don't gain the key spuriously.
  if (input.perAsset) {
    envelope.perAsset = {
      total_akm_runs: input.perAsset.totalAkmRuns,
      rows: input.perAsset.rows.map((r) => ({
        asset_ref: r.assetRef,
        load_count: r.loadCount,
        load_count_passing: r.loadCountPassing,
        load_count_failing: r.loadCountFailing,
        load_pass_rate: r.loadPassRate,
      })),
    };
  }

  // AKM overhead + tool-use efficiency block (#263). Computed from the akm-
  // arm RunResults attached to the report; missing akmRuns yields an empty
  // aggregate so the key shape stays stable.
  envelope.akm_overhead = buildAkmOverheadBlock(input);

  return envelope;
}

function buildRequestMetricsBlock(input: UtilityRunReport): {
  total_requests: number;
  total_tokens: number;
  runs_with_request_metrics: number;
  per_run: Array<{
    task_id: string;
    arm: string;
    seed: number;
    total_requests: number;
    total_tokens: number;
    source: string;
    steps: Array<{
      request_index: number;
      input: number;
      output: number;
      total: number;
    }>;
  }>;
} {
  const runs = input.allRuns ?? [];
  const perRun = runs.map((run) => ({
    task_id: run.taskId,
    arm: run.arm,
    seed: run.seed,
    total_requests: run.requestMetrics?.totalRequests ?? 0,
    total_tokens: run.requestMetrics?.totalTokens ?? 0,
    source: run.requestMetrics?.source ?? "missing",
    steps: (run.requestMetrics?.steps ?? []).map((step) => ({
      request_index: step.requestIndex,
      input: step.input,
      output: step.output,
      total: step.total,
    })),
  }));
  let totalRequests = 0;
  let totalTokens = 0;
  let runsWithRequestMetrics = 0;
  for (const row of perRun) {
    totalRequests += row.total_requests;
    totalTokens += row.total_tokens;
    if (row.total_requests > 0 || row.steps.length > 0) runsWithRequestMetrics += 1;
  }
  return {
    total_requests: totalRequests,
    total_tokens: totalTokens,
    runs_with_request_metrics: runsWithRequestMetrics,
    per_run: perRun,
  };
}

function serialiseCorpus(c: CorpusMetrics): {
  pass_rate: number;
  tokens_per_pass: number | null;
  tokens_per_run: number | null;
  wallclock_ms: number;
} {
  return {
    pass_rate: c.passRate,
    tokens_per_pass: c.tokensPerPass,
    tokens_per_run: c.tokensPerRun,
    wallclock_ms: c.wallclockMs,
  };
}

function serialiseDelta(d: CorpusDelta): {
  pass_rate: number;
  tokens_per_pass: number | null;
  tokens_per_run: number | null;
  wallclock_ms: number;
} {
  return {
    pass_rate: d.passRate,
    tokens_per_pass: d.tokensPerPass,
    tokens_per_run: d.tokensPerRun,
    wallclock_ms: d.wallclockMs,
  };
}

function serialisePerTaskMetrics(m: PerTaskMetrics): {
  pass_rate: number;
  pass_at_1: 0 | 1;
  tokens_per_pass: number | null;
  tokens_per_run: number | null;
  wallclock_ms: number;
  pass_rate_stdev: number;
  budget_exceeded_count: number;
  harness_error_count: number;
  count: number;
  runs_with_measured_tokens: number;
} {
  return {
    pass_rate: m.passRate,
    pass_at_1: m.passAt1,
    tokens_per_pass: m.tokensPerPass,
    tokens_per_run: m.tokensPerRun,
    wallclock_ms: m.wallclockMs,
    pass_rate_stdev: m.passRateStdev,
    budget_exceeded_count: m.budgetExceededCount,
    harness_error_count: m.harnessErrorCount,
    count: m.count,
    runs_with_measured_tokens: m.runsWithMeasuredTokens,
  };
}

/**
 * Token-measurement coverage summary (issue #252). The `warning` string is
 * non-null whenever any run lacks parsed token measurement; report renderers
 * splice it into `warnings[]` so the markdown "## Warnings" section and the
 * JSON `warnings` array surface the same prose.
 *
 * `coverage` is `null` when there are no akm-arm runs (nothing to measure
 * against — distinct from "0 / 0 = NaN"). `reliable` is `true` only when
 * every akm run carried `tokenMeasurement === "parsed"`.
 */
interface TokenMeasurementSummary {
  totalRuns: number;
  measuredRuns: number;
  missingRuns: number;
  unsupportedRuns: number;
  coverage: number | null;
  reliable: boolean;
  warning: string | null;
}

function summariseTokenMeasurement(input: UtilityRunReport): TokenMeasurementSummary {
  const runs = input.akmRuns ?? [];
  let measured = 0;
  let missing = 0;
  let unsupported = 0;
  for (const r of runs) {
    const m = r.tokenMeasurement ?? "parsed";
    if (m === "parsed") measured += 1;
    else if (m === "missing") missing += 1;
    else if (m === "unsupported") unsupported += 1;
  }
  const total = runs.length;
  const coverage = total === 0 ? null : measured / total;
  const reliable = total > 0 && missing === 0 && unsupported === 0;
  let warning: string | null = null;
  if (total > 0 && !reliable) {
    const parts: string[] = [];
    if (missing > 0) parts.push(`${missing} missing`);
    if (unsupported > 0) parts.push(`${unsupported} unsupported`);
    warning =
      `token measurement unreliable: ${parts.join(", ")} of ${total} akm-arm runs lack parsed token usage; ` +
      `tokens_per_pass and token-budget signals reflect only the ${measured} measured runs.`;
  }
  return {
    totalRuns: total,
    measuredRuns: measured,
    missingRuns: missing,
    unsupportedRuns: unsupported,
    coverage,
    reliable,
    warning,
  };
}

function buildUtilityMarkdown(input: UtilityRunReport): string {
  const lines: string[] = [];
  lines.push(`# akm-bench utility — ${input.model}`);
  lines.push("");
  lines.push(`branch \`${input.branch}\` @ \`${input.commit}\` — ${input.timestamp}`);
  lines.push(
    `corpus: ${input.corpus.tasks} tasks across ${input.corpus.domains} domains (slice=${input.corpus.slice}, seedsPerArm=${input.corpus.seedsPerArm})`,
  );
  lines.push("");
  lines.push("## Aggregate");
  lines.push("");
  lines.push("| arm | pass_rate | tokens_per_pass | wallclock_ms |");
  lines.push("|-----|-----------|-----------------|--------------|");
  lines.push(corpusRow("noakm", input.aggregateNoakm));
  // #261: synthetic row sits between noakm and akm so the columns read
  // baseline → synthetic → akm in the natural progression. Only rendered
  // when the runner opted into the synthetic arm.
  if (input.aggregateSynth) {
    lines.push(corpusRow("synthetic", input.aggregateSynth));
  }
  lines.push(corpusRow("akm", input.aggregateAkm));
  lines.push(deltaRow(input.aggregateDelta));
  // #261: akm_over_synthetic_lift summary line. When AKM does not beat the
  // synthetic baseline (lift <= 0) we surface a warning marker so operators
  // cannot miss the regression. Otherwise we render the lift as an
  // informative line.
  if (input.aggregateSynth) {
    const lift = input.aggregateAkm.passRate - input.aggregateSynth.passRate;
    lines.push("");
    if (lift <= 0) {
      lines.push(
        `:warning: **akm_over_synthetic_lift = ${signedFixed(lift, 2)}** — AKM did not beat the synthetic-notes baseline.`,
      );
    } else {
      lines.push(`**akm_over_synthetic_lift: ${signedFixed(lift, 2)}**`);
    }
  }
  lines.push("");
  lines.push("## Trajectory (akm)");
  lines.push("");
  lines.push(`- correct_asset_loaded: ${formatPercent(input.trajectoryAkm.correctAssetLoaded)}`);
  lines.push(`- feedback_recorded: ${formatPercent(input.trajectoryAkm.feedbackRecorded)}`);
  // Per-run trajectory detail: when allRuns is present emit a compact table
  // so operators can distinguish null (harness error — no events captured)
  // from false (agent ran, behaviour not observed) from true (confirmed).
  // Symbols: "—" = null, "✗" = false, "✓" = true.
  const akmRuns = (input.allRuns ?? []).filter((r) => r.arm === "akm");
  if (akmRuns.length > 0) {
    lines.push("");
    lines.push("| task | seed | correct_asset_loaded | feedback_recorded |");
    lines.push("|------|------|----------------------|-------------------|");
    for (const r of akmRuns) {
      lines.push(
        `| ${r.taskId} | ${r.seed} | ${formatTrajBool(r.trajectory.correctAssetLoaded)} | ${formatTrajBool(r.trajectory.feedbackRecorded)} |`,
      );
    }
  }
  lines.push("");
  lines.push("## Per-task pass rates");
  lines.push("");
  // #261: synthetic column is rendered only when the synthetic arm ran.
  // The default header/row stays identical to the pre-#261 output.
  // Baseline column is rendered only when `baselineByTaskId` was supplied
  // by the caller; legacy reports without it produce byte-identical output.
  const includeSynthCol = input.aggregateSynth !== undefined;
  const baselineMap = input.baselineByTaskId;
  const includeBaselineCol = baselineMap !== undefined;
  const baseColHeader = includeBaselineCol ? " baseline | vs base |" : "";
  const baseColSep = includeBaselineCol ? "----------|---------|" : "";
  if (includeSynthCol) {
    lines.push(`| task | noakm | synthetic | akm | delta |${baseColHeader}`);
    lines.push(`|------|-------|-----------|-----|-------|${baseColSep}`);
  } else {
    lines.push(`| task | noakm | akm | delta |${baseColHeader}`);
    lines.push(`|------|-------|-----|-------|${baseColSep}`);
  }
  // Sort tasks alphabetically for byte-stable markdown output.
  const sorted = [...input.tasks].sort((a, b) => a.id.localeCompare(b.id));
  for (const t of sorted) {
    lines.push(taskRow(t, includeSynthCol, baselineMap));
  }
  // Corpus-coverage section (#262). Renders only when at least one task was
  // tagged with a `memory_ability`; without tags the section adds no signal
  // and would just churn snapshots.
  const coverageSection = renderCorpusCoverageSection(input);
  if (coverageSection.length > 0) {
    lines.push("");
    lines.push(coverageSection);
  }
  // Negative-transfer + domain diagnostics (#260). The section stays quiet
  // ("none") when no regressions were observed so green corpora don't fill
  // the report with empty subheaders.
  const negativeTransferSection = renderNegativeTransferSection(input);
  lines.push("");
  lines.push(negativeTransferSection);
  // Failure-mode breakdown (§6.6). Appended near the bottom so the headline
  // pass-rate / trajectory tables stay visually anchored at the top.
  const failureSection = renderFailureModeBreakdown(input);
  if (failureSection.length > 0) {
    lines.push("");
    lines.push(failureSection);
  }
  if (input.searchBridge) {
    lines.push("");
    lines.push(renderSearchBridgeTable(input.searchBridge));
  }

  // #257: workflow compliance section. `renderWorkflowComplianceSection`
  // returns "" when there are no checks, so we only push the blank-line
  // separator when there's actually content to render.
  const workflowSection = renderWorkflowComplianceSection(input);
  if (workflowSection.length > 0) {
    lines.push("");
    lines.push(workflowSection);
  }

  // AKM overhead + tool-use efficiency (#263). Skipped when the corpus had
  // no akm-arm runs so the report stays compact on the no-akm path.
  const overheadSection = renderAkmOverheadSection(input);
  if (overheadSection.length > 0) {
    lines.push("");
    lines.push(overheadSection);
  }

  // Token-measurement section (issue #252). Always rendered when there are
  // akm-arm runs to report on, so operators can tell whether tokens economics
  // are trustworthy without scrolling to the warnings block.
  const tokenSummary = summariseTokenMeasurement(input);
  if (tokenSummary.totalRuns > 0) {
    lines.push("");
    lines.push("## Token measurement (akm)");
    lines.push("");
    const cov = tokenSummary.coverage === null ? "n/a" : `${(tokenSummary.coverage * 100).toFixed(1)}%`;
    lines.push(
      `- runs: ${tokenSummary.totalRuns} total, ${tokenSummary.measuredRuns} measured, ${tokenSummary.missingRuns} missing, ${tokenSummary.unsupportedRuns} unsupported`,
    );
    lines.push(`- coverage: ${cov} (${tokenSummary.reliable ? "reliable" : "unreliable — see warning below"})`);
  }

  const warnings = [...input.warnings];
  if (tokenSummary.warning) warnings.push(tokenSummary.warning);
  if (warnings.length > 0) {
    lines.push("");
    lines.push("## Warnings");
    lines.push("");
    for (const w of warnings) lines.push(`- ${w}`);
  }
  return lines.join("\n");
}

function corpusRow(arm: string, c: CorpusMetrics): string {
  const tpp = c.tokensPerPass === null ? "n/a" : c.tokensPerPass.toFixed(0);
  return `| ${arm} | ${c.passRate.toFixed(2)} | ${tpp} | ${c.wallclockMs.toFixed(0)} |`;
}

function deltaRow(d: CorpusDelta): string {
  const tpp = d.tokensPerPass === null ? "n/a" : signed(d.tokensPerPass.toFixed(0));
  return `| **delta** | ${signed(d.passRate.toFixed(2))} | ${tpp} | ${signed(d.wallclockMs.toFixed(0))} |`;
}

function taskRow(
  t: UtilityReportTaskEntry,
  includeSynthetic = false,
  baselineByTaskId?: Record<string, number>,
): string {
  // Baseline-delta cell is rendered only when a baseline map is provided
  // AND this task has an entry. Tasks without a baseline entry get an empty
  // pair of cells so columns stay aligned.
  let baselineCells = "";
  if (baselineByTaskId) {
    const base = baselineByTaskId[t.id];
    if (base === undefined) {
      baselineCells = " n/a | n/a |";
    } else {
      const delta = t.akm.passRate - base;
      baselineCells = ` ${base.toFixed(2)} | ${signed(delta.toFixed(2))} |`;
    }
  }
  if (includeSynthetic) {
    // #261: render the synthetic-arm pass-rate when present; "n/a" when the
    // arm did not run for this task. A missing arm is NOT a zero-pass arm —
    // a 0.00 cell would be misleading because the model never tried.
    const synth = t.synthetic ? t.synthetic.passRate.toFixed(2) : "n/a";
    return `| ${t.id} | ${t.noakm.passRate.toFixed(2)} | ${synth} | ${t.akm.passRate.toFixed(2)} | ${signed(t.delta.passRate.toFixed(2))} |${baselineCells}`;
  }
  return `| ${t.id} | ${t.noakm.passRate.toFixed(2)} | ${t.akm.passRate.toFixed(2)} | ${signed(t.delta.passRate.toFixed(2))} |${baselineCells}`;
}

function signed(text: string): string {
  if (text.startsWith("-")) return text;
  if (text === "0" || text === "0.00" || text === "0.0") return text;
  return `+${text}`;
}

function formatPercent(value: number | null): string {
  if (value === null) return "n/a";
  return `${(value * 100).toFixed(1)}%`;
}

/**
 * Render a `boolean | null` trajectory field for markdown tables.
 *
 * Three-state semantics:
 * - `null`  → `"—"` — no trajectory data (harness error; events.jsonl not captured).
 * - `false` → `"✗"` — agent ran but the behaviour was not observed.
 * - `true`  → `"✓"` — behaviour confirmed.
 */
export function formatTrajBool(value: boolean | null): string {
  if (value === null) return "—";
  return value ? "✓" : "✗";
}

function signedFixed(value: number, digits: number): string {
  const abs = value.toFixed(digits);
  return value > 0 ? `+${abs}` : abs;
}
