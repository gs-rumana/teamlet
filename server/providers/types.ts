import type { PermissionLevel, ProviderId, ProviderStatus } from "../../shared/protocol.ts";
import type { EnvOverrides } from "../util.ts";

/** Normalized events every provider adapter emits while a turn runs. */
export type AgentEvent =
  | { type: "provider-session"; id: string }
  | { type: "text-delta"; itemId: string; delta: string }
  | { type: "tool-start"; itemId: string; name: string; input: string }
  | { type: "tool-end"; itemId: string; output: string; isError: boolean }
  | { type: "notice"; text: string }
  | { type: "error"; text: string };

/** Delegation tools exposed to a lead agent through the local MCP server. */
export interface McpAttachment {
  name: string;
  url: string;
}

export interface RunInput {
  prompt: string;
  cwd: string;
  model?: string;
  /** Config folder of the account to run as; the provider's default if unset. */
  configDir?: string;
  /** The session's access level when the turn starts. */
  permission: PermissionLevel;
  /**
   * Adapters that can switch access level mid-turn register a listener here. It runs when the
   * user changes the level while this turn is running. Without one, the turn keeps its level.
   */
  onPermissionChange: (listener: (permission: PermissionLevel) => void) => void;
  /** Provider conversation id to continue, if this is a follow-up turn. */
  resumeId?: string;
  /** Extra instructions layered on top of the provider's own system prompt. */
  instructions: string;
  mcp?: McpAttachment;
  signal: AbortSignal;
  emit: (event: AgentEvent) => void;
  /** Ask the user to allow a tool call. Resolves false if denied or aborted. */
  requestApproval: (toolName: string, input: string) => Promise<boolean>;
}

export interface RunResult {
  finalText: string;
  isError: boolean;
  costUsd?: number;
}

export interface ProviderAdapter {
  id: ProviderId;
  /**
   * Set by providers that support several accounts, one per config folder:
   * the folder the CLI uses when none is chosen.
   */
  defaultConfigDir?(): string;
  /** Status of the account in `configDir` (the default one if unset). */
  status(configDir?: string): Promise<ProviderStatus>;
  /**
   * argv for signing in with the user's subscription.
   */
  loginArgs(options: { configDir?: string }): { command: string; args: string[]; env?: EnvOverrides } | null;
  run(input: RunInput): Promise<RunResult>;
}
