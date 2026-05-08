import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "..");
const LOCAL_AKM_BIN = path.join(REPO_ROOT, "node_modules", ".bin", process.platform === "win32" ? "akm.cmd" : "akm");

export interface ResolvedAkmRuntime {
  command: string[];
  binPath: string;
  binDir?: string;
}

function isJavaScriptEntrypoint(candidate: string): boolean {
  try {
    const resolved = fs.realpathSync(candidate);
    return [".js", ".mjs", ".cjs"].includes(path.extname(resolved));
  } catch {
    return [".js", ".mjs", ".cjs"].includes(path.extname(candidate));
  }
}

function resolveFileRuntime(candidate: string): ResolvedAkmRuntime {
  return {
    command: isJavaScriptEntrypoint(candidate) ? ["bun", candidate] : [candidate],
    binPath: candidate,
    binDir: path.dirname(candidate),
  };
}

export function resolveAkmRuntime(): ResolvedAkmRuntime {
  const override = process.env.AKM_BENCH_AKM_BIN?.trim();
  if (override) {
    if (fs.existsSync(override)) return resolveFileRuntime(override);
    return { command: [override], binPath: override, ...(path.isAbsolute(override) ? { binDir: path.dirname(override) } : {}) };
  }
  if (fs.existsSync(LOCAL_AKM_BIN)) {
    return resolveFileRuntime(LOCAL_AKM_BIN);
  }
  return { command: ["akm"], binPath: "akm" };
}

export function resolveAkmCommand(): string[] {
  return resolveAkmRuntime().command;
}
