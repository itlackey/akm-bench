/**
 * akm-bench proposal-quality metrics (§6.3).
 */

// ── Proposal-quality metrics (§6.3) ────────────────────────────────────────

/**
 * One proposal-lifecycle entry recorded by the evolve runner. The runner
 * collects these as it walks the queue produced by `akm distill` and `akm
 * reflect`. Each event captures the proposal id, its source asset ref, the
 * proposal kind (lesson vs revision), the lint outcome, and whether it was
 * accepted or rejected.
 */
export interface ProposalLogEntry {
  proposalId: string;
  /** Asset ref the proposal targets (the ref passed to distill/reflect). */
  assetRef: string;
  kind: "lesson" | "revision" | "unknown";
  /** Whether `akm proposal show --json` reported `lint_pass: true`. */
  lintPass: boolean;
  /** Terminal state. `accept` if the runner ran `proposal accept`; `reject` otherwise. */
  decision: "accept" | "reject";
  /** Reason recorded on rejection (lint failure detail, etc.). Empty on accept. */
  rejectReason?: string;
}

/** Per-asset row in the proposal-quality table (§6.3). */
export interface ProposalQualityRow {
  assetRef: string;
  proposalCount: number;
  lintPassCount: number;
  acceptedCount: number;
}

/** Aggregate proposal-quality metrics (§6.3). */
export interface ProposalQualityMetrics {
  rows: ProposalQualityRow[];
  totalProposals: number;
  totalAccepted: number;
  /** `accepted / proposals`. `0` when there are no proposals. */
  acceptanceRate: number;
  /** `lint_pass / proposals`. `0` when there are no proposals. */
  lintPassRate: number;
}

/**
 * Aggregate proposal-quality metrics from the evolve runner's proposal log.
 * Pure function — does not touch disk and does not invoke any subprocess.
 */
export function computeProposalQualityMetrics(proposalLog: ProposalLogEntry[]): ProposalQualityMetrics {
  const byRef = new Map<string, ProposalQualityRow>();
  let totalAccepted = 0;
  let totalLintPass = 0;
  for (const entry of proposalLog) {
    let row = byRef.get(entry.assetRef);
    if (!row) {
      row = { assetRef: entry.assetRef, proposalCount: 0, lintPassCount: 0, acceptedCount: 0 };
      byRef.set(entry.assetRef, row);
    }
    row.proposalCount += 1;
    if (entry.lintPass) {
      row.lintPassCount += 1;
      totalLintPass += 1;
    }
    if (entry.decision === "accept") {
      row.acceptedCount += 1;
      totalAccepted += 1;
    }
  }
  const rows = [...byRef.values()].sort((a, b) => a.assetRef.localeCompare(b.assetRef));
  const totalProposals = proposalLog.length;
  return {
    rows,
    totalProposals,
    totalAccepted,
    acceptanceRate: totalProposals === 0 ? 0 : totalAccepted / totalProposals,
    lintPassRate: totalProposals === 0 ? 0 : totalLintPass / totalProposals,
  };
}
