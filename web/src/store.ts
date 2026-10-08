import { useSyncExternalStore } from "react";
import type {
  Agent,
  ApprovalRequest,
  CreateSessionRequest,
  FolderListing,
  LoginState,
  PermissionLevel,
  ProviderId,
  ProviderStatus,
  ServerEvent,
  ServerInfo,
  Session,
} from "../../shared/protocol.ts";

/** Key for per-account state: a provider plus, for Claude, a config folder. */
export const accountKey = (provider: ProviderId, configDir?: string) => `${provider}:${configDir ?? ""}`;

/** Client mirror of server state, fed by the /ws event stream. */
class ClientStore {
  sessions = new Map<string, Session>();
  agents = new Map<string, Agent>();
  /** One entry per account, each provider's default account first. */
  providers: ProviderStatus[] = [];
  approvals = new Map<string, ApprovalRequest>();
  /** Keyed by accountKey(). */
  logins = new Map<string, LoginState>();
  defaultCwd = "";
  maxParallel = 0;
  server: ServerInfo | null = null;
  connected = false;
  loaded = false;

  private version = 0;
  private listeners = new Set<() => void>();
  private frame = 0;
  private socket: WebSocket | null = null;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  getVersion = () => this.version;

  changed() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.version++;
      for (const listener of this.listeners) listener();
    });
  }

  connect() {
    if (this.socket && this.socket.readyState <= WebSocket.OPEN) return;
    const ws = new WebSocket(`ws://${location.host}/ws`);
    this.socket = ws;
    ws.onopen = () => {
      this.connected = true;
      this.changed();
    };
    ws.onmessage = (message) => this.apply(JSON.parse(message.data as string) as ServerEvent);
    ws.onclose = () => {
      this.socket = null;
      this.connected = false;
      this.changed();
      // The server restarted or isn't up yet: keep trying.
      setTimeout(() => this.connect(), 1000);
    };
  }

  private apply(event: ServerEvent) {
    switch (event.type) {
      case "snapshot":
        this.sessions = new Map(event.sessions.map((s) => [s.id, s]));
        this.agents = new Map(event.agents.map((a) => [a.id, a]));
        this.providers = event.providers;
        this.approvals = new Map(event.approvals.map((a) => [a.id, a]));
        this.logins = new Map(event.logins.map((l) => [accountKey(l.provider, l.configDir), l]));
        this.defaultCwd = event.defaultCwd;
        this.maxParallel = event.maxParallel;
        this.server = event.server;
        this.loaded = true;
        break;
      case "session":
        this.sessions.set(event.session.id, event.session);
        break;
      case "session-deleted":
        for (const id of this.sessions.get(event.sessionId)?.agentIds ?? []) this.agents.delete(id);
        this.sessions.delete(event.sessionId);
        break;
      case "agent": {
        const existing = this.agents.get(event.agent.id);
        this.agents.set(event.agent.id, { ...event.agent, items: existing?.items ?? [] });
        break;
      }
      case "item": {
        const agent = this.agents.get(event.agentId);
        if (!agent) break;
        const index = agent.items.findIndex((item) => item.id === event.item.id);
        const items = [...agent.items];
        if (index === -1) items.push(event.item);
        else items[index] = event.item;
        this.agents.set(agent.id, { ...agent, items });
        break;
      }
      case "item-append": {
        const agent = this.agents.get(event.agentId);
        if (!agent) break;
        const items = agent.items.map((item) => {
          if (item.id !== event.itemId) return item;
          if (event.field === "text" && "text" in item) return { ...item, text: item.text + event.delta };
          if (event.field === "output" && item.kind === "tool") return { ...item, output: (item.output ?? "") + event.delta };
          return item;
        });
        this.agents.set(agent.id, { ...agent, items });
        break;
      }
      case "providers":
        this.providers = event.providers;
        break;
      case "approval":
        this.approvals.set(event.approval.id, event.approval);
        break;
      case "approval-resolved":
        this.approvals.delete(event.id);
        break;
      case "login":
        this.logins.set(accountKey(event.login.provider, event.login.configDir), event.login);
        break;
    }
    this.changed();
  }
}

export const store = new ClientStore();
store.connect();

export function useStore() {
  useSyncExternalStore(store.subscribe, store.getVersion);
  return store;
}

async function call<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: { "content-type": "application/json", "x-teamlet": "1" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) throw new Error(data.error ?? `Request failed (${response.status})`);
  return data as T;
}

export const api = {
  createSession: (request: CreateSessionRequest) => call<Session>("POST", "/api/sessions", request),
  stopSession: (id: string) => call("POST", `/api/sessions/${id}/stop`),
  deleteSession: (id: string) => call("DELETE", `/api/sessions/${id}`),
  sendMessage: (agentId: string, text: string) => call("POST", `/api/agents/${agentId}/messages`, { text }),
  stopAgent: (agentId: string) => call("POST", `/api/agents/${agentId}/stop`),
  setModel: (agentId: string, model: string) => call("POST", `/api/agents/${agentId}/model`, { model }),
  setPermission: (sessionId: string, permission: PermissionLevel) => call("POST", `/api/sessions/${sessionId}/permission`, { permission }),
  resolveApproval: (id: string, allow: boolean) => call("POST", `/api/approvals/${id}`, { allow }),
  refreshProviders: () => call<ProviderStatus[]>("POST", "/api/providers/refresh"),
  addConfigDir: (id: ProviderId, path: string) => call<ProviderStatus[]>("POST", `/api/providers/${id}/config-dirs`, { path }),
  removeConfigDir: (id: ProviderId, path: string) => call("POST", `/api/providers/${id}/config-dirs/remove`, { path }),
  startLogin: (id: ProviderId, configDir?: string) => call("POST", `/api/providers/${id}/login`, { configDir }),
  loginInTerminal: (id: ProviderId, configDir?: string) => call("POST", `/api/providers/${id}/login/terminal`, { configDir }),
  cancelLogin: (id: ProviderId, configDir?: string) => call("POST", `/api/providers/${id}/login/cancel`, { configDir }),
  sendLoginInput: (id: ProviderId, text: string, configDir?: string) =>
    call("POST", `/api/providers/${id}/login/input`, { text, configDir }),
  listFolder: (path?: string, hidden = false) =>
    call<FolderListing>("GET", `/api/fs/list?${new URLSearchParams({ ...(path ? { path } : {}), ...(hidden ? { hidden: "1" } : {}) })}`),
  createFolder: (parent: string, name: string) => call<{ path: string }>("POST", "/api/fs/mkdir", { parent, name }),
  pickFolderNatively: (start?: string) => call<{ path?: string; cancelled?: boolean }>("POST", "/api/fs/pick-native", { start }),
  checkDir: (path: string) => call<{ path: string; ok: boolean }>("GET", `/api/fs/check?path=${encodeURIComponent(path)}`),
};
