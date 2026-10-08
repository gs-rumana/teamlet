import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { LoginState, ProviderId, ServerEvent } from "../shared/protocol.ts";
import type { ProviderAdapter } from "./providers/types.ts";
import { config } from "./config.ts";
import { childEnv, shellCommand } from "./util.ts";

const URL_PATTERN = /https?:\/\/[^\s"'<>]+/g;
const DEVICE_CODE_PATTERN = /\b[A-Z0-9]{4}-[A-Z0-9]{4,6}\b/;
/** The person signing in is on another machine whenever the server isn't local-only. */
export const canOpenTerminal = config.localOnly && process.platform === "darwin";
const headless = !config.localOnly;
// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g;
/** Sign-ins are per account: a provider plus, for Claude, a config folder. */
const accountKey = (providerId: ProviderId, configDir?: string) => `${providerId}:${configDir ?? ""}`;

/**
 * Runs a provider's own sign-in command (e.g. `claude auth login`, `codex login`)
 * and streams its output to the UI. The CLI opens the browser OAuth flow for the
 * user's subscription and stores the credentials itself; this app never sees them.
 */
export class LoginManager {
  private states = new Map<string, LoginState>();
  private children = new Map<string, ChildProcessWithoutNullStreams>();

  private providers: Record<ProviderId, ProviderAdapter>;
  private broadcast: (event: ServerEvent) => void;
  private onFinished: () => void;

  constructor(providers: Record<ProviderId, ProviderAdapter>, broadcast: (event: ServerEvent) => void, onFinished: () => void) {
    this.providers = providers;
    this.broadcast = broadcast;
    this.onFinished = onFinished;
  }

  list(): LoginState[] {
    return [...this.states.values()];
  }

  start(providerId: ProviderId, configDir?: string) {
    const login = this.providers[providerId]?.loginArgs({ headless, configDir });
    if (!login) throw new Error(`${providerId} CLI is not installed`);
    const key = accountKey(providerId, configDir);
    this.cancel(providerId, configDir);

    const state: LoginState = { provider: providerId, configDir, running: true, output: "", urls: [] };
    this.states.set(key, state);
    const child = spawn(login.command, login.args, { env: childEnv(login.env), stdio: "pipe" });
    this.children.set(key, child);

    const append = (chunk: Buffer) => {
      const text = chunk.toString().replace(ANSI_PATTERN, "");
      state.output = (state.output + text).slice(-8000);
      for (const url of text.match(URL_PATTERN) ?? []) if (!state.urls.includes(url)) state.urls.push(url);
      state.code ??= state.output.match(DEVICE_CODE_PATTERN)?.[0];
      this.broadcast({ type: "login", login: { ...state } });
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("error", (error) => append(Buffer.from(`\n${error.message}\n`)));
    child.on("close", (code) => {
      if (this.children.get(key) === child) this.children.delete(key);
      state.running = false;
      state.exitCode = code;
      this.broadcast({ type: "login", login: { ...state } });
      this.onFinished();
    });
    this.broadcast({ type: "login", login: { ...state } });
  }

  /** Some flows ask the user to paste a code back into the terminal. */
  sendInput(providerId: ProviderId, text: string, configDir?: string) {
    const child = this.children.get(accountKey(providerId, configDir));
    if (!child) throw new Error("No sign-in in progress");
    child.stdin.write(`${text.trim()}\n`);
  }

  cancel(providerId: ProviderId, configDir?: string) {
    const key = accountKey(providerId, configDir);
    this.children.get(key)?.kill("SIGTERM");
    this.children.delete(key);
  }

  /** macOS fallback: run the sign-in command in a real Terminal window. */
  openInTerminal(providerId: ProviderId, configDir?: string) {
    if (!canOpenTerminal) throw new Error("Opening a terminal only works when Teamlet runs locally on macOS. Run the command shown instead.");
    const login = this.providers[providerId]?.loginArgs({ headless: false, configDir });
    if (!login) throw new Error(`${providerId} CLI is not installed`);
    const command = shellCommand([login.command, ...login.args], login.env);
    const script = `tell application "Terminal" to do script ${JSON.stringify(command)}\ntell application "Terminal" to activate`;
    spawn("osascript", ["-e", script], { stdio: "ignore", detached: true }).unref();
  }
}
