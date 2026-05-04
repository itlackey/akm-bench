import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "..");
const LOCAL_AKM_BIN = path.join(REPO_ROOT, "node_modules", ".bin", process.platform === "win32" ? "akm.cmd" : "akm");

export function resolveAkmCommand(): string[] {
  const override = process.env.AKM_BENCH_AKM_BIN?.trim();
  if (override) return [override];
  if (fs.existsSync(LOCAL_AKM_BIN)) return [LOCAL_AKM_BIN];
  return ["akm"];
}
