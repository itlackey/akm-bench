import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import {
  compareFragmentContractReports,
  type FragmentContractCheck,
  type FragmentContractReport,
} from "../src/fragment-contract";

const compatibilityIds = [
  "high-ordinal-selector",
  "exact-default-compatible",
  "exact-safe-projection",
  "stale-exact-selector",
];
const featureIds = [
  "fragment-provenance-search",
  "fragment-provenance-show",
  "lead-context-indexed-safe",
  "lead-context-default-bound",
  "lead-context-char-bound",
  "lead-context-token-bound",
  "neighbor-navigation",
  "temporal-selected-last",
  "stale-lead-context",
  "mutually-exclusive-budgets",
];

function check(id: string, status: FragmentContractCheck["status"]): FragmentContractCheck {
  return {
    id,
    category: compatibilityIds.includes(id) ? "compatibility" : "context",
    status,
    description: id,
  };
}

function report(expectation: "baseline" | "candidate", compatibilityStatus: "pass" | "fail"): FragmentContractReport {
  const featureStatus = expectation === "baseline" ? "unsupported" : "pass";
  const checks = [
    ...compatibilityIds.map((id) => check(id, compatibilityStatus)),
    ...featureIds.map((id) => check(id, featureStatus)),
  ];
  return {
    schemaVersion: 1,
    benchmark: "akm-fragment-contract",
    fixtureVersion: "v1",
    expectation,
    generatedAt: "2026-09-07T00:00:00.000Z",
    runtime: { command: ["akm"], version: expectation === "baseline" ? "0.9.14" : "0.9.15" },
    summary: {
      passed: checks.filter((item) => item.status === "pass").length,
      failed: checks.filter((item) => item.status === "fail").length,
      unsupported: checks.filter((item) => item.status === "unsupported").length,
      candidateFeaturePasses: checks.filter((item) => featureIds.includes(item.id) && item.status === "pass").length,
      candidateFeatureTotal: featureIds.length,
      gatePassed: compatibilityStatus === "pass",
    },
    checks,
  };
}

describe("fragment contract benchmark", () => {
  test("ships a temporal, high-ordinal, safe-projection fixture", () => {
    const fixture = fs.readFileSync(
      path.join(import.meta.dir, "../fixtures/fragment-contract/v1/memories/decision-timeline.md"),
      "utf8",
    );
    expect(fixture).toContain("LEAD_CONTEXT_ANCHOR");
    expect(fixture).toContain("QUARTZCURRENTCHOICE");
    expect(fixture).toContain("PREVIOUS_FRAGMENT_ANCHOR");
    expect(fixture).toContain("NEXT_FRAGMENT_ANCHOR");
    expect(fixture).toContain("COMMENT_LEAK_SENTINEL");
    expect(fixture).toContain("FENCED_LEAK_SENTINEL");
    expect(fixture).toContain("LINK_DESTINATION_LEAK_SENTINEL");
    expect(fixture.match(/^## Checkpoint/gm) ?? []).toHaveLength(18);
  });

  test("accepts a candidate that adds every context feature without an exact-selector regression", () => {
    const comparison = compareFragmentContractReports(report("baseline", "pass"), report("candidate", "pass"));
    expect(comparison.gatePassed).toBe(true);
    expect(comparison.regressions).toEqual([]);
    expect(comparison.missingCandidateFeatures).toEqual([]);
    expect(comparison.delta.candidateFeaturePasses).toBe(featureIds.length);
  });

  test("rejects a candidate compatibility regression", () => {
    const comparison = compareFragmentContractReports(report("baseline", "pass"), report("candidate", "fail"));
    expect(comparison.gatePassed).toBe(false);
    expect(comparison.regressions).toEqual(compatibilityIds);
  });

  test("rejects a candidate with a missing context capability", () => {
    const candidate = report("candidate", "pass");
    const missing = candidate.checks.find((item) => item.id === "stale-lead-context");
    if (!missing) throw new Error("fixture report is missing stale-lead-context");
    missing.status = "unsupported";
    candidate.summary.passed--;
    candidate.summary.unsupported++;
    candidate.summary.candidateFeaturePasses--;
    candidate.summary.gatePassed = false;

    const comparison = compareFragmentContractReports(report("baseline", "pass"), candidate);
    expect(comparison.gatePassed).toBe(false);
    expect(comparison.missingCandidateFeatures).toEqual(["stale-lead-context"]);
  });
});
