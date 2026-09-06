/**
 * akm-bench git helper functions.
 */

import { execSync } from "node:child_process";

// ── Git helpers ────────────────────────────────────────────────────────────

/**
 * Resolve `git rev-parse --abbrev-ref HEAD`. Falls back to `"unknown"` if
 * git is unavailable or the cwd is not a repo. Tests inject `cwd` to point
 * at a tmp non-repo to exercise the fallback.
 */
export function resolveGitBranch(cwd?: string): string {
  const resolved = tryGit(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  if (resolved !== "unknown" || cwd !== undefined) return resolved;
  return process.env.AKM_BENCH_IMAGE_REPO_BRANCH?.trim() || "unknown";
}

/**
 * Resolve `git rev-parse --short HEAD`. Same fallback rules as
 * `resolveGitBranch`.
 */
export function resolveGitCommit(cwd?: string): string {
  const resolved = tryGit(["rev-parse", "--short", "HEAD"], cwd);
  if (resolved !== "unknown" || cwd !== undefined) return resolved;
  const commit = process.env.AKM_BENCH_IMAGE_REPO_COMMIT?.trim();
  if (!commit) return "unknown";
  return process.env.AKM_BENCH_IMAGE_REPO_DIRTY === "true" ? `${commit}-dirty` : commit;
}

function tryGit(args: string[], cwd?: string): string {
  try {
    const out = execSync(`git ${args.join(" ")}`, {
      cwd: cwd ?? process.cwd(),
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    });
    return out.trim() || "unknown";
  } catch {
    return "unknown";
  }
}
