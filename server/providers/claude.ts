import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { query, type CanUseTool, type Options, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ModelOption, ProviderStatus } from "../../shared/protocol.ts";
import { childEnv, configFolder, run, shellCommand, stringifyInput, which, withTimeout } from "../util.ts";
import type { ProviderAdapter, RunInput, RunResult } from "./types.ts";

// ~/.claude must be reached with CLAUDE_CONFIG_DIR unset, which configFolder does. With the
// variable set, Claude Code reads .claude.json inside the folder rather than ~/.claude.json.
const CONFIG = configFolder("CLAUDE_CONFIG_DIR", join(homedir(), ".claude"));

const READ_ONLY_TOOLS = new Set([
  "Read",
  "Glob",
  "Grep",
  "LS",
  "NotebookRead",
  "WebFetch",
  "WebSearch",
  "TodoWrite",
  "Task",
  "Agent",
  "ToolSearch",
  "ListMcpResourcesTool",
  "ReadMcpResourceTool",
]);

/** Used until the CLI reports the account's real model list. */
const FALLBACK_MODELS: ModelOption[] = [
  { id: "", label: "Default" },
  { id: "opus", label: "Opus" },
  { id: "sonnet", label: "Sonnet" },
  { id: "haiku", label: "Haiku" },
];

/**
 * The plan in the account profile Claude Code periodically refreshes in .claude.json,
 * e.g. "max 5x". `auth status` reports the plan from when the account signed in, so an
 * upgrade from Pro to Max shows up only here. Only the profile's plan fields are used.
 */
async function profilePlan(env: NodeJS.ProcessEnv, email: string | undefined): Promise<string | undefined> {
  const file = env.CLAUDE_CONFIG_DIR ? join(env.CLAUDE_CONFIG_DIR, ".claude.json") : join(homedir(), ".claude.json");
  try {
    const { oauthAccount: profile } = JSON.parse(await readFile(file, "utf8")) as {
      oauthAccount?: { emailAddress?: string; organizationType?: string; organizationRateLimitTier?: string };
    };
    if (!profile?.organizationType || (email && profile.emailAddress !== email)) return undefined;
    const plan = profile.organizationType.replace(/^claude_/, "");
    const multiplier = profile.organizationRateLimitTier?.match(/_(\d+x)$/)?.[1];
    return multiplier ? `${plan} ${multiplier}` : plan;
  } catch {
    return undefined;
  }
}

/**
 * Drives the user's own Claude Code install through the Claude Agent SDK.
 * Auth is whatever `claude` is signed in with — a Claude Pro/Max subscription
 * via `claude auth login` — so this app never handles credentials itself.
 * Each config folder (CLAUDE_CONFIG_DIR) is a separate account with its own sign-in.
 */
export class ClaudeProvider implements ProviderAdapter {
  readonly id = "claude" as const;

  defaultConfigDir(): string {
    return CONFIG.defaultDir();
  }

  async status(configDir = this.defaultConfigDir()): Promise<ProviderStatus> {
    const binaryPath = which("claude");
    const overrides = CONFIG.env(configDir);
    const base: ProviderStatus = {
      id: "claude",
      name: "Claude",
      subscription: "Claude Pro / Max",
      installed: Boolean(binaryPath),
      binaryPath,
      loggedIn: false,
      installHint: "npm install -g @anthropic-ai/claude-code",
      loginCommand: shellCommand(["claude", "auth", "login", "--claudeai"], overrides),
      models: FALLBACK_MODELS,
      modelsDiscovered: false,
      configDir,
      isDefaultConfigDir: configDir === this.defaultConfigDir(),
    };
    if (!binaryPath) return { ...base, detail: "Claude Code CLI not found on PATH" };

    const env = childEnv(overrides);
    const [version, auth] = await Promise.all([run(binaryPath, ["--version"]), run(binaryPath, ["auth", "status", "--json"], { env })]);
    base.version = version.stdout.trim().split(" ")[0];
    try {
      const parsed = JSON.parse(auth.stdout) as {
        loggedIn?: boolean;
        authMethod?: string;
        email?: string;
        subscriptionType?: string;
      };
      const discovered = parsed.loggedIn ? await this.listModels(binaryPath, env).catch((error: unknown) => {
        console.warn("Could not list Claude models:", error instanceof Error ? error.message : error);
        return null;
      }) : null;
      const subscription = parsed.subscriptionType && ((await profilePlan(env, parsed.email)) ?? parsed.subscriptionType);
      return {
        ...base,
        ...(discovered ? { models: discovered, modelsDiscovered: true } : {}),
        loggedIn: Boolean(parsed.loggedIn),
        account: parsed.email,
        plan: subscription || parsed.authMethod,
        detail:
          parsed.loggedIn && /api|console|key/i.test(parsed.authMethod ?? "")
            ? `Signed in via ${parsed.authMethod} (API billing, not a subscription)`
            : undefined,
      };
    } catch {
      return { ...base, detail: (auth.stderr || auth.stdout).trim() || "Could not read auth status" };
    }
  }

  /**
   * Ask Claude Code which models this account and its settings allow. Opens a
   * session with an input stream that never sends a prompt, so nothing is billed.
   */
  private async listModels(binaryPath: string, env: NodeJS.ProcessEnv): Promise<ModelOption[]> {
    async function* noPrompt(): AsyncGenerator<SDKUserMessage> {
      await new Promise(() => {});
    }
    const session = query({ prompt: noPrompt(), options: { pathToClaudeCodeExecutable: binaryPath, env, cwd: homedir() } });
    try {
      const models = await withTimeout(session.supportedModels(), 20_000, "Listing Claude models");
      return models.map((model) => ({
        // "default" defers to the user's own Claude Code setting, same as passing no --model.
        id: model.value === "default" ? "" : model.value,
        label: model.displayName,
        description: model.description,
      }));
    } finally {
      session.close();
    }
  }

  loginArgs({ configDir }: { configDir?: string }) {
    // Prints a URL to open and accepts the code back on stdin.
    const binary = which("claude");
    return binary ? { command: binary, args: ["auth", "login", "--claudeai"], env: CONFIG.env(configDir) } : null;
  }

  async run(input: RunInput): Promise<RunResult> {
    const abortController = new AbortController();
    const onAbort = () => abortController.abort();
    input.signal.addEventListener("abort", onAbort, { once: true });

    // The user can change the access level while the turn runs (see onPermissionChange below).
    let permission = input.permission;
    const canUseTool: CanUseTool = async (toolName, toolInput) => {
      if (input.mcp && toolName.startsWith(`mcp__${input.mcp.name}__`)) return { behavior: "allow", updatedInput: toolInput };
      if (permission === "full-access") return { behavior: "allow", updatedInput: toolInput };
      if (permission === "read-only") {
        return READ_ONLY_TOOLS.has(toolName)
          ? { behavior: "allow", updatedInput: toolInput }
          : { behavior: "deny", message: "This session is read-only. Describe the change instead of making it." };
      }
      const allowed = await input.requestApproval(toolName, describeToolInput(toolName, toolInput));
      return allowed
        ? { behavior: "allow", updatedInput: toolInput }
        : { behavior: "deny", message: "The user denied this tool call." };
    };

    const options: Options = {
      cwd: input.cwd,
      abortController,
      includePartialMessages: true,
      env: childEnv(CONFIG.env(input.configDir)),
      pathToClaudeCodeExecutable: which("claude"),
      systemPrompt: { type: "preset", preset: "claude_code", append: input.instructions },
      canUseTool,
      ...(input.model ? { model: input.model } : {}),
      ...(input.resumeId ? { resume: input.resumeId } : {}),
      ...(input.permission === "full-access"
        ? { permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true }
        : input.permission === "workspace-write"
          ? { permissionMode: "acceptEdits" }
          : { permissionMode: "default" }),
      ...(input.mcp
        ? {
            // Delegation tools are approved in canUseTool above.
            mcpServers: {
              [input.mcp.name]: { type: "http", url: input.mcp.url, timeout: 15 * 60 * 1000, alwaysLoad: true },
            },
          }
        : {}),
    };

    // With partial messages on, text arrives as deltas; the full assistant
    // message follows. Only fall back to the full text if nothing streamed.
    const streamedMessages = new Set<string>();
    let currentMessageId = "";
    let finalText = "";
    let isError = false;
    let costUsd: number | undefined;

    try {
      const turn = query({ prompt: input.prompt, options });
      input.onPermissionChange((level) => {
        permission = level;
        // Bypass mode can only be chosen when the turn starts. A turn that becomes
        // full access keeps asking canUseTool, which then allows everything.
        turn.setPermissionMode(level === "read-only" ? "default" : "acceptEdits").catch(() => {});
      });
      for await (const message of turn as AsyncIterable<SDKMessage>) {
        switch (message.type) {
          case "system":
            if (message.subtype === "init") input.emit({ type: "provider-session", id: message.session_id });
            break;
          case "stream_event": {
            if (message.parent_tool_use_id) break;
            const event = message.event;
            if (event.type === "message_start") currentMessageId = event.message.id;
            if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
              streamedMessages.add(currentMessageId);
              input.emit({ type: "text-delta", itemId: `${currentMessageId}:${event.index}`, delta: event.delta.text });
            }
            break;
          }
          case "assistant": {
            if (message.parent_tool_use_id) break;
            const { id, content } = message.message;
            content.forEach((block, index) => {
              if (block.type === "tool_use") {
                input.emit({ type: "tool-start", itemId: block.id, name: block.name, input: describeToolInput(block.name, block.input) });
              } else if (block.type === "text" && !streamedMessages.has(id) && block.text) {
                input.emit({ type: "text-delta", itemId: `${id}:full${index}`, delta: block.text });
              }
            });
            if (message.error) input.emit({ type: "error", text: `Claude error: ${message.error}` });
            break;
          }
          case "user": {
            if (message.parent_tool_use_id || typeof message.message.content === "string") break;
            for (const block of message.message.content) {
              if (block.type !== "tool_result") continue;
              input.emit({
                type: "tool-end",
                itemId: block.tool_use_id,
                output: toolResultText(block.content),
                isError: Boolean(block.is_error),
              });
            }
            break;
          }
          case "result":
            costUsd = message.total_cost_usd;
            if (message.subtype === "success") {
              finalText = message.result;
              isError = message.is_error;
            } else {
              isError = true;
              const errors = (message as { errors?: string[] }).errors;
              finalText = errors?.length ? errors.join("\n") : `Run ended: ${message.subtype}`;
              input.emit({ type: "error", text: finalText });
            }
            break;
        }
      }
    } catch (error) {
      if (input.signal.aborted) return { finalText, isError: true, costUsd };
      const text = error instanceof Error ? error.message : String(error);
      input.emit({ type: "error", text });
      return { finalText: text, isError: true, costUsd };
    } finally {
      input.signal.removeEventListener("abort", onAbort);
    }
    return { finalText, isError, costUsd };
  }
}

function describeToolInput(toolName: string, input: unknown): string {
  const record = (input ?? {}) as Record<string, unknown>;
  if (toolName === "Bash" && typeof record.command === "string") return record.command;
  if ((toolName === "Read" || toolName === "Write" || toolName === "Edit") && typeof record.file_path === "string") {
    return toolName === "Read" ? record.file_path : stringifyInput(input);
  }
  return stringifyInput(input);
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part === "object" && "text" in part ? String((part as { text: unknown }).text) : `[${(part as { type?: string })?.type ?? "content"}]`))
      .join("\n");
  }
  return content == null ? "" : stringifyInput(content);
}
