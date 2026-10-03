import fs from "node:fs";
import path from "node:path";
import { resolveAkmCommand } from "./akm-command";
import { getFixturesRoot } from "./fixtures-root";
import { benchMkdtemp } from "./tmp";

export type FragmentContractExpectation = "baseline" | "candidate";
export type FragmentContractStatus = "pass" | "fail" | "unsupported";

export interface FragmentContractCheck {
  id: string;
  category: "compatibility" | "context" | "bounds" | "provenance" | "safety" | "revision";
  status: FragmentContractStatus;
  description: string;
  evidence?: Record<string, unknown>;
}

export interface FragmentContractReport {
  schemaVersion: 1;
  benchmark: "akm-fragment-contract";
  fixtureVersion: "v1";
  expectation: FragmentContractExpectation;
  generatedAt: string;
  runtime: {
    command: string[];
    version: string;
    fingerprint?: string;
    sourceRevision?: string;
  };
  summary: {
    passed: number;
    failed: number;
    unsupported: number;
    candidateFeaturePasses: number;
    candidateFeatureTotal: number;
    gatePassed: boolean;
  };
  checks: FragmentContractCheck[];
}

export interface FragmentContractComparison {
  schemaVersion: 1;
  benchmark: "akm-fragment-contract-comparison";
  generatedAt: string;
  baseline: {
    version: string;
    fingerprint?: string;
    sourceRevision?: string;
    passed: number;
    failed: number;
    unsupported: number;
  };
  candidate: {
    version: string;
    fingerprint?: string;
    sourceRevision?: string;
    passed: number;
    failed: number;
    unsupported: number;
  };
  delta: {
    passed: number;
    failed: number;
    unsupported: number;
    candidateFeaturePasses: number;
  };
  regressions: string[];
  missingCandidateFeatures: string[];
  gatePassed: boolean;
}

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  json?: Record<string, unknown>;
}

const FEATURE_CHECK_IDS = new Set([
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
]);

const COMPATIBILITY_CHECK_IDS = new Set([
  "high-ordinal-selector",
  "exact-default-compatible",
  "exact-safe-projection",
  "stale-exact-selector",
]);

function copyDir(source: string, destination: string): void {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) copyDir(from, to);
    else if (entry.isFile()) fs.copyFileSync(from, to);
  }
}

function expandDeterministicFixture(stashDir: string): void {
  const timelinePath = path.join(stashDir, "memories", "decision-timeline.md");
  const source = fs.readFileSync(timelinePath, "utf8");
  const expanded = source
    .replace(
      "LEAD_CONTEXT_ANCHOR.",
      `LEAD_CONTEXT_ANCHOR.${" historical context remains non-authoritative".repeat(22)}`,
    )
    .replaceAll(
      /(FILLER_ANCHOR_\d+ records an unrelated completed checkpoint\.)/g,
      `$1${" ordinary background prose".repeat(55)}`,
    );
  fs.writeFileSync(timelinePath, expanded, "utf8");
}

function parseObject(raw: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function runCommand(command: readonly string[], args: readonly string[], env: NodeJS.ProcessEnv): CommandResult {
  const process = Bun.spawnSync({
    cmd: [...command, ...args],
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = new TextDecoder().decode(process.stdout ?? new Uint8Array()).trim();
  const stderr = new TextDecoder().decode(process.stderr ?? new Uint8Array()).trim();
  return {
    exitCode: process.exitCode ?? -1,
    stdout,
    stderr,
    ...(parseObject(stdout) ? { json: parseObject(stdout) } : {}),
  };
}

function contentOf(result: CommandResult): string {
  return typeof result.json?.content === "string" ? result.json.content : "";
}

function numberOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function firstHit(result: CommandResult): Record<string, unknown> | undefined {
  const hits = result.json?.hits;
  if (!Array.isArray(hits)) return undefined;
  const hit = hits[0];
  return hit !== null && typeof hit === "object" && !Array.isArray(hit) ? (hit as Record<string, unknown>) : undefined;
}

function safeProjectionHasNoLeaks(content: string): boolean {
  return !["COMMENT_LEAK_SENTINEL", "FENCED_LEAK_SENTINEL", "LINK_DESTINATION_LEAK_SENTINEL", "https://"].some(
    (sentinel) => content.includes(sentinel),
  );
}

function addCheck(
  checks: FragmentContractCheck[],
  input: Omit<FragmentContractCheck, "status"> & { passed: boolean; unsupported?: boolean },
): void {
  const { passed, unsupported, ...check } = input;
  checks.push({
    ...check,
    status: passed ? "pass" : unsupported ? "unsupported" : "fail",
  });
}

function commandEvidence(result: CommandResult): Record<string, unknown> {
  return {
    exitCode: result.exitCode,
    ...(result.stderr ? { stderr: result.stderr.slice(0, 500) } : {}),
  };
}

function candidateCapabilityAvailable(result: CommandResult): boolean {
  if (result.exitCode !== 0 || !result.json) return false;
  return result.json.contextMode === "lead";
}

export function runFragmentContract(options: {
  expectation: FragmentContractExpectation;
  akmCommand?: string[];
}): FragmentContractReport {
  const command = options.akmCommand ?? resolveAkmCommand();
  const fixture = path.join(getFixturesRoot(), "fragment-contract", "v1");
  const sandbox = benchMkdtemp("akm-fragment-contract-");
  const stashDir = path.join(sandbox, "stash");
  const cacheHome = path.join(sandbox, "cache");
  const configHome = path.join(sandbox, "config");
  const dataHome = path.join(sandbox, "data");
  const stateHome = path.join(sandbox, "state");
  const home = path.join(sandbox, "home");
  copyDir(fixture, stashDir);
  // Keep the checked-in fixture readable while still exercising an opaque
  // selector whose parent extends past the historical 20k read cap.
  expandDeterministicFixture(stashDir);
  fs.mkdirSync(cacheHome, { recursive: true });
  fs.mkdirSync(configHome, { recursive: true });
  fs.mkdirSync(dataHome, { recursive: true });
  fs.mkdirSync(stateHome, { recursive: true });
  fs.mkdirSync(home, { recursive: true });

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AKM_BUNDLE_DIR: stashDir,
    // Retain the retired spelling for old benchmark pins that still consume it.
    AKM_STASH_DIR: stashDir,
    XDG_CACHE_HOME: cacheHome,
    XDG_CONFIG_HOME: configHome,
    XDG_DATA_HOME: dataHome,
    XDG_STATE_HOME: stateHome,
    HOME: home,
    NO_COLOR: "1",
  };
  const invoke = (args: string[]): CommandResult => runCommand(command, [...args, "--format", "json", "-q"], env);
  const checks: FragmentContractCheck[] = [];

  try {
    const versionResult = runCommand(command, ["--version"], env);
    const version = versionResult.stdout || `exit:${versionResult.exitCode}`;
    const indexed = invoke(["index", "--full"]);
    if (indexed.exitCode !== 0) {
      throw new Error(`akm index failed (exit ${indexed.exitCode}): ${indexed.stderr || indexed.stdout}`);
    }

    const search = invoke([
      "search",
      "QUARTZCURRENTCHOICE",
      "--type",
      "memory",
      "--limit",
      "1",
      "--detail",
      "full",
      "--no-project-context",
    ]);
    const hit = firstHit(search);
    const selectedRef = typeof hit?.ref === "string" ? hit.ref : "";
    const fragmentIdOrdinal = Number(selectedRef.match(/#akm-fragment-(\d+)-/)?.[1]);

    addCheck(checks, {
      id: "high-ordinal-selector",
      category: "compatibility",
      description: "Search returns an opaque selected fragment above ordinal 20.",
      passed: search.exitCode === 0 && fragmentIdOrdinal >= 20,
      evidence: {
        selectedRef,
        fragmentIdOrdinal,
        ...(hit ? {} : { search: search.json ?? search.stdout.slice(0, 500), ...commandEvidence(search) }),
      },
    });

    const exact = selectedRef ? invoke(["show", selectedRef]) : search;
    const exactContent = contentOf(exact);
    addCheck(checks, {
      id: "exact-default-compatible",
      category: "compatibility",
      description: "A bare show remains exact and does not widen the selected fragment.",
      passed:
        exact.exitCode === 0 &&
        exactContent.includes("QUARTZCURRENTCHOICE") &&
        !exactContent.includes("LEAD_CONTEXT_ANCHOR") &&
        !exactContent.includes("PREVIOUS_FRAGMENT_ANCHOR") &&
        !exactContent.includes("NEXT_FRAGMENT_ANCHOR"),
      evidence: { chars: exactContent.length, ...commandEvidence(exact) },
    });
    addCheck(checks, {
      id: "exact-safe-projection",
      category: "safety",
      description: "Exact fragment content contains no excluded safe-projection bytes.",
      passed: exact.exitCode === 0 && safeProjectionHasNoLeaks(exactContent),
      evidence: { ...commandEvidence(exact) },
    });

    const hitOrdinal = numberOf(hit?.fragmentOrdinal);
    const hitCount = numberOf(hit?.fragmentCount);
    const hitFragmentTokens = numberOf(hit?.fragmentEstimatedTokens);
    const hitParentTokens = numberOf(hit?.parentEstimatedTokens);
    const searchProvenance =
      selectedRef.length > 0 &&
      hit?.selectedRef === selectedRef &&
      typeof hit?.parentRef === "string" &&
      hitOrdinal !== undefined &&
      hitOrdinal >= 20 &&
      hitCount !== undefined &&
      hitCount > hitOrdinal &&
      numberOf(hit?.startLine) !== undefined &&
      numberOf(hit?.endLine) !== undefined &&
      typeof hit?.previousRef === "string" &&
      typeof hit?.nextRef === "string" &&
      numberOf(hit?.fragmentChars) !== undefined &&
      hitFragmentTokens !== undefined &&
      hitParentTokens !== undefined &&
      hit?.estimatedTokens === hitFragmentTokens &&
      hitParentTokens > hitFragmentTokens &&
      typeof hit?.matchStage === "string";
    addCheck(checks, {
      id: "fragment-provenance-search",
      category: "provenance",
      description: "Search exposes selected/parent provenance and separate fragment/parent estimates.",
      passed: searchProvenance,
      unsupported: search.exitCode === 0 && hit !== undefined && hit?.selectedRef === undefined,
      evidence: {
        selectedRef,
        parentRef: hit?.parentRef,
        fragmentOrdinal: hitOrdinal,
        fragmentCount: hitCount,
        estimatedTokens: hit?.estimatedTokens,
        fragmentEstimatedTokens: hitFragmentTokens,
        parentEstimatedTokens: hitParentTokens,
      },
    });

    const showProvenance =
      exact.json?.selectedRef === selectedRef &&
      typeof exact.json?.parentRef === "string" &&
      exact.json?.ref === exact.json?.parentRef &&
      numberOf(exact.json?.fragmentOrdinal) === hitOrdinal &&
      numberOf(exact.json?.fragmentCount) === hitCount &&
      typeof exact.json?.previousRef === "string" &&
      typeof exact.json?.nextRef === "string" &&
      numberOf(exact.json?.fragmentChars) === exactContent.length &&
      numberOf(exact.json?.fragmentEstimatedTokens) !== undefined &&
      numberOf(exact.json?.parentEstimatedTokens) !== undefined;
    addCheck(checks, {
      id: "fragment-provenance-show",
      category: "provenance",
      description: "Show preserves canonical parent ref while reporting the selected fragment.",
      passed: showProvenance,
      unsupported: exact.exitCode === 0 && exact.json?.selectedRef === undefined,
      evidence: {
        ref: exact.json?.ref,
        selectedRef: exact.json?.selectedRef,
        parentRef: exact.json?.parentRef,
        fragmentOrdinal: exact.json?.fragmentOrdinal,
        fragmentCount: exact.json?.fragmentCount,
      },
    });

    const lead = selectedRef ? invoke(["show", selectedRef, "--context", "lead"]) : search;
    const leadContent = contentOf(lead);
    const selectedPosition = leadContent.indexOf("QUARTZCURRENTCHOICE");
    const markerPosition = leadContent.indexOf("[Selected matching fragment]");
    const leadAvailable = candidateCapabilityAvailable(lead);
    addCheck(checks, {
      id: "lead-context-indexed-safe",
      category: "context",
      description: "Lead context combines indexed-safe lead and selected fragments with an explicit marker.",
      passed:
        leadAvailable &&
        leadContent.includes("LEAD_CONTEXT_ANCHOR") &&
        markerPosition >= 0 &&
        selectedPosition > markerPosition &&
        safeProjectionHasNoLeaks(leadContent),
      unsupported: !leadAvailable,
      evidence: { chars: leadContent.length, contextMode: lead.json?.contextMode, ...commandEvidence(lead) },
    });
    addCheck(checks, {
      id: "lead-context-default-bound",
      category: "bounds",
      description: "The default lead context is hard-bounded to 3200 characters.",
      passed:
        leadAvailable &&
        leadContent.length <= 3200 &&
        lead.json?.contextMaxChars === 3200 &&
        typeof lead.json?.contextTruncated === "boolean",
      unsupported: !leadAvailable,
      evidence: {
        chars: leadContent.length,
        contextMaxChars: lead.json?.contextMaxChars,
        contextTruncated: lead.json?.contextTruncated,
      },
    });

    const charBound = selectedRef
      ? invoke(["show", selectedRef, "--context", "lead", "--max-chars", "700"])
      : search;
    const charBoundContent = contentOf(charBound);
    const charBoundAvailable = candidateCapabilityAvailable(charBound);
    addCheck(checks, {
      id: "lead-context-char-bound",
      category: "bounds",
      description: "--max-chars enforces its bound while retaining the selected match.",
      passed:
        charBoundAvailable &&
        charBoundContent.length <= 700 &&
        charBoundContent.includes("QUARTZCURRENTCHOICE") &&
        charBound.json?.contextMaxChars === 700 &&
        charBound.json?.contextTruncated === true,
      unsupported: !charBoundAvailable,
      evidence: {
        chars: charBoundContent.length,
        contextMaxChars: charBound.json?.contextMaxChars,
        contextTruncated: charBound.json?.contextTruncated,
        ...commandEvidence(charBound),
      },
    });

    const tokenBound = selectedRef
      ? invoke(["show", selectedRef, "--context", "lead", "--max-tokens", "200"])
      : search;
    const tokenBoundContent = contentOf(tokenBound);
    const tokenBoundAvailable = candidateCapabilityAvailable(tokenBound);
    addCheck(checks, {
      id: "lead-context-token-bound",
      category: "bounds",
      description: "--max-tokens applies the documented four-characters-per-token bound.",
      passed:
        tokenBoundAvailable &&
        tokenBoundContent.length <= 800 &&
        tokenBoundContent.includes("QUARTZCURRENTCHOICE") &&
        tokenBound.json?.contextMaxChars === 800 &&
        tokenBound.json?.contextTruncated === true,
      unsupported: !tokenBoundAvailable,
      evidence: {
        chars: tokenBoundContent.length,
        contextMaxChars: tokenBound.json?.contextMaxChars,
        contextTruncated: tokenBound.json?.contextTruncated,
        ...commandEvidence(tokenBound),
      },
    });

    const previousRef = typeof exact.json?.previousRef === "string" ? exact.json.previousRef : "";
    const nextRef = typeof exact.json?.nextRef === "string" ? exact.json.nextRef : "";
    const previous = previousRef ? invoke(["show", previousRef]) : undefined;
    const next = nextRef ? invoke(["show", nextRef]) : undefined;
    addCheck(checks, {
      id: "neighbor-navigation",
      category: "context",
      description: "Previous and next provenance refs resolve exact adjacent fragments.",
      passed:
        previous !== undefined &&
        next !== undefined &&
        previous.exitCode === 0 &&
        next.exitCode === 0 &&
        contentOf(previous).includes("PREVIOUS_FRAGMENT_ANCHOR") &&
        contentOf(next).includes("NEXT_FRAGMENT_ANCHOR") &&
        !contentOf(previous).includes("QUARTZCURRENTCHOICE") &&
        !contentOf(next).includes("QUARTZCURRENTCHOICE"),
      unsupported: previousRef.length === 0 || nextRef.length === 0,
      evidence: { previousRef, nextRef },
    });

    const oldPreference = leadContent.indexOf("ORANGE");
    const currentPreference = leadContent.indexOf("COBALT");
    addCheck(checks, {
      id: "temporal-selected-last",
      category: "context",
      description: "When lead and selected facts conflict, the labeled current match appears last.",
      passed:
        leadAvailable &&
        oldPreference >= 0 &&
        markerPosition > oldPreference &&
        currentPreference > markerPosition &&
        leadContent.slice(currentPreference).includes("authoritative"),
      unsupported: !leadAvailable,
      evidence: { oldPreference, markerPosition, currentPreference },
    });

    const conflictingBudgets = selectedRef
      ? invoke([
          "show",
          selectedRef,
          "--context",
          "lead",
          "--max-chars",
          "700",
          "--max-tokens",
          "200",
        ])
      : search;
    const conflictText = `${conflictingBudgets.stderr}\n${conflictingBudgets.stdout}`.toLowerCase();
    const supportsBudgetFlags = charBoundAvailable && tokenBoundAvailable;
    addCheck(checks, {
      id: "mutually-exclusive-budgets",
      category: "bounds",
      description: "Supplying both budget axes is rejected rather than silently choosing one.",
      passed:
        supportsBudgetFlags &&
        conflictingBudgets.exitCode !== 0 &&
        (conflictText.includes("mutually exclusive") || conflictText.includes("cannot be used together")),
      unsupported: !supportsBudgetFlags,
      evidence: commandEvidence(conflictingBudgets),
    });

    const sourcePath = path.join(stashDir, "memories", "decision-timeline.md");
    fs.appendFileSync(
      sourcePath,
      "\n## Unindexed mutation\n\nDISK_ONLY_MUTATION. The current preference is MAGENTA.\n",
      "utf8",
    );
    const staleExact = selectedRef ? invoke(["show", selectedRef]) : search;
    const staleExactContent = contentOf(staleExact);
    addCheck(checks, {
      id: "stale-exact-selector",
      category: "revision",
      description: "An opaque selector remains pinned to the indexed revision after a disk edit.",
      passed:
        staleExact.exitCode === 0 &&
        staleExactContent.includes("QUARTZCURRENTCHOICE") &&
        !staleExactContent.includes("DISK_ONLY_MUTATION") &&
        !staleExactContent.includes("MAGENTA"),
      evidence: { ...commandEvidence(staleExact) },
    });

    const staleLead = selectedRef ? invoke(["show", selectedRef, "--context", "lead"]) : search;
    const staleLeadContent = contentOf(staleLead);
    const staleLeadAvailable = candidateCapabilityAvailable(staleLead);
    addCheck(checks, {
      id: "stale-lead-context",
      category: "revision",
      description: "Expanded context uses the same indexed revision as the selected fragment.",
      passed:
        staleLeadAvailable &&
        staleLeadContent.includes("LEAD_CONTEXT_ANCHOR") &&
        staleLeadContent.includes("QUARTZCURRENTCHOICE") &&
        !staleLeadContent.includes("DISK_ONLY_MUTATION") &&
        !staleLeadContent.includes("MAGENTA") &&
        safeProjectionHasNoLeaks(staleLeadContent),
      unsupported: !staleLeadAvailable,
      evidence: { chars: staleLeadContent.length, ...commandEvidence(staleLead) },
    });

    const passed = checks.filter((check) => check.status === "pass").length;
    const failed = checks.filter((check) => check.status === "fail").length;
    const unsupported = checks.filter((check) => check.status === "unsupported").length;
    const candidateFeaturePasses = checks.filter(
      (check) => FEATURE_CHECK_IDS.has(check.id) && check.status === "pass",
    ).length;
    const compatibilityPassed = checks
      .filter((check) => COMPATIBILITY_CHECK_IDS.has(check.id))
      .every((check) => check.status === "pass");
    const candidateFeaturesPassed = checks
      .filter((check) => FEATURE_CHECK_IDS.has(check.id))
      .every((check) => check.status === "pass");
    const gatePassed =
      options.expectation === "baseline"
        ? compatibilityPassed && failed === 0
        : compatibilityPassed && candidateFeaturesPassed;

    return {
      schemaVersion: 1,
      benchmark: "akm-fragment-contract",
      fixtureVersion: "v1",
      expectation: options.expectation,
      generatedAt: new Date().toISOString(),
      runtime: {
        command,
        version,
        ...(process.env.AKM_BENCH_RUNTIME_FINGERPRINT
          ? { fingerprint: process.env.AKM_BENCH_RUNTIME_FINGERPRINT }
          : {}),
        ...(process.env.AKM_BENCH_RUNTIME_REVISION ? { sourceRevision: process.env.AKM_BENCH_RUNTIME_REVISION } : {}),
      },
      summary: {
        passed,
        failed,
        unsupported,
        candidateFeaturePasses,
        candidateFeatureTotal: FEATURE_CHECK_IDS.size,
        gatePassed,
      },
      checks,
    };
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

export function compareFragmentContractReports(
  baseline: FragmentContractReport,
  candidate: FragmentContractReport,
): FragmentContractComparison {
  const baselineChecks = new Map(baseline.checks.map((check) => [check.id, check]));
  const candidateChecks = new Map(candidate.checks.map((check) => [check.id, check]));
  const regressions = [...COMPATIBILITY_CHECK_IDS].filter(
    (id) => baselineChecks.get(id)?.status === "pass" && candidateChecks.get(id)?.status !== "pass",
  );
  const missingCandidateFeatures = [...FEATURE_CHECK_IDS].filter((id) => candidateChecks.get(id)?.status !== "pass");
  const candidateImprovement = candidate.summary.candidateFeaturePasses - baseline.summary.candidateFeaturePasses;
  const gatePassed =
    baseline.summary.gatePassed &&
    candidate.summary.gatePassed &&
    regressions.length === 0 &&
    missingCandidateFeatures.length === 0 &&
    candidateImprovement > 0;

  return {
    schemaVersion: 1,
    benchmark: "akm-fragment-contract-comparison",
    generatedAt: new Date().toISOString(),
    baseline: {
      version: baseline.runtime.version,
      ...(baseline.runtime.fingerprint ? { fingerprint: baseline.runtime.fingerprint } : {}),
      ...(baseline.runtime.sourceRevision ? { sourceRevision: baseline.runtime.sourceRevision } : {}),
      passed: baseline.summary.passed,
      failed: baseline.summary.failed,
      unsupported: baseline.summary.unsupported,
    },
    candidate: {
      version: candidate.runtime.version,
      ...(candidate.runtime.fingerprint ? { fingerprint: candidate.runtime.fingerprint } : {}),
      ...(candidate.runtime.sourceRevision ? { sourceRevision: candidate.runtime.sourceRevision } : {}),
      passed: candidate.summary.passed,
      failed: candidate.summary.failed,
      unsupported: candidate.summary.unsupported,
    },
    delta: {
      passed: candidate.summary.passed - baseline.summary.passed,
      failed: candidate.summary.failed - baseline.summary.failed,
      unsupported: candidate.summary.unsupported - baseline.summary.unsupported,
      candidateFeaturePasses: candidateImprovement,
    },
    regressions,
    missingCandidateFeatures,
    gatePassed,
  };
}

export function readFragmentContractReport(filePath: string): FragmentContractReport {
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as FragmentContractReport;
  if (parsed.schemaVersion !== 1 || parsed.benchmark !== "akm-fragment-contract" || !Array.isArray(parsed.checks)) {
    throw new Error(`Not an akm fragment-contract report: ${filePath}`);
  }
  return parsed;
}
