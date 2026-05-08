import { describe, expect, test } from "bun:test";
import {
  computeFixtureIndexFingerprint,
  type FixtureIndexRuntimeFingerprint,
} from "../src/fixture-index-cache";

function runtime(overrides: Partial<FixtureIndexRuntimeFingerprint> = {}): FixtureIndexRuntimeFingerprint {
  return {
    akmBinPath: "/usr/bin/akm",
    akmVersion: "akm-cli 0.7.0",
    bunVersion: "1.2.0",
    platform: "linux",
    arch: "x64",
    ...overrides,
  };
}

describe("fixture index cache fingerprint", () => {
  test("is deterministic for identical inputs", () => {
    const a = computeFixtureIndexFingerprint({
      fixtureContentHash: "a".repeat(64),
      runtime: runtime(),
    });
    const b = computeFixtureIndexFingerprint({
      fixtureContentHash: "a".repeat(64),
      runtime: runtime(),
    });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  test("changes when fixture content hash changes", () => {
    const a = computeFixtureIndexFingerprint({
      fixtureContentHash: "a".repeat(64),
      runtime: runtime(),
    });
    const b = computeFixtureIndexFingerprint({
      fixtureContentHash: "b".repeat(64),
      runtime: runtime(),
    });
    expect(a).not.toBe(b);
  });

  test("changes when AKM runtime identity changes", () => {
    const a = computeFixtureIndexFingerprint({
      fixtureContentHash: "a".repeat(64),
      runtime: runtime({ akmVersion: "akm-cli 0.7.0" }),
    });
    const b = computeFixtureIndexFingerprint({
      fixtureContentHash: "a".repeat(64),
      runtime: runtime({ akmVersion: "akm-cli 0.8.0" }),
    });
    expect(a).not.toBe(b);
  });

  test("changes across Bun version and platform/arch", () => {
    const base = computeFixtureIndexFingerprint({
      fixtureContentHash: "a".repeat(64),
      runtime: runtime(),
    });
    const bunChanged = computeFixtureIndexFingerprint({
      fixtureContentHash: "a".repeat(64),
      runtime: runtime({ bunVersion: "1.3.0" }),
    });
    const platformChanged = computeFixtureIndexFingerprint({
      fixtureContentHash: "a".repeat(64),
      runtime: runtime({ platform: "darwin", arch: "arm64" }),
    });
    expect(base).not.toBe(bunChanged);
    expect(base).not.toBe(platformChanged);
  });
});
