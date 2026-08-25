/**
 * Report renderer (implementation brief §6 / plan phase P1): markdown + JSON
 * output over `AnalysisStats`, joined with corpus metadata and a
 * reproducibility provenance header.
 *
 * Every published number in this repo's benchmark story is expected to carry
 * a provenance manifest (docs/plans/benchmark-harness-consolidation.md §6);
 * this module is where that manifest is assembled: pinned Harbor version (read
 * from each job's `lock.json`, not asserted from environment), task
 * checksums (flagged when they disagree across trials of the SAME task name —
 * a red flag the corpus drifted mid-run), and an agent-kwargs digest per arm
 * (flagged when it disagrees within an arm — a red flag the arm's config
 * drifted mid-run, e.g. two different jobs sharing an arm label by accident).
 */

import fs from "node:fs";
import path from "node:path";

import { type CorpusIndex, type CorpusTaskMetadata, joinCorpus, loadCorpusMetadata } from "./corpus";
// `agentKwargsDigest` lives in loader.ts because `deriveArm()` folds it into the
// arm label itself; re-exported here so the historical `report.agentKwargsDigest`
// import path keeps working and there is exactly ONE implementation.
import { agentKwargsDigest } from "./loader";
import {
  type AnalysisStats,
  type ArmSummary,
  type BootstrapCI,
  type BootstrapOptions,
  computeAnalysisStats,
  ERRORED_POLICIES,
  type ErroredPolicy,
  type PairedDelta,
  type SymmetricPairedDelta,
  type TaskArmRewardSummary,
} from "./stats";
import type { TrialRecord } from "./types";

export { agentKwargsDigest };

// ── Provenance header ────────────────────────────────────────────────────

export interface ProvenanceHeader {
  generatedAt: string;
  jobsDir: string;
  corpusDir: string | null;
  jobIds: string[];
  /** Distinct `harbor.version` values found across `jobs/<job>/lock.json`. Empty when no lock.json carried one — never invented. */
  harborVersions: string[];
  nTrials: number;
  nArms: number;
  nTasks: number;
  /** `task_name -> sorted distinct task_checksum list`, only for task names where more than one checksum was observed. Empty checksums (a missing field) are ignored here — see `disclosures.warnings` for that case instead. */
  taskChecksumMismatches: Record<string, string[]>;
  /**
   * `arm -> sorted distinct sha256(agent kwargs) list`, only for arms where
   * more than one digest was observed — same arm label, different actual
   * config.
   *
   * Since `deriveArm()` folds the kwargs digest INTO the arm label, this is
   * expected to stay empty: it is a tripwire on that invariant, not a routine
   * disclosure. A non-empty entry here means `deriveArm` and this digest
   * disagree and the report must not be trusted.
   */
  agentKwargsDigestMismatches: Record<string, string[]>;
  corpusJoin: { matched: number; missing: string[] } | null;
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function readHarborVersion(jobsDir: string, jobId: string): string | null {
  const lockPath = path.join(jobsDir, jobId, "lock.json");
  try {
    const raw = JSON.parse(fs.readFileSync(lockPath, "utf8")) as unknown;
    if (raw !== null && typeof raw === "object") {
      const harbor = (raw as Record<string, unknown>).harbor;
      if (harbor !== null && typeof harbor === "object") {
        const version = (harbor as Record<string, unknown>).version;
        if (typeof version === "string") return version;
      }
    }
  } catch {
    // Missing/unreadable/malformed lock.json is not an error — see the doc comment on `harborVersions`.
  }
  return null;
}

function buildProvenance(
  records: readonly TrialRecord[],
  jobsDir: string,
  corpusDir: string | null,
  corpusJoin: { matched: number; missing: string[] } | null,
): ProvenanceHeader {
  const jobIds = [...new Set(records.map((r) => r.jobId))].sort();
  const harborVersions = [
    ...new Set(jobIds.map((jobId) => readHarborVersion(jobsDir, jobId)).filter((v): v is string => v !== null)),
  ].sort();

  const checksumsByTask = new Map<string, Set<string>>();
  const digestsByArm = new Map<string, Set<string>>();
  for (const record of records) {
    if (record.provenance.taskChecksum) {
      const set = checksumsByTask.get(record.taskName) ?? new Set<string>();
      set.add(record.provenance.taskChecksum);
      checksumsByTask.set(record.taskName, set);
    }
    const digestSet = digestsByArm.get(record.arm) ?? new Set<string>();
    digestSet.add(agentKwargsDigest(record.provenance.agentKwargs));
    digestsByArm.set(record.arm, digestSet);
  }

  const taskChecksumMismatches: Record<string, string[]> = {};
  for (const [taskName, checksums] of checksumsByTask) {
    if (checksums.size > 1) taskChecksumMismatches[taskName] = [...checksums].sort();
  }
  const agentKwargsDigestMismatches: Record<string, string[]> = {};
  for (const [arm, digests] of digestsByArm) {
    if (digests.size > 1) agentKwargsDigestMismatches[arm] = [...digests].sort();
  }

  return {
    generatedAt: new Date().toISOString(),
    jobsDir,
    corpusDir,
    jobIds,
    harborVersions,
    nTrials: records.length,
    nArms: new Set(records.map((r) => r.arm)).size,
    nTasks: new Set(records.map((r) => r.taskName)).size,
    taskChecksumMismatches,
    agentKwargsDigestMismatches,
    corpusJoin,
  };
}

// ── Disclosure block ────────────────────────────────────────────────────

export interface DisclosureBlock {
  totalTrials: number;
  totalErrored: number;
  erroredByArm: Record<string, number>;
  /** `exception_type -> count`, across every errored trial in every arm. */
  exceptionTypeCounts: Record<string, number>;
  /** Non-errored trials with no `reward` key at all — see stats.ts module docstring: never folded into either errored policy. */
  totalMissingReward: number;
  missingRewardByArm: Record<string, number>;
  /**
   * Non-canonical reward keys observed across every trial's
   * `verifier_result.rewards` (decision D4: the canonical key is `"reward"`;
   * everything else is parsed into `TrialRecord.otherRewards` but never
   * aggregated or scored by this module). `key -> number of trials that
   * reported it`. Disclosed here specifically so a key like
   * `workflow_compliance` does not silently vanish after being read off
   * disk — a reader who wants it has to go to `otherRewards` on the raw
   * per-trial records themselves; this block only proves it exists and how
   * often.
   */
  otherRewardKeyCounts: Record<string, number>;
  /**
   * Non-errored trials whose canonical `reward` is present but not exactly
   * `0` or `1`. Decision D4's canonical shape is a binary reward, and
   * `passAt1` / Harbor's own `pass_at_k` cross-check both assume it; a
   * partial-credit value (e.g. `0.6` from a pytest verifier with partial
   * credit) still gets folded into `passAt1` as-is, silently changing what
   * that column means from "fraction of tasks passed" to "mean of a mixed
   * pass/fail/partial scale" for exactly the tasks counted here.
   */
  nonBinaryRewardCount: number;
  nonBinaryRewardByArm: Record<string, number>;
  /** Task names present in the loaded trials but absent from the corpus index. `null` when no `--corpus` was given at all (there is nothing to be missing from). */
  corpusMissingTasks: string[] | null;
  warnings: string[];
}

function buildDisclosures(
  records: readonly TrialRecord[],
  corpusJoin: { matched: number; missing: string[] } | null,
  warnings: readonly string[],
): DisclosureBlock {
  const erroredByArm: Record<string, number> = {};
  const missingRewardByArm: Record<string, number> = {};
  const exceptionTypeCounts: Record<string, number> = {};
  const otherRewardKeyCounts: Record<string, number> = {};
  const nonBinaryRewardByArm: Record<string, number> = {};
  let totalErrored = 0;
  let totalMissingReward = 0;
  let nonBinaryRewardCount = 0;

  for (const record of records) {
    if (record.errored) {
      totalErrored += 1;
      erroredByArm[record.arm] = (erroredByArm[record.arm] ?? 0) + 1;
      const type = record.exceptionType ?? "UnknownException";
      exceptionTypeCounts[type] = (exceptionTypeCounts[type] ?? 0) + 1;
    } else if (record.reward === null) {
      totalMissingReward += 1;
      missingRewardByArm[record.arm] = (missingRewardByArm[record.arm] ?? 0) + 1;
    } else if (record.reward !== 0 && record.reward !== 1) {
      nonBinaryRewardCount += 1;
      nonBinaryRewardByArm[record.arm] = (nonBinaryRewardByArm[record.arm] ?? 0) + 1;
    }
    for (const key of Object.keys(record.otherRewards)) {
      otherRewardKeyCounts[key] = (otherRewardKeyCounts[key] ?? 0) + 1;
    }
  }

  return {
    totalTrials: records.length,
    totalErrored,
    erroredByArm,
    exceptionTypeCounts,
    totalMissingReward,
    missingRewardByArm,
    otherRewardKeyCounts,
    nonBinaryRewardCount,
    nonBinaryRewardByArm,
    corpusMissingTasks: corpusJoin ? corpusJoin.missing : null,
    warnings: [...warnings],
  };
}

// ── Per-task breakdown, joined with corpus metadata ─────────────────────

export interface PerTaskBreakdownRow {
  taskName: string;
  metadata: CorpusTaskMetadata | null;
  perArm: TaskArmRewardSummary[];
}

function buildPerTaskBreakdown(stats: AnalysisStats, corpusIndex: CorpusIndex | null): PerTaskBreakdownRow[] {
  const byTask = new Map<string, TaskArmRewardSummary[]>();
  for (const summary of stats.taskArmSummaries) {
    const list = byTask.get(summary.taskName) ?? [];
    list.push(summary);
    byTask.set(summary.taskName, list);
  }
  const rows: PerTaskBreakdownRow[] = [];
  for (const [taskName, perArm] of byTask) {
    rows.push({
      taskName,
      metadata: corpusIndex?.byTaskName.get(taskName) ?? null,
      perArm: perArm.sort((a, b) => a.arm.localeCompare(b.arm)),
    });
  }
  rows.sort((a, b) => a.taskName.localeCompare(b.taskName));
  return rows;
}

// ── Top-level report ─────────────────────────────────────────────────────

export interface AnalysisReport {
  provenance: ProvenanceHeader;
  stats: AnalysisStats;
  perTaskBreakdown: PerTaskBreakdownRow[];
  disclosures: DisclosureBlock;
}

export interface AnalysisReportOptions {
  jobsDir: string;
  corpusDir?: string | null;
  /** A pre-built corpus index — skips re-reading `task.toml` files. When omitted and `corpusDir` is set, this module loads it via `corpus.ts`. */
  corpusIndex?: CorpusIndex | null;
  bootstrap?: BootstrapOptions;
  /** Warnings collected upstream (e.g. by `loader.ts`'s `onWarning`) to fold into the disclosure block alongside this module's own. */
  extraWarnings?: string[];
}

export function buildAnalysisReport(records: TrialRecord[], options: AnalysisReportOptions): AnalysisReport {
  const jobsDir = options.jobsDir;
  const corpusDir = options.corpusDir ?? null;
  const stats = computeAnalysisStats(records, options.bootstrap ?? {});

  let corpusIndex: CorpusIndex | null = options.corpusIndex ?? null;
  if (!corpusIndex && corpusDir && isDirectory(corpusDir)) corpusIndex = loadCorpusMetadata(corpusDir);

  const warnings: string[] = [...(options.extraWarnings ?? [])];
  if (corpusIndex) warnings.push(...corpusIndex.warnings);

  let corpusJoinSummary: { matched: number; missing: string[] } | null = null;
  if (corpusIndex) {
    const taskNames = new Set(records.map((r) => r.taskName));
    const join = joinCorpus(taskNames, corpusIndex);
    corpusJoinSummary = { matched: join.matched.length, missing: join.missingTaskNames };
    for (const missing of join.missingTaskNames) {
      warnings.push(`no corpus metadata found for task ${JSON.stringify(missing)}`);
    }
  }

  return {
    provenance: buildProvenance(records, jobsDir, corpusDir, corpusJoinSummary),
    stats,
    perTaskBreakdown: buildPerTaskBreakdown(stats, corpusIndex),
    disclosures: buildDisclosures(records, corpusJoinSummary, warnings),
  };
}

export function renderJson(report: AnalysisReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

// ── Markdown rendering ─────────────────────────────────────────────────

function fmtNum(value: number | null | undefined, digits = 3): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "n/a";
  return value.toFixed(digits);
}

function fmtPct(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "n/a";
  return `${(value * 100).toFixed(digits)}%`;
}

function fmtCI(ci: BootstrapCI | null): string {
  if (!ci) return "n/a";
  return `[${fmtNum(ci.ciLow)}, ${fmtNum(ci.ciHigh)}] (n=${ci.n}, ${ci.resamples} resamples, seed=${ci.seed})`;
}

function policyLabel(policy: ErroredPolicy): string {
  return policy === "errored-as-zero" ? "errored=0" : "errored excluded";
}

function mdTable(header: string[], rows: string[][]): string {
  const lines = [`| ${header.join(" | ")} |`, `| ${header.map(() => "---").join(" | ")} |`];
  for (const row of rows) lines.push(`| ${row.join(" | ")} |`);
  return lines.join("\n");
}

function renderArmTable(arms: ArmSummary[]): string {
  const rows: string[][] = [];
  for (const arm of arms) {
    for (const policy of ERRORED_POLICIES) {
      const pass = arm.passAt1[policy];
      const reward = arm.rewardStats[policy];
      rows.push([
        arm.arm,
        policyLabel(policy),
        String(arm.nTrials),
        String(arm.nTasks),
        `${fmtPct(pass.passAt1)} ${fmtCI(pass.ci)} (${pass.nTasks} tasks${pass.excludedTasks.length ? `, ${pass.excludedTasks.length} excluded` : ""})`,
        `${fmtNum(reward.ci?.mean ?? null)} ${fmtCI(reward.ci)}`,
      ]);
    }
  }
  return mdTable(
    [
      "arm",
      "errored policy",
      "trials",
      "tasks",
      "pass@1 (95% CI over per-task means, n=tasks)",
      "mean reward (95% CI over ATTEMPTS — pseudo-replicated, see note below table)",
    ],
    rows,
  );
}

function renderTokenTable(arms: ArmSummary[]): string {
  const rows = arms.map((arm) => {
    const t = arm.tokenStats;
    return [
      arm.arm,
      String(t.nTrials),
      `${fmtNum(t.inputTokens.mean, 0)} (n=${t.inputTokens.n}, null=${t.inputTokens.nullCount})`,
      `${fmtNum(t.cacheTokens.mean, 0)} (n=${t.cacheTokens.n}, null=${t.cacheTokens.nullCount})`,
      `${fmtNum(t.outputTokens.mean, 0)} (n=${t.outputTokens.n}, null=${t.outputTokens.nullCount})`,
      `${fmtNum(t.costUsd.mean, 4)} (n=${t.costUsd.n}, null=${t.costUsd.nullCount})`,
    ];
  });
  return mdTable(
    ["arm", "trials", "mean input tokens", "mean cache tokens", "mean output tokens", "mean cost USD"],
    rows,
  );
}

function renderToolUseTable(arms: ArmSummary[]): string {
  const rows = arms.map((arm) => {
    const t = arm.toolUseStats;
    const topAkm = Object.entries(t.byTool)
      .filter(([tool]) => tool.startsWith("akm_"))
      .sort((a, b) => b[1] - a[1])
      .map(([tool, n]) => `${tool}=${n}`)
      .join(", ");
    return [
      arm.arm,
      `${t.nWithTrajectory} (no trajectory: ${t.nWithoutTrajectory})`,
      `${t.nWithAkmCall}`,
      fmtPct(t.akmEngagementRate),
      fmtNum(t.akmCalls.mean, 2),
      fmtNum(t.totalCalls.mean, 2),
      topAkm || "—",
    ];
  });
  return mdTable(
    [
      "arm",
      "trials w/ trajectory",
      "trials calling akm",
      "engagement rate",
      "mean akm calls",
      "mean tool calls",
      "akm tools used",
    ],
    rows,
  );
}

function renderDeltaTable(deltas: PairedDelta[]): string {
  const rows = deltas.map((d) => [
    `${d.armA} vs ${d.armB}`,
    policyLabel(d.policy),
    String(d.nTasksPaired),
    fmtNum(d.delta),
    fmtCI(d.ci),
    d.tasksOnlyInA.length || d.tasksOnlyInB.length
      ? `${d.tasksOnlyInA.length} only-A, ${d.tasksOnlyInB.length} only-B`
      : "-",
  ]);
  return mdTable(
    ["arms (A vs B)", "errored policy", "tasks paired", "delta (A - B)", "95% CI", "unpaired tasks"],
    rows,
  );
}

function renderSymmetricDeltaTable(deltas: SymmetricPairedDelta[]): string {
  const rows = deltas.map((d) => [
    `${d.armA} vs ${d.armB}`,
    String(d.nTasksPaired),
    fmtNum(d.delta),
    fmtCI(d.ci),
    String(d.tasksExcludedAnyArmErrored.length),
    d.tasksOnlyInA.length || d.tasksOnlyInB.length
      ? `${d.tasksOnlyInA.length} only-A, ${d.tasksOnlyInB.length} only-B`
      : "-",
  ]);
  return mdTable(
    [
      "arms (A vs B)",
      "tasks paired",
      "delta (A - B)",
      "95% CI",
      "tasks excluded (either arm errored)",
      "unpaired tasks",
    ],
    rows,
  );
}

function metadataGroupKey(
  row: PerTaskBreakdownRow,
  field: "domain" | "slice" | "difficulty" | "memoryAbility",
): string {
  return row.metadata?.[field] ?? "(no metadata)";
}

function renderPerTaskSection(rows: PerTaskBreakdownRow[], hasCorpus: boolean): string {
  const parts: string[] = [];
  if (!hasCorpus) {
    parts.push(
      "_No `--corpus` directory was given — per-task rows are not grouped by domain/slice/difficulty/memory_ability._\n",
    );
  }

  const flatRows = rows.flatMap((row) =>
    row.perArm.map((summary) => [
      row.taskName,
      hasCorpus ? metadataGroupKey(row, "domain") : "-",
      hasCorpus ? metadataGroupKey(row, "slice") : "-",
      hasCorpus ? metadataGroupKey(row, "difficulty") : "-",
      hasCorpus ? metadataGroupKey(row, "memoryAbility") : "-",
      summary.arm,
      String(summary.attempts),
      String(summary.erroredCount),
      String(summary.missingRewardCount),
      fmtNum(summary.meanRewardErroredAsZero),
      fmtNum(summary.meanRewardErroredExcluded),
    ]),
  );
  parts.push(
    mdTable(
      [
        "task",
        "domain",
        "slice",
        "difficulty",
        "memory_ability",
        "arm",
        "attempts",
        "errored",
        "missing reward",
        "mean reward (errored=0)",
        "mean reward (errored excluded)",
      ],
      flatRows,
    ),
  );
  return parts.join("\n\n");
}

function renderMismatchList(mismatches: Record<string, string[]>, label: string): string {
  const entries = Object.entries(mismatches);
  if (entries.length === 0) return `_No ${label} mismatches._`;
  return entries.map(([key, values]) => `- \`${key}\`: ${values.join(", ")}`).join("\n");
}

export function renderMarkdown(report: AnalysisReport): string {
  const { provenance, stats, perTaskBreakdown, disclosures } = report;
  const hasCorpus = provenance.corpusDir !== null;

  const sections: string[] = [];
  sections.push("# akm-bench analysis report");
  sections.push(
    [
      `Generated: ${provenance.generatedAt}`,
      `Jobs dir: \`${provenance.jobsDir}\``,
      `Corpus dir: ${hasCorpus ? `\`${provenance.corpusDir}\`` : "_not provided_"}`,
      `Harbor version(s): ${provenance.harborVersions.length ? provenance.harborVersions.join(", ") : "unknown (no lock.json found)"}`,
      `Jobs: ${provenance.jobIds.length} · Trials: ${provenance.nTrials} · Arms: ${provenance.nArms} · Tasks: ${provenance.nTasks}`,
      `Bootstrap: seed=${stats.bootstrap.seed}, resamples=${stats.bootstrap.resamples}, alpha=${stats.bootstrap.alpha}`,
    ].join("  \n"),
  );

  sections.push(
    [
      "## Provenance",
      "",
      "**Task checksum mismatches** (same task_name, different task_checksum — corpus may have drifted mid-run):",
      renderMismatchList(provenance.taskChecksumMismatches, "task checksum"),
      "",
      "**Agent kwargs digest mismatches** (tripwire — `deriveArm()` folds this digest into the arm label, so any entry here means the label and the digest disagree):",
      renderMismatchList(provenance.agentKwargsDigestMismatches, "agent kwargs digest"),
      "",
      provenance.corpusJoin
        ? `**Corpus join:** ${provenance.corpusJoin.matched} task(s) matched, ${provenance.corpusJoin.missing.length} missing.`
        : "**Corpus join:** not attempted (no `--corpus` given).",
    ].join("\n"),
  );

  sections.push(
    [
      "## Errored / null disclosure",
      "",
      `Errored trials: ${disclosures.totalErrored} / ${disclosures.totalTrials}`,
      Object.keys(disclosures.erroredByArm).length
        ? Object.entries(disclosures.erroredByArm)
            .map(([arm, n]) => `  - \`${arm}\`: ${n}`)
            .join("\n")
        : "  - (none)",
      Object.keys(disclosures.exceptionTypeCounts).length
        ? `Exception types: ${Object.entries(disclosures.exceptionTypeCounts)
            .map(([type, n]) => `${type}=${n}`)
            .join(", ")}`
        : "",
      `Non-errored trials with a missing reward (never folded into either policy): ${disclosures.totalMissingReward} / ${disclosures.totalTrials}`,
      Object.keys(disclosures.missingRewardByArm).length
        ? Object.entries(disclosures.missingRewardByArm)
            .map(([arm, n]) => `  - \`${arm}\`: ${n}`)
            .join("\n")
        : "  - (none)",
      `Non-errored trials whose reward is present but NOT exactly 0 or 1 (decision D4's canonical shape; \`pass@1\` and Harbor's own \`pass_at_k\` cross-check both assume binary rewards): ${disclosures.nonBinaryRewardCount} / ${disclosures.totalTrials}`,
      Object.keys(disclosures.nonBinaryRewardByArm).length
        ? Object.entries(disclosures.nonBinaryRewardByArm)
            .map(([arm, n]) => `  - \`${arm}\`: ${n}`)
            .join("\n")
        : "  - (none)",
      `Non-canonical reward keys observed (parsed into \`otherRewards\` on each trial record, but never aggregated or scored by this module — see the per-trial JSON for values): ${
        Object.keys(disclosures.otherRewardKeyCounts).length
          ? Object.entries(disclosures.otherRewardKeyCounts)
              .map(([key, n]) => `${key} (${n} trial(s))`)
              .join(", ")
          : "(none)"
      }`,
      disclosures.corpusMissingTasks
        ? `Tasks with no corpus metadata match: ${disclosures.corpusMissingTasks.length ? disclosures.corpusMissingTasks.join(", ") : "(none)"}`
        : "",
    ]
      .filter((line) => line !== "")
      .join("\n"),
  );

  sections.push(
    [
      "## Per-arm summary",
      "",
      renderArmTable(stats.arms),
      "",
      "_`pass@1`'s CI resamples per-task means (n = tasks) and is the interval to cite. `mean reward`'s CI resamples individual trial-level ATTEMPTS, which are correlated within a (task, arm) bucket when `n_attempts > 1` (same task, same difficulty, same environment) — that column is a within-arm attempt-level dispersion statistic, not an independence-based confidence interval, and its `n` counts attempts, not tasks. See `analysis/src/stats.ts`'s module docstring._",
    ].join("\n"),
  );
  sections.push(["## Per-arm tokens / cost", "", renderTokenTable(stats.arms)].join("\n"));
  sections.push(
    [
      "## akm tool engagement",
      "",
      renderToolUseTable(stats.arms),
      "",
      "_Whether the model CHOSE to call an `akm_*` tool, counted from each trial's own opencode stdout trajectory — not from the plugin's event ledger, which records what the plugin offered rather than what the model used. Read this before any reward delta: an arm with a 0% engagement rate was never measured on retrieval at all, whatever it scored, and a treatment-vs-baseline difference there is a difference in injected context alone. Ignoring akm on a trivial task is expected; ignoring it on a task built to reward retrieval is itself the finding. `no trajectory` trials are excluded from the rate and reported separately rather than counted as zero._",
    ].join("\n"),
  );

  if (stats.deltas.length > 0) {
    sections.push(
      ["## Arm vs. arm delta (paired by task, bootstrap CI)", "", renderDeltaTable(stats.deltas)].join("\n"),
    );
  }

  if (stats.symmetricDeltas.length > 0) {
    sections.push(
      [
        "## Arm vs. arm delta (symmetric exclusion: task dropped if EITHER arm had any errored trial)",
        "",
        "_Neither `errored-as-zero` nor `errored-excluded` above is symmetric across arms: a harness/infrastructure failure that can only occur on ONE arm (e.g. a treatment-only run-phase proof) either scores that arm's task as 0 (errored-as-zero) or leaves the other arm's mean computed over all its trials while this arm's is computed over a non-random survivor subset (errored-excluded). This table drops the task from the comparison entirely instead — see `computeSymmetricPairedDelta` in `analysis/src/stats.ts`._",
        "",
        renderSymmetricDeltaTable(stats.symmetricDeltas),
      ].join("\n"),
    );
  }

  sections.push(["## Per-task breakdown", "", renderPerTaskSection(perTaskBreakdown, hasCorpus)].join("\n"));

  if (disclosures.warnings.length > 0) {
    sections.push(["## Warnings", "", disclosures.warnings.map((w) => `- ${w}`).join("\n")].join("\n"));
  }

  return `${sections.join("\n\n")}\n`;
}
