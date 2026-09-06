import path from "node:path";

/** Parsed AKM 0.9 item ref: `[bundle//]conceptId[#fragment]`. */
export interface AssetRef {
  conceptId: string;
  bundle?: string;
  fragment?: string;
}

const BUNDLE_SLUG_RE = /^[^\s:.#/]+$/;

/**
 * Parse the public AKM 0.9 ref grammar without depending on an installed AKM
 * package. Keep this small copy aligned with `parseBundleRef` in akm itself:
 * refs are path identities, while the pre-0.9 `<type>:<name>` spelling is not
 * accepted.
 */
export function parseAssetRef(ref: string): AssetRef {
  const trimmed = ref.trim();
  if (!trimmed) throw new Error("Empty ref.");
  if (trimmed.includes("\0")) throw new Error("Null byte in ref.");

  let bundle: string | undefined;
  let body = trimmed;
  const boundary = trimmed.indexOf("//");
  if (boundary >= 0) {
    bundle = trimmed.slice(0, boundary);
    body = trimmed.slice(boundary + 2);
    if (!bundle) throw new Error("Empty bundle in ref.");
    if (!BUNDLE_SLUG_RE.test(bundle)) throw new Error(`Invalid bundle slug "${bundle}".`);
  }

  let fragment: string | undefined;
  const hash = body.indexOf("#");
  if (hash >= 0) {
    fragment = body.slice(hash + 1) || undefined;
    body = body.slice(0, hash);
  }
  if (!body) throw new Error(`Invalid ref "${trimmed}".`);
  // Colons identify source/install locators and the retired typed-ref grammar,
  // neither of which is an item ref.
  if (body.includes(":")) throw new Error(`Invalid concept id in ref "${trimmed}".`);
  if (/^[A-Za-z]:/.test(body)) throw new Error("Windows drive path in concept id.");

  const nfc = body.normalize("NFC");
  const slashBody = nfc.replace(/\\/g, "/");
  if (slashBody.split("/").some((segment) => segment === "." || segment === "..")) {
    throw new Error("Concept id cannot contain relative path segments.");
  }
  const conceptId = path.posix.normalize(slashBody);
  if (path.posix.isAbsolute(conceptId) || conceptId === ".." || conceptId.startsWith("../")) {
    throw new Error("Path traversal in concept id.");
  }

  return {
    conceptId,
    ...(bundle ? { bundle } : {}),
    ...(fragment ? { fragment } : {}),
  };
}
