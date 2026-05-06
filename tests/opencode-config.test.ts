/**
 * Tests for the standard opencode-config loader used by the bench.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import {
  BenchConfigError,
  collectEnvRefs,
  loadOpencodeConfig,
  materializeOpencodeConfig,
  selectProviderForModel,
} from "../src/opencode-config";
import { benchMkdtemp } from "../src/tmp";

const FIXTURE_PATH = path.resolve(__dirname, "..", "config", "opencode.json");

function writeTmp(dir: string, name: string, content: unknown): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, JSON.stringify(content));
  return p;
}

describe("loadOpencodeConfig", () => {
  let tmp: string;

  beforeAll(() => {
    tmp = benchMkdtemp("bench-opencode-config-test-");
  });

  afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("loads the canonical committed fixture without error", () => {
    expect(() => loadOpencodeConfig(FIXTURE_PATH)).not.toThrow();
    const loaded = loadOpencodeConfig(FIXTURE_PATH);
    expect(loaded.source).toBe(FIXTURE_PATH);
    expect(loaded.provider).toBeDefined();
    expect(typeof loaded.provider).toBe("object");
    expect(loaded.model).toBe("local/qwen/qwen3.5-9b");
    expect("local" in loaded.provider).toBe(true);
  });

  test("throws BenchConfigError with isUsageError: true when file does not exist", () => {
    const missing = path.join(tmp, "does-not-exist.json");
    let err: unknown;
    try {
      loadOpencodeConfig(missing);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(BenchConfigError);
    expect((err as BenchConfigError).isUsageError).toBe(true);
  });

  test("throws BenchConfigError with isUsageError: false on malformed JSON", () => {
    const p = path.join(tmp, "bad.json");
    fs.writeFileSync(p, "{ this is not json }");
    let err: unknown;
    try {
      loadOpencodeConfig(p);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(BenchConfigError);
    expect((err as BenchConfigError).isUsageError).toBe(false);
    expect((err as BenchConfigError).message).toContain("JSON parse error");
  });

  test("rejects unsupported $schema values", () => {
    const p = writeTmp(tmp, "bad-schema.json", {
      $schema: "https://example.com/not-opencode.json",
      provider: {},
    });
    expect(() => loadOpencodeConfig(p)).toThrow(BenchConfigError);
  });

  test("rejects top-level plugin key", () => {
    const p = writeTmp(tmp, "has-plugin.json", {
      provider: {},
      plugin: [],
    });
    expect(() => loadOpencodeConfig(p)).toThrow(/plugin/);
  });

  test("rejects top-level permission key", () => {
    const p = writeTmp(tmp, "has-permission.json", {
      provider: {},
      permission: {},
    });
    expect(() => loadOpencodeConfig(p)).toThrow(/permission/);
  });

  test("rejects literal apiKey string", () => {
    const p = writeTmp(tmp, "literal-apikey.json", {
      provider: {
        myProvider: {
          apiKey: "not-an-env-ref",
        },
      },
    });
    expect(() => loadOpencodeConfig(p)).toThrow(/apiKey/);
  });

  test("accepts {env:VAR} form for apiKey", () => {
    const p = writeTmp(tmp, "env-ref-apikey.json", {
      provider: {
        myProvider: {
          npm: "@ai-sdk/openai-compatible",
          apiKey: "{env:MY_API_KEY}",
          options: { baseURL: "http://localhost:1234/v1" },
        },
      },
    });
    const loaded = loadOpencodeConfig(p);
    expect("myProvider" in loaded.provider).toBe(true);
  });

  test("rejects sk-style credentials anywhere in the provider tree", () => {
    const p = writeTmp(tmp, "has-sk-key.json", {
      provider: {
        openai: {
          npm: "@ai-sdk/openai",
          secret: "sk-abcdefghijklmnopqrstuvwxyz0123456789",
        },
      },
    });
    expect(() => loadOpencodeConfig(p)).toThrow(/credential heuristic/);
  });

  test("accepts a valid minimal file with no model", () => {
    const p = writeTmp(tmp, "minimal.json", {
      provider: {
        local: {
          npm: "@ai-sdk/openai-compatible",
          options: { baseURL: "http://localhost:1234/v1" },
        },
      },
    });
    const loaded = loadOpencodeConfig(p);
    expect(loaded.model).toBeUndefined();
    expect("local" in loaded.provider).toBe(true);
  });
});

describe("selectProviderForModel", () => {
  const loaded = {
    source: "/fake/path.json",
    provider: {
      don: { npm: "@ai-sdk/openai-compatible", name: "Don LM Studio" },
      ollama: { npm: "@ai-sdk/openai-compatible", name: "Ollama" },
    },
    model: "don/mlx-community/qwen3.6-35b-a3b",
  };

  test("splits on first slash and returns the correct provider entry", () => {
    const result = selectProviderForModel(loaded, "don/mlx-community/qwen3.6-35b-a3b");
    expect(result.providerKey).toBe("don");
    expect(result.entry).toBe(loaded.provider.don);
  });

  test("handles a model with no slash", () => {
    const result = selectProviderForModel(loaded, "ollama");
    expect(result.providerKey).toBe("ollama");
    expect(result.entry).toBe(loaded.provider.ollama);
  });

  test("throws when provider key is missing", () => {
    expect(() => selectProviderForModel(loaded, "unknown/some-model")).toThrow(/provider key/);
  });
});

describe("collectEnvRefs", () => {
  test("collects unique env refs from nested provider entries", () => {
    expect(
      collectEnvRefs({
        apiKey: "{env:OPENAI_API_KEY}",
        nested: [{ token: "{env:AG_TOKEN}" }, { token: "{env:OPENAI_API_KEY}" }],
      }),
    ).toEqual(["AG_TOKEN", "OPENAI_API_KEY"]);
  });

  test("ignores non-env strings", () => {
    expect(collectEnvRefs({ apiKey: "not-an-env-ref", baseURL: "http://localhost:1234/v1" })).toEqual([]);
  });
});

describe("materializeOpencodeConfig", () => {
  let tmp: string;

  beforeAll(() => {
    tmp = benchMkdtemp("bench-materialize-test-");
  });

  afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("writes opencode.json with required bench isolation invariants and provider", () => {
    const configDir = path.join(tmp, "run-config");
    fs.mkdirSync(configDir, { recursive: true });

    const entry = { npm: "@ai-sdk/openai-compatible", name: "Test Provider" };
    materializeOpencodeConfig(configDir, { providerKey: "test", entry }, "test/my-model");

    const outPath = path.join(configDir, "opencode.json");
    const contents = JSON.parse(fs.readFileSync(outPath, "utf8")) as Record<string, unknown>;
    expect(contents.model).toBe("test/my-model");
    expect(contents.$schema).toBe("https://opencode.ai/config.json");
    expect(contents.plugin).toEqual([]);
    expect((contents.permission as Record<string, unknown>)?.bash).toBe("allow");
    const provider = contents.provider as Record<string, unknown>;
    expect(Object.keys(provider)).toEqual(["test"]);
    expect(provider.test).toEqual(entry);
  });

  test("writes the file with mode 0o600", () => {
    const configDir = path.join(tmp, "run-config-2");
    fs.mkdirSync(configDir, { recursive: true });
    materializeOpencodeConfig(configDir, { providerKey: "p", entry: {} }, "p/model");
    const stat = fs.statSync(path.join(configDir, "opencode.json"));
    expect(stat.mode & 0o777).toBe(0o600);
  });
});
