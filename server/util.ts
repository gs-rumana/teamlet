import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

export const newId = (prefix: string) => `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;

/** Resolve an executable on PATH (plus common install locations GUI-launched apps miss). */
export function which(command: string): string | undefined {
  const home = process.env.HOME ?? "";
  const dirs = [
    ...(process.env.PATH ?? "").split(delimiter),
    join(home, ".local/bin"),
    join(home, ".npm-global/bin"),
    join(home, ".bun/bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
  for (const dir of dirs) {
    if (!dir) continue;
    const candidate = join(dir, command);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  return undefined;
}

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export function run(command: string, args: string[], { timeoutMs = 15_000, env = childEnv() } = {}): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: timeoutMs, env }, (error, stdout, stderr) => {
      const code = error && typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : error ? 1 : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

/** Variables to set for a child process; `undefined` removes one. */
export type EnvOverrides = Record<string, string | undefined>;

/**
 * Environment for spawned agent CLIs. Drops markers set when this server is
 * itself launched from inside a Claude Code session, which would otherwise
 * make the child think it is nested.
 */
export function childEnv(overrides: EnvOverrides = {}): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  delete env.CLAUDE_CODE_SSE_PORT;
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[name];
    else env[name] = value;
  }
  return env;
}

/**
 * Where a CLI keeps its settings and sign-in, one folder per account: `variable`
 * (CLAUDE_CONFIG_DIR, CODEX_HOME) if the server was started with it, else `fallback`.
 */
export function configFolder(variable: string, fallback: string) {
  const defaultDir = () => {
    const value = process.env[variable];
    return value ? resolve(expandHome(value)) : fallback;
  };
  return {
    defaultDir,
    /**
     * Env that points the CLI at `dir`. The default needs nothing, and `fallback` is
     * reached by unsetting the variable, the way the CLI runs on its own.
     */
    env(dir = defaultDir()): EnvOverrides {
      if (dir === defaultDir()) return {};
      return { [variable]: dir === fallback ? undefined : dir };
    },
  };
}

const shellQuote = (part: string) => (/^[\w@%+=:,./-]+$/.test(part) ? part : `'${part.replaceAll("'", "'\\''")}'`);

/** A command line to paste into a shell, e.g. `CLAUDE_CONFIG_DIR=/x claude auth login`. */
export function shellCommand(argv: string[], env: EnvOverrides = {}): string {
  const unset = Object.keys(env).filter((name) => env[name] === undefined);
  const set = Object.entries(env).flatMap(([name, value]) => (value === undefined ? [] : [`${name}=${shellQuote(value)}`]));
  return [...(unset.length ? ["env", ...unset.flatMap((name) => ["-u", name])] : []), ...set, ...argv.map(shellQuote)].join(" ");
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n… [truncated ${text.length - max} chars]`;
}

export function stringifyInput(input: unknown): string {
  if (typeof input === "string") return input;
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

export function expandHome(path: string): string {
  if (path === "~") return homedir();
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path && resolve(path);
}

export function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms / 1000}s`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}
