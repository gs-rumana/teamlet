import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { ModelOption, ProviderStatus } from "../../shared/protocol.ts";
import { childEnv, configFolder, run, shellCommand, which, withTimeout } from "../util.ts";
import type { ProviderAdapter, RunInput, RunResult } from "./types.ts";

const CONFIG = configFolder("CODEX_HOME", join(homedir(), ".codex"));

interface CodexItem {
  id: string;
  type: string;
  text?: string;
  command?: string;
  aggregated_output?: string;
  exit_code?: number | null;
  status?: string;
  changes?: { path: string; kind: string }[];
  server?: string;
  tool?: string;
  arguments?: unknown;
  result?: unknown;
  error?: { message?: string } | string;
  query?: string;
  message?: string;
}

interface CodexEvent {
  type: string;
  thread_id?: string;
  item?: CodexItem;
  error?: { message?: string };
  message?: string;
}

/**
 * Drives the user's own Codex CLI (`codex exec --json`). Auth is whatever
 * `codex login` set up — "Sign in with ChatGPT" uses a ChatGPT Plus/Pro/Team plan.
 * Each CODEX_HOME folder is a separate account with its own sign-in.
 */
export class CodexProvider implements ProviderAdapter {
  readonly id = "codex" as const;

  defaultConfigDir(): string {
    return CONFIG.defaultDir();
  }

  async status(configDir = this.defaultConfigDir()): Promise<ProviderStatus> {
    const binaryPath = which("codex");
    const overrides = CONFIG.env(configDir);
    const base: ProviderStatus = {
      id: "codex",
      name: "Codex",
      subscription: "ChatGPT Plus / Pro / Team",
      installed: Boolean(binaryPath),
      binaryPath,
      loggedIn: false,
      installHint: "npm install -g @openai/codex",
      loginCommand: shellCommand(["codex", "login"], overrides),
      models: [{ id: "", label: "Default", description: "The model set in your Codex config" }],
      modelsDiscovered: false,
      configDir,
      isDefaultConfigDir: configDir === this.defaultConfigDir(),
    };
    if (!binaryPath) return { ...base, detail: "Codex CLI not found on PATH" };

    const env = childEnv(overrides);
    const [version, login] = await Promise.all([run(binaryPath, ["--version"]), run(binaryPath, ["login", "status"], { env })]);
    base.version = version.stdout.trim().split(" ").pop();
    const text = `${login.stdout}\n${login.stderr}`.trim();
    const loggedIn = login.code === 0 && /logged in/i.test(text);
    const discovered = loggedIn
      ? await withTimeout(listCodexModels(binaryPath, env), 20_000, "Listing Codex models").catch((error: unknown) => {
          console.warn("Could not list Codex models:", error instanceof Error ? error.message : error);
          return null;
        })
      : null;
    return {
      ...base,
      ...(discovered ? { models: [base.models[0], ...discovered], modelsDiscovered: true } : {}),
      loggedIn,
      plan: /chatgpt/i.test(text) ? "ChatGPT" : /api key/i.test(text) ? "API key" : undefined,
      detail: loggedIn && /api key/i.test(text) ? "Signed in with an API key (not a subscription)" : loggedIn ? undefined : text.split("\n")[0],
    };
  }

  loginArgs({ headless, configDir }: { headless: boolean; configDir?: string }) {
    const binary = which("codex");
    // The default flow redirects to a localhost callback; device codes work from any browser.
    return binary ? { command: binary, args: headless ? ["login", "--device-auth"] : ["login"], env: CONFIG.env(configDir) } : null;
  }

  async run(input: RunInput): Promise<RunResult> {
    const binary = which("codex");
    if (!binary) {
      input.emit({ type: "error", text: "Codex CLI is not installed." });
      return { finalText: "Codex CLI is not installed.", isError: true };
    }

    const args = ["exec", "--json", "--skip-git-repo-check"];
    if (input.model) args.push("--model", input.model);
    if (input.permission === "full-access") args.push("--dangerously-bypass-approvals-and-sandbox");
    else args.push("--sandbox", input.permission);
    if (input.mcp) {
      args.push("-c", `mcp_servers.${input.mcp.name}.url=${JSON.stringify(input.mcp.url)}`);
      args.push("-c", `mcp_servers.${input.mcp.name}.tool_timeout_sec=900`);
    }
    // `codex exec` has no system-prompt flag, so instructions ride along with the first turn.
    let prompt = input.resumeId ? input.prompt : `${input.instructions}\n\n---\n\n${input.prompt}`;
    if (prompt.startsWith("-")) prompt = ` ${prompt}`;
    if (input.resumeId) args.push("resume", input.resumeId, prompt);
    else args.push(prompt);

    const child = spawn(binary, args, { cwd: input.cwd, env: childEnv(CONFIG.env(input.configDir)), stdio: ["ignore", "pipe", "pipe"] });
    const onAbort = () => child.kill("SIGTERM");
    input.signal.addEventListener("abort", onAbort, { once: true });

    let finalText = "";
    let isError = false;
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-4000);
    });

    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      let event: CodexEvent;
      try {
        event = JSON.parse(line) as CodexEvent;
      } catch {
        return;
      }
      switch (event.type) {
        case "thread.started":
          if (event.thread_id) input.emit({ type: "provider-session", id: event.thread_id });
          break;
        case "item.started":
          if (event.item) startItem(event.item, input);
          break;
        case "item.completed":
          if (!event.item) break;
          if (event.item.type === "agent_message" && event.item.text) {
            finalText = event.item.text;
            input.emit({ type: "text-delta", itemId: event.item.id, delta: event.item.text });
          } else {
            finishItem(event.item, input);
          }
          break;
        case "turn.failed":
        case "error": {
          isError = true;
          const text = event.error?.message ?? event.message ?? "Codex run failed";
          input.emit({ type: "error", text });
          if (!finalText) finalText = text;
          break;
        }
      }
    });

    const exitCode = await new Promise<number | null>((resolve) => {
      child.on("close", (code) => resolve(code));
      child.on("error", (error) => {
        input.emit({ type: "error", text: error.message });
        resolve(1);
      });
    });
    input.signal.removeEventListener("abort", onAbort);

    if (exitCode !== 0 && !input.signal.aborted && !isError) {
      isError = true;
      const text = stderr.trim() || `codex exited with code ${exitCode}`;
      input.emit({ type: "error", text });
      if (!finalText) finalText = text;
    }
    return { finalText, isError: isError || input.signal.aborted };
  }
}

interface CodexModel {
  model: string;
  displayName: string;
  description: string;
  hidden: boolean;
}

/**
 * Ask Codex which models the signed-in account offers, via the `model/list`
 * method of `codex app-server` (newline-delimited JSON-RPC over stdio).
 */
export async function listCodexModels(binary: string, env: NodeJS.ProcessEnv): Promise<ModelOption[]> {
  const child = spawn(binary, ["app-server"], { env, stdio: ["pipe", "pipe", "ignore"] });
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  const exited = new Promise<never>((_, reject) => {
    child.on("error", reject);
    child.on("close", (code) => reject(new Error(`codex app-server exited with code ${code}`)));
  });
  exited.catch(() => {});

  createInterface({ input: child.stdout }).on("line", (line) => {
    let message: { id?: unknown; method?: unknown; result?: unknown; error?: { message?: string } };
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof message.id !== "number" || message.method !== undefined) return;
    const request = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) request?.reject(new Error(message.error.message ?? "Codex request failed"));
    else request?.resolve(message.result);
  });

  let nextId = 1;
  const call = <T,>(method: string, params: unknown) => {
    const id = nextId++;
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    return Promise.race([new Promise<T>((resolve, reject) => pending.set(id, { resolve: resolve as (v: unknown) => void, reject })), exited]);
  };

  try {
    await call("initialize", { clientInfo: { name: "teamlet", version: "0.1.0" } });
    child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
    const models: CodexModel[] = [];
    let cursor: string | null = null;
    do {
      const page: { data: CodexModel[]; nextCursor?: string | null } = await call("model/list", cursor ? { cursor } : {});
      models.push(...page.data);
      cursor = page.nextCursor ?? null;
    } while (cursor && models.length < 200);
    return models
      .filter((model) => !model.hidden)
      .map((model) => ({ id: model.model, label: model.displayName, description: model.description }));
  } finally {
    child.kill();
  }
}

function startItem(item: CodexItem, input: RunInput) {
  const tool = describeItem(item);
  if (tool) input.emit({ type: "tool-start", itemId: item.id, ...tool });
}

function finishItem(item: CodexItem, input: RunInput) {
  const tool = describeItem(item);
  if (!tool) {
    if (item.type === "error") input.emit({ type: "error", text: item.message ?? "Codex error" });
    return;
  }
  // Some items (file changes) only arrive as completed — make sure they exist first.
  input.emit({ type: "tool-start", itemId: item.id, ...tool });
  const failed = item.status === "failed" || (typeof item.exit_code === "number" && item.exit_code !== 0) || Boolean(item.error);
  let output = "";
  if (item.type === "command_execution") output = item.aggregated_output ?? "";
  else if (item.type === "file_change") output = item.status ?? "";
  else if (item.type === "mcp_tool_call") {
    output = item.error ? (typeof item.error === "string" ? item.error : (item.error.message ?? "error")) : JSON.stringify(item.result ?? "", null, 2);
  }
  input.emit({ type: "tool-end", itemId: item.id, output, isError: failed });
}

function describeItem(item: CodexItem): { name: string; input: string } | null {
  switch (item.type) {
    case "command_execution":
      return { name: "Shell", input: item.command ?? "" };
    case "file_change":
      return { name: "Edit", input: (item.changes ?? []).map((c) => `${c.kind} ${c.path}`).join("\n") };
    case "mcp_tool_call":
      return { name: `${item.server}.${item.tool}`, input: item.arguments ? JSON.stringify(item.arguments, null, 2) : "" };
    case "web_search":
      return { name: "WebSearch", input: item.query ?? "" };
    default:
      return null;
  }
}
