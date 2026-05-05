/**
 * akm-bench failure-mode taxonomy metrics (§6.6).
 */

import type { TaskMetadata } from "../corpus";
import type { RunResult } from "../driver";

// ── Failure-mode taxonomy (§6.6) ───────────────────────────────────────────

/**
 * The failure-mode labels defined by spec §6.6. Exactly one applies to every
 * failed run; `unrelated_bug` is the catch-all when nothing more specific
 * matches.
 *
 *   no_search       — agent never invoked `akm search`. AGENTS.md problem.
 *   search_no_gold  — search ran but gold ref absent from result list.
 *   search_low_rank — gold ref present at rank > 5.
 *   loaded_wrong    — `akm show` on a non-gold ref before the action AND
 *                     the gold ref was never loaded.
 *   loaded_ignored  — gold ref loaded; agent wrote workspace from memory
 *                     instead of applying asset content.
 *   followed_wrong  — gold ref loaded and apparently followed; verifier
 *                     still failed (asset itself is wrong).
 *   unrelated_bug   — none of the above; not an akm problem.
 *   no_events       — trajectory data unavailable (no events stream); cannot
 *                     determine correctAssetLoaded.
 */
export type FailureMode =
  | "no_search"
  | "search_no_gold"
  | "search_low_rank"
  | "loaded_wrong"
  | "loaded_ignored"
  | "followed_wrong"
  | "unrelated_bug"
  | "no_events";

/** Maximum rank at which the gold ref still counts as "found"; > this is `search_low_rank`. */
const SEARCH_RANK_CUTOFF = 5;

/** Cap on the number of characters of `verifierStdout` we substring-scan. Mirrors trajectory.ts. */
const FAILURE_MODE_STDOUT_SCAN_CAP = 16 * 1024 * 1024;

/**
 * Classify a single failed run into one of the §6.6 labels. Pure function —
 * consults `runResult.trajectory.correctAssetLoaded` first (trajectory data
 * is authoritative when present), then falls back to string-matching
 * `runResult.events[]` and `runResult.verifierStdout`. Never calls an LLM,
 * never touches the filesystem.
 *
 * Decision tree (priority order — first match wins):
 *   1. Run not failed (`pass`, `budget_exceeded`, `harness_error`) → `null`.
 *   2. `trajectory.correctAssetLoaded === true` → the agent loaded the gold
 *      asset but still failed. This is `loaded_ignored` (agent wrote from
 *      memory instead of applying asset content). This short-circuit fixes
 *      the 2026-05-03 baseline bug where 24/25 `search_no_gold` labels were
 *      wrong because the classifier didn't consult trajectory data.
 *   3. No `akm search` call in the trace:
 *      a. If task has no `goldRef` (so `correctAssetLoaded` is always null)
 *         → `no_events` (trajectory metric undefined; cannot distinguish
 *         "agent ran but events absent" from "agent never ran").
 *      b. Otherwise → `no_search`.
 *   4. Search ran, no goldRef → `unrelated_bug`.
 *   5. Search ran; gold ref absent from results → `search_no_gold`.
 *      (Only reachable when `correctAssetLoaded` is false or null, since
 *      true is handled in step 2.)
 *   6. Gold ref present at rank > 5 → `search_low_rank`.
 *   7. `akm show` invoked on a non-gold ref AND gold ref never loaded
 *      → `loaded_wrong`.
 *   8. Gold ref loaded; verifier output suggests the action contradicts the
 *      asset's guidance → `loaded_ignored`.
 *   9. Gold ref loaded and apparently followed → `followed_wrong`.
 *  10. Default → `unrelated_bug`.
 */
export function classifyFailureMode(taskMeta: TaskMetadata, runResult: RunResult): FailureMode | null {
  if (runResult.outcome !== "fail") return null;

  const goldRef = taskMeta.goldRef;
  const correctAssetLoaded = runResult.trajectory?.correctAssetLoaded;

  // 1. Trajectory short-circuit: if events data confirms the gold asset was
  //    loaded, the failure must be compliance-related, not discovery-related.
  //    Return `loaded_ignored` immediately without scanning stdout.
  if (correctAssetLoaded === true) {
    return "loaded_ignored";
  }

  const trace = collectTrace(runResult);

  // 2. no_search / no_events — no `akm search` invocation anywhere in the trace.
  if (!hasAkmSearch(trace, runResult)) {
    // When there is no goldRef, correctAssetLoaded is always null (the metric
    // is undefined). We cannot tell whether the agent genuinely didn't search
    // or whether events data was simply absent. Use `no_events` to surface
    // this ambiguity rather than conflating it with `no_search`.
    if (!goldRef) {
      return "no_events";
    }
    return "no_search";
  }

  // Without a gold ref the search-based and load-based checks are undefined.
  // We can only distinguish "no_search" / "no_events" from everything else.
  if (!goldRef) {
    return "unrelated_bug";
  }

  const searchRank = findGoldSearchRank(trace, goldRef);
  // 3. search_no_gold — search ran (precondition above) but gold ref absent.
  //    Only reachable when correctAssetLoaded is false or null (trajectory
  //    data indicates gold was not loaded), because true is handled above.
  if (searchRank === null) {
    return "search_no_gold";
  }
  // 4. search_low_rank — present but below the cutoff.
  if (searchRank > SEARCH_RANK_CUTOFF) {
    return "search_low_rank";
  }

  const goldLoaded = hasAkmShow(trace, runResult, goldRef);
  const otherRefLoaded = hasAkmShowOtherRef(trace, runResult, goldRef);

  // 5. loaded_wrong — agent showed a non-gold ref AND never loaded the gold.
  if (otherRefLoaded && !goldLoaded) {
    return "loaded_wrong";
  }

  // The remaining branches all assume the gold was loaded.
  if (!goldLoaded) {
    // Gold ref was found in search at an acceptable rank, but the agent
    // never loaded anything (gold or otherwise) before failing. The taxonomy
    // table has no row for "found but never opened" — treat as unrelated_bug.
    return "unrelated_bug";
  }

  // 6. loaded_ignored — verifier diagnostic indicates the action contradicts
  //    the loaded asset. Conservative heuristic: look for explicit "ignored"
  //    or "not applied" markers in the verifier stdout. Without an LLM we
  //    cannot detect subtler contradictions, so this branch only fires when
  //    the verifier itself flagged the contradiction.
  if (verifierIndicatesIgnored(runResult.verifierStdout)) {
    return "loaded_ignored";
  }

  // 7. followed_wrong — gold loaded, apparently followed, verifier still
  //    failed. The §6.6 spec maps this to "the asset itself is wrong".
  return "followed_wrong";
}

/**
 * Aggregate per-label counts plus a per-task breakdown. Produced once per
 * `runUtility` call; embedded in `UtilityRunReport.failureModes`.
 */
export interface FailureModeAggregate {
  /** Total count per label across the entire corpus. Missing labels are absent. */
  byLabel: Partial<Record<FailureMode, number>>;
  /** Per-task breakdown, keyed by `taskId` then label. */
  byTask: Record<string, Partial<Record<FailureMode, number>>>;
}

/** Build a `FailureModeAggregate` from a list of (taskId, label) pairs. */
export function aggregateFailureModes(entries: Array<{ taskId: string; mode: FailureMode }>): FailureModeAggregate {
  const byLabel: Partial<Record<FailureMode, number>> = {};
  const byTask: Record<string, Partial<Record<FailureMode, number>>> = {};
  for (const { taskId, mode } of entries) {
    byLabel[mode] = (byLabel[mode] ?? 0) + 1;
    if (!byTask[taskId]) byTask[taskId] = {};
    byTask[taskId][mode] = (byTask[taskId][mode] ?? 0) + 1;
  }
  return { byLabel, byTask };
}

// ── Failure-mode classifier helpers ────────────────────────────────────────

/**
 * Concatenated string used for substring scans. We pre-build this once per
 * classify call so the helper functions can share it. Stdout is capped per
 * the trajectory parser convention to keep runaway agents from OOMing the
 * bench.
 */
function collectTrace(runResult: RunResult): string {
  const stdout = runResult.verifierStdout ?? "";
  const capped = stdout.length > FAILURE_MODE_STDOUT_SCAN_CAP ? stdout.slice(0, FAILURE_MODE_STDOUT_SCAN_CAP) : stdout;
  return capped;
}

/** Does the trace contain any `akm search` invocation (CLI form OR event)? */
function hasAkmSearch(trace: string, runResult: RunResult): boolean {
  // Tool-call CLI form, e.g. `akm search "deploy homelab"`.
  if (/\bakm\s+search\b/.test(trace)) return true;
  // Tool-call JSON form, e.g. `"args":["search","..."]`.
  if (trace.includes(`"search"`) && /["']search["']/.test(trace)) return true;
  // Event-stream form (search verbs aren't currently emitted but the field
  // is forward-compatible — see core/events.ts).
  for (const event of runResult.events) {
    if (event.eventType === "search" || event.eventType === "search_invoked") return true;
  }
  return false;
}

/**
 * Find the 1-based rank of `goldRef` in the search results captured in the
 * trace, or `null` if not present. Best-effort heuristics:
 *   1. Look for an `akm search` block followed by a numbered list (`1. skill:foo`).
 *   2. Look for a JSON-ish results array containing the ref.
 *   3. Fall back to substring presence — if the ref appears anywhere after
 *      a search invocation, treat it as rank-unknown. We err on the side of
 *      `1` (best case for the agent) so the classifier doesn't false-positive
 *      on `search_low_rank`.
 */
function findGoldSearchRank(trace: string, goldRef: string): number | null {
  // Locate the first `akm search` invocation; restrict the rank search to
  // text after it so we don't pick up `akm show` output.
  const searchMatch = trace.match(/\bakm\s+search\b/);
  if (!searchMatch || searchMatch.index === undefined) {
    // Caller already verified search ran; if our regex disagrees, fall back
    // to scanning the full trace.
    return findRefRankInText(trace, goldRef);
  }
  const after = trace.slice(searchMatch.index);
  return findRefRankInText(after, goldRef);
}

function findRefRankInText(text: string, goldRef: string): number | null {
  const escaped = goldRef.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Numbered list: lines of the form `<rank>. <ref>` or `<rank>) <ref>`.
  const numberedRe = /^\s*(\d{1,3})[.)]\s+([^\s]+)/gm;
  let match: RegExpExecArray | null;
  while (true) {
    match = numberedRe.exec(text);
    if (match === null) break;
    const ref = match[2];
    if (refsMatch(ref, goldRef)) {
      return Number.parseInt(match[1], 10);
    }
  }
  // JSON array form: `"results":["a","b","skill:foo"]`. Estimate rank by
  // splitting on commas after the bracket. Best-effort.
  const jsonRe = /"results"\s*:\s*\[([^\]]+)\]/;
  const jsonMatch = text.match(jsonRe);
  if (jsonMatch) {
    const items = jsonMatch[1].split(",").map((s) => s.trim().replace(/^["']|["']$/g, ""));
    const idx = items.findIndex((item) => refsMatch(item, goldRef));
    if (idx >= 0) return idx + 1;
  }
  // Substring presence — assume rank 1 (best case for the agent, conservative
  // for the `search_low_rank` rule).
  const refRe = new RegExp(`\\b${escaped}\\b`);
  if (refRe.test(text)) return 1;
  return null;
}

/** True when `candidate` is `goldRef` or a strict ref-extension thereof. */
function refsMatch(candidate: string, goldRef: string): boolean {
  if (candidate === goldRef) return true;
  if (candidate.endsWith(`//${goldRef}`)) return true;
  if (candidate.startsWith(`${goldRef}/`)) return true;
  return false;
}

/** Did the agent invoke `akm show <goldRef>` at any point? */
function hasAkmShow(trace: string, runResult: RunResult, goldRef: string): boolean {
  const escaped = goldRef.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // CLI form, exact ref. Also matches origin-prefixed variants like
  // `akm show team//skill:foo` because the `[\w/]*//` prefix is optional.
  const cliRe = new RegExp(`\\bakm\\s+show\\s+["']?(?:[\\w-]+//)?${escaped}(?:\\b|\\W)`);
  if (cliRe.test(trace)) return true;
  // Tool-call JSON form: `"args":["show","skill:foo"]`.
  if (trace.includes(`"show"`) && trace.includes(goldRef)) return true;
  // Event-stream metadata.ref.
  for (const event of runResult.events) {
    if (typeof event.ref === "string" && refsMatch(event.ref, goldRef)) {
      // Only count "show" or "load" eventTypes; a `feedback` event mentioning
      // the ref doesn't mean the agent loaded it during this run.
      if (event.eventType === "show" || event.eventType === "load" || event.eventType === "tool_call") return true;
    }
    const meta = event.metadata;
    if (meta && typeof meta === "object") {
      const candidate = (meta as Record<string, unknown>).ref;
      if (typeof candidate === "string" && refsMatch(candidate, goldRef)) {
        if (event.eventType === "show" || event.eventType === "load" || event.eventType === "tool_call") return true;
      }
    }
  }
  return false;
}

/** Did the agent invoke `akm show <ref>` for some ref OTHER than `goldRef`? */
function hasAkmShowOtherRef(trace: string, runResult: RunResult, goldRef: string): boolean {
  // CLI form: capture the ref argument and reject when it matches the gold.
  const cliRe = /\bakm\s+show\s+["']?([^\s"'`]+)/g;
  let match: RegExpExecArray | null;
  while (true) {
    match = cliRe.exec(trace);
    if (match === null) break;
    if (!refsMatch(match[1], goldRef)) return true;
  }
  // Tool-call JSON form: `"args":["show","..."]`. Best-effort scan.
  const jsonRe = /\["show",\s*"([^"]+)"/g;
  while (true) {
    match = jsonRe.exec(trace);
    if (match === null) break;
    if (!refsMatch(match[1], goldRef)) return true;
  }
  // Event-stream form.
  for (const event of runResult.events) {
    if (event.eventType !== "show" && event.eventType !== "load" && event.eventType !== "tool_call") continue;
    if (typeof event.ref === "string" && !refsMatch(event.ref, goldRef)) return true;
    const meta = event.metadata;
    if (meta && typeof meta === "object") {
      const candidate = (meta as Record<string, unknown>).ref;
      if (typeof candidate === "string" && !refsMatch(candidate, goldRef)) return true;
    }
  }
  return false;
}

/**
 * Conservative heuristic for the `loaded_ignored` branch. Without an LLM we
 * cannot reliably decide whether an arbitrary action contradicts arbitrary
 * asset content; we only fire when the verifier's own diagnostic explicitly
 * flags the gold-asset guidance as ignored.
 *
 * The verifier stdout strings are deterministic — they come from
 * `runVerifier` and the per-task `verify.sh` scripts. Tasks that want to
 * surface this label should emit one of the agreed-upon markers below.
 */
function verifierIndicatesIgnored(verifierStdout: string): boolean {
  if (!verifierStdout) return false;
  const lower = verifierStdout.toLowerCase();
  return (
    lower.includes("ignored gold guidance") ||
    lower.includes("guidance ignored") ||
    lower.includes("did not follow loaded asset") ||
    lower.includes("contradicts loaded asset")
  );
}
