/**
 * akm-bench feedback-integrity metrics (§6.8).
 */

import type { RunResult } from "../driver";

// ── Feedback-signal integrity (§6.8) ───────────────────────────────────────

/**
 * Per-asset 2×2 confusion matrix row.
 *
 * `feedback_agreement`, `false_positive_rate`, and `false_negative_rate`
 * are `null` (NaN-safe sentinel) when the relevant denominator is 0 — i.e.
 * an asset with zero feedback events emits all rates as `null`, never `0`
 * or `NaN`.
 */
export interface FeedbackIntegrityPerAssetRow {
  ref: string;
  /** Feedback `+`, run passed. */
  truePositive: number;
  /** Feedback `+`, run failed (agent was wrong). */
  falsePositive: number;
  /** Feedback `−`, run failed. */
  trueNegative: number;
  /** Feedback `−`, run passed. */
  falseNegative: number;
  /** `(TP+TN) / total`, or `null` when no feedback events. */
  feedback_agreement: number | null;
  /** `FP / (FP+TN)`, or `null` when `FP+TN === 0`. */
  false_positive_rate: number | null;
  /** `FN / (FN+TP)`, or `null` when `FN+TP === 0`. */
  false_negative_rate: number | null;
}

/**
 * Aggregate confusion-matrix envelope. The aggregate fields use the same
 * NaN-safe rules as per-asset, except `feedback_coverage` which is always
 * a finite number in `[0, 1]` (denominator is total Phase 1 runs; a
 * caller with zero runs gets `0`).
 */
export interface FeedbackIntegrityAggregate {
  truePositive: number;
  falsePositive: number;
  trueNegative: number;
  falseNegative: number;
  feedback_agreement: number;
  false_positive_rate: number;
  false_negative_rate: number;
  /** (Phase-1 runs with any feedback dispatched) / (total Phase 1 runs). */
  feedback_coverage: number;
}

/** §6.8 envelope: aggregate matrix + per-asset breakdown. */
export interface FeedbackIntegrityMetrics {
  aggregate: FeedbackIntegrityAggregate;
  perAsset: FeedbackIntegrityPerAssetRow[];
}

/**
 * Inputs to `computeFeedbackIntegrity`.
 *
 * `phase1` is the Phase 1 utility report (akm arm, train slice). Each
 * `phase1.akmRuns[i]` carries `taskId`, `seed`, and `outcome`. The bench's
 * Phase 1 dispatches at most one feedback event per run (positive on pass,
 * negative on fail; harness_error runs are skipped). `feedbackLog[i]` is
 * the dispatched record carrying `taskId`, `seed`, `goldRef`, and the
 * dispatched `signal`.
 *
 * Attribution rule (§6.8): each `feedbackLog` entry is joined to the run
 * with the matching `(taskId, seed)`. The run's `outcome` (NOT the asset's
 * later state) decides the matrix cell. Runs whose feedback failed to
 * dispatch (`feedbackLog[i].ok === false`) are excluded from the matrix
 * but still count toward `feedback_coverage` denominators only when they
 * appear in `phase1.akmRuns`. Specifically, a feedback event that the
 * runner *attempted* to dispatch counts against `feedback_coverage` — but
 * if it failed (ok=false) it is not labelled into TP/FP/TN/FN. This
 * mirrors how the runner treats the dispatch as best-effort.
 */
export interface FeedbackIntegrityInput {
  /**
   * Phase 1 utility report. Only `akmRuns` is consulted (each carries
   * `taskId`, `seed`, `outcome`).
   */
  phase1: { akmRuns?: RunResult[] };
  /**
   * Phase 1 feedback dispatch log produced by the runner. Each entry
   * carries `taskId`, `seed`, `goldRef`, the dispatched `signal`, and a
   * boolean `ok` (true iff the akm CLI exited 0).
   */
  feedbackLog: Array<{
    taskId: string;
    seed: number;
    goldRef: string;
    signal: "positive" | "negative";
    ok: boolean;
  }>;
}

/**
 * Compute the §6.8 feedback-signal integrity confusion matrix.
 *
 * Pure function — does not touch disk and does not invoke any subprocess.
 * The join is by `(taskId, seed)` so that a feedback event is attributed
 * to the run that produced it, NOT to a later run that happens to touch
 * the same gold ref. This matters when the same gold ref appears across
 * multiple Phase 1 runs (e.g. multiple seeds, or two tasks sharing a
 * skill); the per-asset row aggregates across all runs that referenced it
 * in feedback, but each individual feedback event's matrix cell is
 * decided by its own run's outcome.
 *
 * NaN-safety: a per-asset row with zero feedback events (cannot happen via
 * this function — every row is derived from at least one feedback entry —
 * but defensive against future callers passing curated subsets) emits all
 * three rates as `null`. `false_positive_rate` is `null` when `FP+TN===0`
 * even if the row has `FN+TP>0`, and vice versa.
 */
export function computeFeedbackIntegrity(input: FeedbackIntegrityInput): FeedbackIntegrityMetrics {
  const akmRuns = input.phase1.akmRuns ?? [];
  // Build a (taskId, seed) → outcome lookup so every feedback event
  // resolves in O(1). When two runs share the same key (shouldn't happen
  // — runner emits unique seeds per task — but defensive) the first
  // wins.
  const runOutcomeByKey = new Map<string, RunResult["outcome"]>();
  for (const r of akmRuns) {
    const key = `${r.taskId}::${r.seed}`;
    if (!runOutcomeByKey.has(key)) runOutcomeByKey.set(key, r.outcome);
  }

  // Per-asset accumulator. We key on goldRef.
  interface AssetCounts {
    truePositive: number;
    falsePositive: number;
    trueNegative: number;
    falseNegative: number;
  }
  const perRef = new Map<string, AssetCounts>();
  let aggTP = 0;
  let aggFP = 0;
  let aggTN = 0;
  let aggFN = 0;

  // Track which (taskId, seed) keys had any feedback dispatched (ok or
  // not), for the coverage denominator. We count an attempted dispatch as
  // covered — if `ok===false`, the operator wanted feedback but the CLI
  // failed; that's still a covered run for the purpose of §6.8 (and is
  // surfaced in the warnings list elsewhere).
  const coveredKeys = new Set<string>();

  for (const fb of input.feedbackLog) {
    const key = `${fb.taskId}::${fb.seed}`;
    coveredKeys.add(key);
    if (!fb.ok) continue; // failed dispatches don't label a matrix cell.
    const outcome = runOutcomeByKey.get(key);
    if (outcome === undefined) continue; // run not found — defensive, drop.
    // harness_error runs are not labelled (the bench skips dispatching
    // feedback for them; if a fake test injects one, we drop it from the
    // matrix to avoid mislabelling).
    if (outcome === "harness_error") continue;
    const passed = outcome === "pass";

    let row = perRef.get(fb.goldRef);
    if (!row) {
      row = { truePositive: 0, falsePositive: 0, trueNegative: 0, falseNegative: 0 };
      perRef.set(fb.goldRef, row);
    }
    if (fb.signal === "positive" && passed) {
      row.truePositive += 1;
      aggTP += 1;
    } else if (fb.signal === "positive" && !passed) {
      row.falsePositive += 1;
      aggFP += 1;
    } else if (fb.signal === "negative" && !passed) {
      row.trueNegative += 1;
      aggTN += 1;
    } else if (fb.signal === "negative" && passed) {
      row.falseNegative += 1;
      aggFN += 1;
    }
  }

  const aggTotal = aggTP + aggFP + aggTN + aggFN;
  const totalPhase1Runs = akmRuns.length;

  const aggregate: FeedbackIntegrityAggregate = {
    truePositive: aggTP,
    falsePositive: aggFP,
    trueNegative: aggTN,
    falseNegative: aggFN,
    feedback_agreement: aggTotal === 0 ? 0 : (aggTP + aggTN) / aggTotal,
    false_positive_rate: aggFP + aggTN === 0 ? 0 : aggFP / (aggFP + aggTN),
    false_negative_rate: aggFN + aggTP === 0 ? 0 : aggFN / (aggFN + aggTP),
    feedback_coverage: totalPhase1Runs === 0 ? 0 : coveredKeys.size / totalPhase1Runs,
  };

  const perAsset: FeedbackIntegrityPerAssetRow[] = [];
  for (const [ref, row] of [...perRef.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const total = row.truePositive + row.falsePositive + row.trueNegative + row.falseNegative;
    const fpDenom = row.falsePositive + row.trueNegative;
    const fnDenom = row.falseNegative + row.truePositive;
    perAsset.push({
      ref,
      truePositive: row.truePositive,
      falsePositive: row.falsePositive,
      trueNegative: row.trueNegative,
      falseNegative: row.falseNegative,
      feedback_agreement: total === 0 ? null : (row.truePositive + row.trueNegative) / total,
      false_positive_rate: fpDenom === 0 ? null : row.falsePositive / fpDenom,
      false_negative_rate: fnDenom === 0 ? null : row.falseNegative / fnDenom,
    });
  }

  return { aggregate, perAsset };
}
