/**
 * Calibration gate: does a task actually measure akm?
 *
 * `docs/comparability.md` B6, and the akm stash's
 * `knowledge/benchmark-design-knowledge-gap-principle` it derives from, state
 * the rule this corpus was built to satisfy: an eval task measures an external
 * skill only when the information needed to succeed is NOT recoverable from
 * the model's pretraining — verified by a no-skill control that **fails on
 * every seed**. The principle's own "seed tolerance rule" is explicit that a
 * control passing on ANY seed makes the task guessable and disqualifies it.
 *
 * A task whose control already passes contributes noise around zero to every
 * aggregate and drags the headline delta toward zero in proportion to how many
 * such tasks there are. That makes the aggregate a function of corpus
 * composition rather than of akm, which is precisely the failure B6 exists to
 * surface.
 *
 * This module answers that question from run data already on disk. It never
 * drops a task: a non-discriminating task is REPORTED as non-discriminating
 * (B6 — "disclosed as non-discriminating rather than quietly dropped — that
 * disclosure is itself a finding, and hiding it is the failure mode this
 * document exists to prevent").
 *
 * Scope note: this reads the CONTROL arm only. It says nothing about whether
 * akm helps — that is the job of the paired deltas in `stats.ts`. A task can
 * pass this gate and still show no akm benefit; what it cannot do is show a
 * benefit while failing this gate, because there was no gap to fill.
 */

import type { CorpusIndex } from "./corpus";
import { fmtNum, fmtPct, mdTable } from "./report";
import { bucketByTaskArm, summarizeTaskArmRewards } from "./stats";
import type { TrialRecord } from "./types";

/**
 * Where a task sits against the gate.
 *
 * `guessable` is deliberately distinct from `non-discriminating`: both fail
 * the gate, but they fail it differently and are fixed differently. A
 * non-discriminating task needs replacing; a guessable one may only need its
 * verifier tightened to an exact stash-only token.
 */
export type CalibrationVerdict = "discriminating" | "guessable" | "non-discriminating" | "unknown";

export interface TaskCalibration {
  taskName: string;
  /** Control-arm attempts in this run, including errored ones. */
  attempts: number;
  erroredCount: number;
  /** Non-errored control attempts with no reward recorded — a data gap, not a pass or a fail. */
  missingRewardCount: number;
  /** Control attempts that recorded a reward of exactly 1. */
  controlPasses: number;
  /**
   * Mean control reward over NON-ERRORED attempts. Null when none was usable,
   * which yields an `unknown` verdict rather than a false `discriminating`
   * one — see the comment at the assignment site.
   */
  controlPassRate: number | null;
  verdict: CalibrationVerdict;
  /** True only when the control failed EVERY attempt — the knowledge-gap principle's seed-tolerance rule. */
  passesGate: boolean;
  domain: string | null;
  slice: string | null;
  difficulty: string | null;
  memoryAbility: string | null;
}

export interface DomainCalibration {
  domain: string;
  tasks: number;
  discriminating: number;
  guessable: number;
  nonDiscriminating: number;
  unknown: number;
  /** Mean of the per-task control pass rates in this domain (tasks with a usable rate only). */
  meanControlPassRate: number | null;
}

export interface CalibrationTotals {
  tasks: number;
  discriminating: number;
  guessable: number;
  nonDiscriminating: number;
  unknown: number;
  /** Tasks that pass the gate, i.e. can measure akm at all. */
  passingGate: number;
  /** `passingGate / tasks`, or null when there are no tasks. */
  gateRate: number | null;
}

export interface CalibrationReport {
  jobsDir: string;
  corpusDir: string | null;
  controlArm: string;
  /** Whether the caller named the control arm or this module inferred it. Recorded because the inference is a heuristic. */
  controlArmSource: "explicit" | "inferred";
  /** Every other arm present in the run — not analysed here, listed so the reader knows what was set aside. */
  otherArms: string[];
  tasks: TaskCalibration[];
  byDomain: DomainCalibration[];
  totals: CalibrationTotals;
  warnings: string[];
}

export class ControlArmAmbiguousError extends Error {}

/**
 * Infer which arm is the no-skill control.
 *
 * The control is the arm that never called an `akm_*` tool — but "never
 * called" must be distinguished from "we could not tell". An arm whose
 * trajectories were all unreadable has `akmCalls === null` throughout and
 * looks identical to a silent arm, so it does NOT qualify: treating an
 * unreadable arm as the control would silently calibrate against the wrong
 * side of the experiment. Requiring at least one readable trajectory makes
 * that case an explicit failure the caller resolves with `--control-arm`.
 */
export function inferControlArm(records: readonly TrialRecord[]): string {
  const arms = [...new Set(records.map((r) => r.arm))].sort();
  const candidates = arms.filter((arm) => {
    const armTrials = records.filter((r) => r.arm === arm);
    const readable = armTrials.filter((r) => r.toolUse.akmCalls !== null);
    if (readable.length === 0) return false;
    return readable.every((r) => (r.toolUse.akmCalls ?? 0) === 0);
  });

  if (candidates.length === 1) return candidates[0] as string;

  throw new ControlArmAmbiguousError(
    candidates.length === 0
      ? `could not infer a no-skill control arm from ${arms.length} arm(s): ${arms.join(", ") || "(none)"}. ` +
          "A control arm is one with at least one readable trajectory and no akm_* calls in any of them. " +
          "Pass --control-arm to name it explicitly."
      : `control arm is ambiguous — ${candidates.length} arms called no akm_* tools: ${candidates.join(", ")}. ` +
          "Pass --control-arm to name the one to calibrate against.",
  );
}

function classify(passRate: number | null): CalibrationVerdict {
  if (passRate === null) return "unknown";
  if (passRate === 0) return "discriminating";
  if (passRate >= 1) return "non-discriminating";
  return "guessable";
}

export interface CalibrationOptions {
  jobsDir: string;
  corpusDir?: string | null;
  corpus?: CorpusIndex | null;
  /** Name the control arm explicitly. Omit to infer it — see `inferControlArm`. */
  controlArm?: string | null;
  extraWarnings?: string[];
}

export function computeCalibration(records: readonly TrialRecord[], options: CalibrationOptions): CalibrationReport {
  const warnings = [...(options.extraWarnings ?? [])];
  const arms = [...new Set(records.map((r) => r.arm))].sort();

  let controlArm: string;
  let controlArmSource: "explicit" | "inferred";
  if (options.controlArm) {
    controlArm = options.controlArm;
    controlArmSource = "explicit";
    if (records.length > 0 && !arms.includes(controlArm)) {
      warnings.push(
        `--control-arm ${JSON.stringify(controlArm)} matches no arm in this run; arms present: ${arms.join(", ") || "(none)"}`,
      );
    }
  } else {
    controlArm = inferControlArm(records);
    controlArmSource = "inferred";
  }

  const summaries = bucketByTaskArm(records)
    .filter((bucket) => bucket.arm === controlArm)
    .map(summarizeTaskArmRewards);

  const tasks: TaskCalibration[] = summaries.map((summary) => {
    // errored-EXCLUDED, deliberately, and this is the one place the choice is
    // load-bearing. Under errored-as-zero a control arm that CRASHED on every
    // attempt scores 0.000 and would be certified "discriminating" — a harness
    // failure masquerading as a knowledge gap, which is the exact inversion
    // this gate exists to prevent. Excluding errored attempts makes an
    // all-errored task `unknown` (null mean) instead, and `erroredCount` stays
    // on the row so partial-data tasks are visible rather than quietly
    // averaged over a survivor subset.
    const passRate = summary.meanRewardErroredExcluded;
    // Count PASSES, not the mean: a reader checking "did the control ever
    // succeed" needs the raw count, and a fractional reward (not expected
    // under decision D4's binary rewards, but not structurally impossible)
    // should not silently read as a pass.
    const controlPasses = records.filter(
      (r) => r.arm === controlArm && r.taskName === summary.taskName && r.reward === 1,
    ).length;
    const metadata = options.corpus?.byTaskName.get(summary.taskName);
    return {
      taskName: summary.taskName,
      attempts: summary.attempts,
      erroredCount: summary.erroredCount,
      missingRewardCount: summary.missingRewardCount,
      controlPasses,
      controlPassRate: passRate,
      verdict: classify(passRate),
      passesGate: passRate === 0,
      domain: metadata?.domain ?? null,
      slice: metadata?.slice ?? null,
      difficulty: metadata?.difficulty ?? null,
      memoryAbility: metadata?.memoryAbility ?? null,
    };
  });

  const byDomainMap = new Map<string, TaskCalibration[]>();
  for (const task of tasks) {
    const key = task.domain ?? "(no metadata)";
    const list = byDomainMap.get(key) ?? [];
    list.push(task);
    byDomainMap.set(key, list);
  }

  const byDomain: DomainCalibration[] = [...byDomainMap.entries()]
    .map(([domain, group]) => {
      const rates = group.map((t) => t.controlPassRate).filter((r): r is number => r !== null);
      return {
        domain,
        tasks: group.length,
        discriminating: group.filter((t) => t.verdict === "discriminating").length,
        guessable: group.filter((t) => t.verdict === "guessable").length,
        nonDiscriminating: group.filter((t) => t.verdict === "non-discriminating").length,
        unknown: group.filter((t) => t.verdict === "unknown").length,
        meanControlPassRate: rates.length > 0 ? rates.reduce((a, b) => a + b, 0) / rates.length : null,
      };
    })
    // Worst-calibrated domains first: the ones a reader has to act on.
    .sort((a, b) => (b.meanControlPassRate ?? -1) - (a.meanControlPassRate ?? -1) || a.domain.localeCompare(b.domain));

  const passingGate = tasks.filter((t) => t.passesGate).length;
  const totals: CalibrationTotals = {
    tasks: tasks.length,
    discriminating: tasks.filter((t) => t.verdict === "discriminating").length,
    guessable: tasks.filter((t) => t.verdict === "guessable").length,
    nonDiscriminating: tasks.filter((t) => t.verdict === "non-discriminating").length,
    unknown: tasks.filter((t) => t.verdict === "unknown").length,
    passingGate,
    gateRate: tasks.length > 0 ? passingGate / tasks.length : null,
  };

  return {
    jobsDir: options.jobsDir,
    corpusDir: options.corpusDir ?? null,
    controlArm,
    controlArmSource,
    otherArms: arms.filter((a) => a !== controlArm),
    tasks,
    byDomain,
    totals,
    warnings,
  };
}

// ── Rendering ────────────────────────────────────────────────────────────

export function renderCalibrationJson(report: CalibrationReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

const VERDICT_NOTE: Record<CalibrationVerdict, string> = {
  discriminating: "control failed every attempt — this task can measure akm",
  guessable: "control passed on SOME attempts — guessable, fails the seed-tolerance rule",
  "non-discriminating": "control passed every attempt — measures pretraining, not akm",
  unknown: "no usable control attempt (all errored or missing a reward) — cannot be judged from this run",
};

export function renderCalibrationMarkdown(report: CalibrationReport): string {
  const t = report.totals;
  const sections: string[] = [];

  sections.push(
    [
      "# akm-bench calibration gate",
      "",
      "**First-party corpus calibration. Not a benchmark score, and never publishable",
      "beside a third-party benchmark figure (`docs/comparability.md` B1).**",
      "",
      `Jobs dir: \`${report.jobsDir}\`  `,
      `Corpus dir: \`${report.corpusDir ?? "(none — no task metadata joined)"}\`  `,
      `Control arm: \`${report.controlArm}\` (${report.controlArmSource})  `,
      `Other arms present, not analysed here: ${report.otherArms.length > 0 ? report.otherArms.map((a) => `\`${a}\``).join(", ") : "(none)"}`,
      "",
      "## The gate",
      "",
      "A task measures akm only when the information needed to succeed is not",
      "recoverable from the model's pretraining. The test is the no-skill control:",
      "it must **fail on every attempt**. A control that passes even once makes the",
      "task guessable, per the seed-tolerance rule in the akm stash's",
      "`knowledge/benchmark-design-knowledge-gap-principle`.",
      "",
      "Nothing here is dropped. A task that fails the gate is listed as failing it —",
      "that disclosure is the finding (B6).",
    ].join("\n"),
  );

  sections.push(
    [
      "## Totals",
      "",
      mdTable(
        ["metric", "value"],
        [
          ["tasks measured", String(t.tasks)],
          ["**pass the gate** (control failed every attempt)", `**${t.discriminating}**`],
          ["fail — guessable (control passed sometimes)", String(t.guessable)],
          ["fail — non-discriminating (control passed always)", String(t.nonDiscriminating)],
          ["unknown (no usable control attempt)", String(t.unknown)],
          ["gate rate", fmtPct(t.gateRate)],
        ],
      ),
    ].join("\n"),
  );

  sections.push(
    [
      "## By domain",
      "",
      "Sorted worst-calibrated first — the domains where the control already knows the answer.",
      "",
      mdTable(
        ["domain", "tasks", "mean control pass rate", "pass gate", "guessable", "non-discriminating", "unknown"],
        report.byDomain.map((d) => [
          d.domain,
          String(d.tasks),
          fmtNum(d.meanControlPassRate),
          String(d.discriminating),
          String(d.guessable),
          String(d.nonDiscriminating),
          String(d.unknown),
        ]),
      ),
    ].join("\n"),
  );

  const failing = report.tasks.filter((task) => !task.passesGate);
  sections.push(
    [
      "## Per task",
      "",
      mdTable(
        ["task", "domain", "difficulty", "control attempts", "control passes", "control pass rate", "verdict", "gate"],
        report.tasks.map((task) => [
          task.taskName,
          task.domain ?? "-",
          task.difficulty ?? "-",
          String(task.attempts),
          String(task.controlPasses),
          fmtNum(task.controlPassRate),
          task.verdict,
          task.passesGate ? "PASS" : "FAIL",
        ]),
      ),
      "",
      `**${failing.length} of ${t.tasks} tasks fail the gate** and cannot measure akm on this run:`,
      "",
      ...(failing.length > 0
        ? failing.map((task) => `- \`${task.taskName}\` — ${VERDICT_NOTE[task.verdict]}`)
        : ["- (none)"]),
    ].join("\n"),
  );

  sections.push(
    [
      "## How to act on this",
      "",
      "A failing task is not deleted or reworded in place. `docs/comparability.md` B3",
      "makes that a hard rule: editing a task in a slice that has published results",
      "breaks every prior comparison invisibly. Changes land as a **new numbered",
      "slice**, with the previous slice left runnable, and both run across one",
      "transition round so the two are tied together by a measured overlap.",
      "",
      "A `guessable` verdict and a `non-discriminating` one call for different",
      "fixes. Guessable often means the verifier accepts a plausible public answer",
      "where it should assert an exact stash-only token. Non-discriminating means",
      "the task has no knowledge gap at all and needs replacing — see",
      "`docs/task-class-local-convention.md` for the class designed to fill it.",
      "",
      "**Passing this gate is necessary, not sufficient.** A control can fail a task",
      "for reasons other than a knowledge gap — the task may simply be hard, or may",
      "score a behaviour (recording feedback, not repeating a failed command) rather",
      "than a fact. The knowledge-gap principle has a second half this gate cannot",
      "check from run data: the verifier must assert a value that exists ONLY in the",
      "stash. A task that passes here still needs that confirmed by reading it.",
    ].join("\n"),
  );

  if (report.warnings.length > 0) {
    sections.push(["## Warnings", "", ...report.warnings.map((w) => `- ${w}`)].join("\n"));
  }

  return `${sections.join("\n\n")}\n`;
}
