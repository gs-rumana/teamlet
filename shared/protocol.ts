// Types shared by the server and the web client.

export type ProviderId = "claude" | "codex";

/**
 * How much an agent may do on the user's machine.
 * - read-only: read files and search only
 * - workspace-write: edit files in the working directory; shell commands need approval (Claude) or run sandboxed (Codex)
 * - full-access: no approvals, no sandbox
 */
export type PermissionLevel = "read-only" | "workspace-write" | "full-access";

export interface ModelOption {
  /** Value passed to the CLI's --model flag; "" means the CLI's own default. */
  id: string;
  label: string;
  description?: string;
}

export interface ProviderStatus {
  id: ProviderId;
  name: string;
  subscription: string;
  installed: boolean;
  binaryPath?: string;
  version?: string;
  loggedIn: boolean;
  account?: string;
  plan?: string;
  detail?: string;
  installHint: string;
  loginCommand: string;
  models: ModelOption[];
  /** True when `models` came from the CLI itself rather than the built-in fallback list. */
  modelsDiscovered: boolean;
  /**
   * Claude reports one status per account: each config folder (CLAUDE_CONFIG_DIR)
   * holds its own sign-in. Unset for providers with a single account.
   */
  configDir?: string;
  /** The folder the CLI uses when none is chosen. The others were added in Teamlet and can be removed. */
  isDefaultConfigDir?: boolean;
}

export type AgentRole = "lead" | "worker";
export type AgentStatus = "idle" | "queued" | "running" | "done" | "error" | "stopped";

export type TimelineItem =
  | { kind: "user"; id: string; at: number; text: string }
  | { kind: "assistant"; id: string; at: number; text: string }
  | {
      kind: "tool";
      id: string;
      at: number;
      name: string;
      input: string;
      output?: string;
      status: "running" | "done" | "error";
    }
  | { kind: "error"; id: string; at: number; text: string }
  | { kind: "notice"; id: string; at: number; text: string };

export interface Agent {
  id: string;
  sessionId: string;
  parentId?: string;
  role: AgentRole;
  title: string;
  provider: ProviderId;
  model?: string;
  /** The account's config folder (see ProviderStatus.configDir). Follow-up turns resume in it. */
  configDir?: string;
  status: AgentStatus;
  /** Provider-side conversation id used to resume follow-up turns. */
  providerSessionId?: string;
  items: TimelineItem[];
  /** Final message of the most recent turn. */
  result?: string;
  costUsd?: number;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  finishedAt?: number;
}

export type AgentMeta = Omit<Agent, "items">;

export interface Session {
  id: string;
  title: string;
  cwd: string;
  permission: PermissionLevel;
  leadAgentId: string;
  agentIds: string[];
  createdAt: number;
  updatedAt: number;
}

export interface ApprovalRequest {
  id: string;
  sessionId: string;
  agentId: string;
  agentTitle: string;
  toolName: string;
  input: string;
  at: number;
}

export interface LoginState {
  provider: ProviderId;
  /** The account being signed in (see ProviderStatus.configDir). */
  configDir?: string;
  running: boolean;
  output: string;
  urls: string[];
  /** One-time code from a device-code sign-in, to type on the provider's page. */
  code?: string;
  exitCode?: number | null;
}

export interface ServerInfo {
  version: string;
  /** The server can open a Terminal window to sign in (macOS). */
  canOpenTerminal: boolean;
  /** The server can show the native macOS folder dialog. */
  nativeFolderPicker: boolean;
}

export interface FolderListing {
  path: string;
  /** null at the filesystem root. */
  parent: string | null;
  home: string;
  entries: { name: string; path: string; git: boolean }[];
  truncated: boolean;
}

export interface Snapshot {
  sessions: Session[];
  agents: Agent[];
  providers: ProviderStatus[];
  approvals: ApprovalRequest[];
  logins: LoginState[];
  defaultCwd: string;
  maxParallel: number;
  server: ServerInfo;
}

export type ServerEvent =
  | ({ type: "snapshot" } & Snapshot)
  | { type: "session"; session: Session }
  | { type: "session-deleted"; sessionId: string }
  | { type: "agent"; agent: AgentMeta }
  | { type: "item"; agentId: string; item: TimelineItem }
  | { type: "item-append"; agentId: string; itemId: string; field: "text" | "output"; delta: string }
  | { type: "providers"; providers: ProviderStatus[] }
  | { type: "approval"; approval: ApprovalRequest }
  | { type: "approval-resolved"; id: string }
  | { type: "login"; login: LoginState };

export interface CreateSessionRequest {
  prompt: string;
  cwd: string;
  provider: ProviderId;
  model?: string;
  /** The lead's account (see ProviderStatus.configDir). Defaults to the first signed-in one. */
  configDir?: string;
  permission: PermissionLevel;
}
