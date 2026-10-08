import { execFile, spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

const WINDOWS = process.platform === "win32";

export const newId = (prefix: string) => `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;

/**
 * Resolve an executable on PATH (plus common install locations GUI-launched apps miss).
 * On Windows this returns the file behind an npm .cmd shim; start it with `launch()`.
 */
export function which(command: string): string | undefined {
  const home = homedir();
  const dirs = [
    ...(process.env.PATH ?? "").split(delimiter),
    join(home, ".local", "bin"),
    join(home, ".bun", "bin"),
    ...(WINDOWS
      ? [process.env.APPDATA ? join(process.env.APPDATA, "npm") : ""]
      : [join(home, ".npm-global/bin"), "/opt/homebrew/bin", "/usr/local/bin"]),
  ];
  // Windows finds programs by extension (claude.exe, codex.cmd); elsewhere by the executable bit.
  const extensions = WINDOWS ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean) : [""];
  for (const dir of dirs) {
    if (!dir) continue;
    for (const extension of extensions) {
      const candidate = join(dir, command + extension);
      try {
        accessSync(candidate, constants.X_OK);
        if (statSync(candidate).isFile()) return resolveShim(candidate);
      } catch {}
    }
  }
  return undefined;
}

/**
 * npm installs CLIs on Windows as .cmd shims. Node can only start those through cmd.exe, which
 * can't pass arguments containing newlines (agent instructions do), so use the shim's target.
 */
function resolveShim(path: string): string {
  if (!WINDOWS || !/\.(cmd|bat)$/i.test(path)) return path;
  try {
    const target = shimTarget(readFileSync(path, "utf8"));
    if (target) return join(dirname(path), target);
  } catch {}
  return path;
}

/** The file an npm .cmd shim runs, relative to the shim: `"%dp0%\node_modules\…\cli.js" %*`. */
export function shimTarget(script: string): string | undefined {
  return script.match(/"%~?dp0%?\\([^"]+)"\s+%\*/)?.[1];
}

/** The command and arguments that start a CLI found by `which()`: JavaScript entry points run with node. */
export function launch(path: string, args: string[]): [command: string, args: string[]] {
  return /\.[cm]?js$/i.test(path) ? [which("node") ?? "node", [path, ...args]] : [path, args];
}

/**
 * Stop a CLI and everything it started. On Windows, killing the child alone would leave its
 * own children running (node → codex.exe).
 */
export function stopProcess(child: ChildProcess) {
  if (WINDOWS && child.pid) spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  else child.kill("SIGTERM");
}

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export function run(command: string, args: string[], { timeoutMs = 15_000, env = childEnv() } = {}): Promise<ExecResult> {
  const [file, argv] = launch(command, args);
  return new Promise((resolve) => {
    execFile(file, argv, { timeout: timeoutMs, env, windowsHide: true }, (error, stdout, stderr) => {
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
const powerShellQuote = (part: string) => `'${part.replaceAll("'", "''")}'`;

/**
 * A command line to paste into a terminal, e.g. `CLAUDE_CONFIG_DIR=/x claude auth login`, or the
 * PowerShell equivalent on Windows.
 */
export function shellCommand(argv: string[], env: EnvOverrides = {}, platform = process.platform): string {
  if (platform === "win32") {
    const settings = Object.entries(env).map(([name, value]) =>
      value === undefined ? `Remove-Item Env:${name} -ErrorAction Ignore` : `$env:${name} = ${powerShellQuote(value)}`,
    );
    const command = argv.map((part) => (/^[\w@%+=:,./\\-]+$/.test(part) ? part : powerShellQuote(part))).join(" ");
    return [...settings, command].join("; ");
  }
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
  return /^~[\\/]/.test(path) ? join(homedir(), path.slice(2)) : path && resolve(path);
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
