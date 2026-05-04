/** Minimal agent profile/spawn support for the benchmark harness. */
export type AgentStdioMode = "captured" | "interactive";
export type AgentParseMode = "text" | "json";

export interface AgentProfile {
  readonly name: string;
  readonly bin: string;
  readonly args: readonly string[];
  readonly stdio: AgentStdioMode;
  readonly env?: Readonly<Record<string, string>>;
  readonly envPassthrough: readonly string[];
  readonly timeoutMs?: number;
  readonly parseOutput: AgentParseMode;
}

const COMMON_PASSTHROUGH = ["HOME", "PATH", "USER", "LANG", "LC_ALL", "TERM", "TMPDIR"] as const;

const BUILTINS: Record<string, AgentProfile> = {
  opencode: {
    name: "opencode",
    bin: "opencode",
    args: ["run"],
    stdio: "interactive",
    envPassthrough: [...COMMON_PASSTHROUGH, "OPENCODE_API_KEY", "OPENCODE_CONFIG"],
    parseOutput: "text",
  },
  claude: {
    name: "claude",
    bin: "claude",
    args: [],
    stdio: "interactive",
    envPassthrough: [...COMMON_PASSTHROUGH],
    parseOutput: "text",
  },
  codex: {
    name: "codex",
    bin: "codex",
    args: [],
    stdio: "interactive",
    envPassthrough: [...COMMON_PASSTHROUGH],
    parseOutput: "text",
  },
  gemini: {
    name: "gemini",
    bin: "gemini",
    args: [],
    stdio: "interactive",
    envPassthrough: [...COMMON_PASSTHROUGH],
    parseOutput: "text",
  },
  aider: {
    name: "aider",
    bin: "aider",
    args: ["--no-auto-commits"],
    stdio: "interactive",
    envPassthrough: [...COMMON_PASSTHROUGH],
    parseOutput: "text",
  },
};

export const BUILTIN_AGENT_PROFILE_NAMES: readonly string[] = Object.freeze(Object.keys(BUILTINS).sort());

export function getBuiltinAgentProfile(name: string): AgentProfile | undefined {
  return BUILTINS[name];
}

export interface SpawnedSubprocess {
  exitCode: number | null;
  exited: Promise<number>;
  stdout?: ReadableStream<Uint8Array> | null;
  stderr?: ReadableStream<Uint8Array> | null;
  stdin?: WritableStream<Uint8Array> | null;
  pid?: number;
  kill(signal?: number | string): void;
}

export type SpawnFn = (
  cmd: string[],
  options: {
    stdin?: "inherit" | "pipe" | "ignore";
    stdout?: "inherit" | "pipe" | "ignore";
    stderr?: "inherit" | "pipe" | "ignore";
    env?: Record<string, string>;
    cwd?: string;
    detached?: boolean;
  },
) => SpawnedSubprocess;

export interface RunAgentOptions {
  stdio?: AgentStdioMode;
  timeoutMs?: number;
  parseOutput?: AgentParseMode;
  env?: Record<string, string>;
  cwd?: string;
  args?: readonly string[];
  stdin?: string;
  envSource?: NodeJS.ProcessEnv;
  spawn?: SpawnFn;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}

export interface AgentRunResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  parsed?: unknown;
  reason?: "timeout" | "spawn_failed" | "non_zero_exit" | "parse_error";
  error?: string;
}

const DEFAULT_TIMEOUT_MS = 60_000;

function killGroup(proc: SpawnedSubprocess, signal: "SIGTERM" | "SIGKILL"): void {
  try {
    if (typeof proc.pid === "number") {
      process.kill(-proc.pid, signal);
      return;
    }
  } catch {
    // fall through
  }
  try {
    proc.kill(signal);
  } catch {
    // ignore
  }
}

async function readStream(stream: ReadableStream<Uint8Array> | null | undefined): Promise<string> {
  if (!stream) return "";
  return new Response(stream).text().catch(() => "");
}

function buildChildEnv(profile: AgentProfile, options: RunAgentOptions): Record<string, string> {
  const source = options.envSource ?? process.env;
  const env: Record<string, string> = {};
  for (const name of profile.envPassthrough) {
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  if (profile.env) Object.assign(env, profile.env);
  if (options.env) Object.assign(env, options.env);
  return env;
}

function resolveSpawnFn(options: RunAgentOptions): SpawnFn {
  if (options.spawn) return options.spawn;
  const bun = (globalThis as { Bun?: { spawn: SpawnFn } }).Bun;
  if (!bun?.spawn) throw new Error("Bun.spawn is unavailable; pass options.spawn for non-Bun environments.");
  return bun.spawn.bind(bun);
}

export async function runAgent(
  profile: AgentProfile,
  prompt: string | undefined,
  options: RunAgentOptions = {},
): Promise<AgentRunResult> {
  const stdioMode = options.stdio ?? profile.stdio;
  const timeoutMs = options.timeoutMs ?? profile.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const parseOutput = options.parseOutput ?? profile.parseOutput;
  const setTimeoutImpl = options.setTimeoutFn ?? setTimeout;
  const clearTimeoutImpl = options.clearTimeoutFn ?? clearTimeout;
  const args = [...profile.args, ...(options.args ?? [])];
  if (prompt !== undefined) args.push(prompt);
  const env = buildChildEnv(profile, options);
  const start = Date.now();

  let proc: SpawnedSubprocess;
  try {
    proc = resolveSpawnFn(options)([profile.bin, ...args], {
      stdin: stdioMode === "captured" ? (options.stdin !== undefined ? "pipe" : "ignore") : "inherit",
      stdout: stdioMode === "captured" ? "pipe" : "inherit",
      stderr: stdioMode === "captured" ? "pipe" : "inherit",
      env,
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(stdioMode === "captured" ? { detached: true } : {}),
    });
  } catch (err) {
    return {
      ok: false,
      exitCode: null,
      stdout: "",
      stderr: "",
      durationMs: Date.now() - start,
      reason: "spawn_failed",
      error: err instanceof Error ? err.message : String(err),
    };
  }

  let timedOut = false;
  const timer = setTimeoutImpl(() => {
    if (proc.exitCode !== null) return;
    timedOut = true;
    killGroup(proc, "SIGTERM");
    setTimeoutImpl(() => {
      if (proc.exitCode === null) killGroup(proc, "SIGKILL");
    }, 5000);
  }, timeoutMs);

  const stdoutPromise = stdioMode === "captured" ? readStream(proc.stdout ?? null) : Promise.resolve("");
  const stderrPromise = stdioMode === "captured" ? readStream(proc.stderr ?? null) : Promise.resolve("");

  if (options.stdin !== undefined && stdioMode === "captured" && proc.stdin) {
    try {
      const writer = proc.stdin.getWriter();
      await writer.write(new TextEncoder().encode(options.stdin));
      await writer.close();
    } catch {
      // ignore
    }
  }

  let exitCode: number | null = null;
  try {
    exitCode = await proc.exited;
  } catch (err) {
    clearTimeoutImpl(timer);
    await Promise.allSettled([stdoutPromise, stderrPromise]);
    return {
      ok: false,
      exitCode: null,
      stdout: "",
      stderr: "",
      durationMs: Date.now() - start,
      reason: "spawn_failed",
      error: err instanceof Error ? err.message : String(err),
    };
  }
  clearTimeoutImpl(timer);

  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
  const durationMs = Date.now() - start;
  if (timedOut)
    return {
      ok: false,
      exitCode,
      stdout,
      stderr,
      durationMs,
      reason: "timeout",
      error: `agent CLI "${profile.name}" timed out after ${timeoutMs}ms`,
    };
  if (exitCode !== 0)
    return {
      ok: false,
      exitCode,
      stdout,
      stderr,
      durationMs,
      reason: "non_zero_exit",
      error: `agent CLI "${profile.name}" exited with code ${exitCode}`,
    };
  if (parseOutput === "json" && stdioMode === "captured") {
    try {
      return { ok: true, exitCode, stdout, stderr, durationMs, parsed: JSON.parse(stdout) };
    } catch (err) {
      return {
        ok: false,
        exitCode,
        stdout,
        stderr,
        durationMs,
        reason: "parse_error",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
  return { ok: true, exitCode, stdout, stderr, durationMs };
}
