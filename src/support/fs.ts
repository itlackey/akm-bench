import fs from "node:fs";
import path from "node:path";

export function getCacheDir(): string {
  const override = process.env.AKM_CACHE_DIR?.trim();
  if (override) return override;
  const xdg = process.env.XDG_CACHE_HOME?.trim();
  if (xdg) return path.join(xdg, "akm");
  const home = process.env.HOME?.trim();
  return home ? path.join(home, ".cache", "akm") : path.join("/tmp", "akm-cache");
}

export function safeRealpath(p: string): string {
  const resolved = path.resolve(p);
  try {
    return fs.realpathSync(resolved);
  } catch {
    const suffix: string[] = [];
    let current = resolved;
    for (;;) {
      const parent = path.dirname(current);
      if (parent === current) return resolved;
      suffix.unshift(path.basename(current));
      current = parent;
      try {
        const realParent = fs.realpathSync(current);
        return path.join(realParent, ...suffix);
      } catch {
        // keep walking up
      }
    }
  }
}
