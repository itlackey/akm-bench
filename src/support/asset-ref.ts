import path from "node:path";

export interface AssetRef {
  type: string;
  name: string;
  origin?: string;
}

export function parseAssetRef(ref: string): AssetRef {
  const trimmed = ref.trim();
  if (!trimmed) throw new Error("Empty ref.");

  let origin: string | undefined;
  let body = trimmed;

  const boundary = trimmed.indexOf("//");
  if (boundary >= 0) {
    origin = trimmed.slice(0, boundary);
    body = trimmed.slice(boundary + 2);
    if (!origin) throw new Error("Empty origin in ref.");
  }

  const colon = body.indexOf(":");
  if (colon <= 0) throw new Error(`Invalid ref "${trimmed}".`);

  const type = body.slice(0, colon);
  const rawName = body.slice(colon + 1);
  if (!rawName) throw new Error("Empty asset name.");

  const normalized = path.posix.normalize(rawName.replace(/\\/g, "/"));
  if (path.posix.isAbsolute(normalized) || normalized === ".." || normalized.startsWith("../")) {
    throw new Error("Path traversal in asset name.");
  }

  return { type, name: normalized, origin: origin || undefined };
}
