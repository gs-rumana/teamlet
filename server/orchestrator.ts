import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import type {
  Agent,
  AgentMeta,
  ApprovalRequest,
  CreateSessionRequest,
  PermissionLevel,
  ProviderId,
  ProviderStatus,
  ServerEvent,
  Session,
  TimelineItem,
} from "../shared/protocol.ts";
import type { AgentEvent, ProviderAdapter } from "./providers/types.ts";
import type { Store } from "./store.ts";
import { expandHome, newId, truncate } from "./util.ts";

export const MCP_SERVER_NAME = "teamlet";
const MAX_TOOL_OUTPUT = 20_000;
const MAX_RESULT_FOR_LEAD = 16_000;
const PERMISSION_LABEL: Record<PermissionLevel, string> = {
  "read-only": "Read only",
  "workspace-write": "Edit files",
  "full-access": "Full access",
};

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface WorkerTask {
  title: string;
  prompt: string;
  provider?: ProviderId;
  model?: string;
}

interface PendingApproval {
  request: ApprovalRequest;
  resolve: (allowed: boolean) => void;
}

const isTerminal = (agent: Agent) => agent.status !== "running" && agent.status !== "queued";

export class Orchestrator {
  private listeners = new Set<(event: ServerEvent) => void>();
  /** One entry per account, each provider's default account first. */
  private providerStatus: ProviderStatus[] = [];
  private controllers = new Map<string, AbortController>();
  private approvals = new Map<string, PendingApproval>();
  /** Running turns that can switch access level without restarting, by agent id. */
  private permissionListeners = new Map<string, (permission: PermissionLevel) => void>();
  private finishWaiters = new Set<() => void>();
  private mcpTokens = new Map<string, string>(); // token -> lead agent id
  private runningWorkers = 0;
  private slotQueue: (() => void)[] = [];

  private store: Store;
  private providers: Record<ProviderId, ProviderAdapter>;
  readonly options: { maxParallel: number; port: number; defaultCwd: string };

  constructor(store: Store, providers: Record<ProviderId, ProviderAdapter>, options: Orchestrator["options"]) {
    this.store = store;
    this.providers = providers;
    this.options = options;
  }

  // ---------------------------------------------------------------- events

  subscribe(listener: (event: ServerEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private broadcast(event: ServerEvent) {
    for (const listener of this.listeners) listener(event);
  }

  snapshot(): Omit<Extract<ServerEvent, { type: "snapshot" }>, "logins" | "server"> {
    return {
      type: "snapshot",
      sessions: [...this.store.sessions.values()],
      agents: [...this.store.agents.values()],
      providers: this.providerStatus,
      approvals: [...this.approvals.values()].map((a) => a.request),
      defaultCwd: this.options.defaultCwd,
      maxParallel: this.options.maxParallel,
    };
  }

  /** Stop every running agent and wait (briefly) for their turns to wind down. */
  async shutdown(timeoutMs = 5000) {
    const running = [...this.controllers.values()];
    for (const controller of running) controller.abort();
    if (!running.length) return;
    const deadline = Date.now() + timeoutMs;
    while (this.controllers.size && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  }

  // ------------------------------------------------------------- providers

  async refreshProviders(): Promise<ProviderStatus[]> {
    const statuses = await Promise.all(Object.values(this.providers).flatMap((p) => this.configDirs(p.id).map((dir) => p.status(dir))));
    // Drop accounts removed while their status was loading.
    this.providerStatus = statuses.filter((s) => this.configDirs(s.id).includes(s.configDir));
    this.broadcast({ type: "providers", providers: this.providerStatus });
    return this.providerStatus;
  }

  availableProviders(): ProviderStatus[] {
    return this.providerStatus.filter((p) => p.installed && p.loggedIn);
  }

  /** A provider's account config folders: its default, then the ones the user added. `[undefined]` if it has one account. */
  private configDirs(id: ProviderId): (string | undefined)[] {
    const fallback = this.providers[id].defaultConfigDir?.();
    if (!fallback) return [undefined];
    return [fallback, ...(this.store.settings.configDirs[id] ?? []).filter((dir) => dir !== fallback)];
  }

  /** A config folder from a request: one of the provider's accounts, or its default when none is given. */
  resolveConfigDir(id: ProviderId, configDir?: string): string | undefined {
    const dirs = this.configDirs(id);
    if (!configDir) return dirs[0];
    if (!dirs.includes(configDir)) throw new HttpError(400, `Unknown config folder: ${configDir}`);
    return configDir;
  }

  async addConfigDir(id: ProviderId, rawPath: string): Promise<ProviderStatus[]> {
    if (!this.providers[id].defaultConfigDir) throw new HttpError(400, `${id} doesn't support more than one account`);
    const path = rawPath.trim() && resolve(expandHome(rawPath.trim()));
    if (!path || !existsSync(path) || !statSync(path).isDirectory()) throw new HttpError(400, `Folder does not exist: ${rawPath}`);
    if (this.configDirs(id).includes(path)) throw new HttpError(409, `${path} is already in the list`);
    (this.store.settings.configDirs[id] ??= []).push(path);
    this.store.saveSettings();
    return this.refreshProviders();
  }

  removeConfigDir(id: ProviderId, path: string) {
    const added = this.store.settings.configDirs[id] ?? [];
    if (!added.includes(path)) throw new HttpError(404, "Only folders added in Teamlet can be removed");
    this.store.settings.configDirs[id] = added.filter((dir) => dir !== path);
    this.store.saveSettings();
    this.providerStatus = this.providerStatus.filter((s) => !(s.id === id && s.configDir === path));
    this.broadcast({ type: "providers", providers: this.providerStatus });
  }

  /** One account's status; without a config folder, the provider's default account. */
  private accountStatus(id: ProviderId, configDir?: string): ProviderStatus | undefined {
    return this.providerStatus.find((s) => s.id === id && (configDir ? s.configDir === configDir : !s.configDir || s.isDefaultConfigDir));
  }

  /** The account a new agent gets when none was chosen: the default one if signed in, else any signed-in one. */
  private fallbackConfigDir(id: ProviderId): string | undefined {
    return (this.providerStatus.find((s) => s.id === id && s.loggedIn) ?? this.accountStatus(id))?.configDir;
  }

  private assertProviderReady(id: ProviderId, configDir?: string) {
    const status = this.accountStatus(id, configDir);
    if (!status && configDir) throw new HttpError(400, `The ${id} config folder ${configDir} was removed. Add it again under Subscriptions.`);
    if (!status?.installed) throw new HttpError(400, `${status?.name ?? id} is not installed. Install it with: ${status?.installHint ?? ""}`);
    if (!status.loggedIn) {
      const account = status.isDefaultConfigDir === false ? ` (${status.configDir})` : "";
      throw new HttpError(400, `${status.name}${account} is not signed in. Connect your ${status.subscription} subscription first.`);
    }
  }

  // -------------------------------------------------------------- sessions

  createSession(request: CreateSessionRequest): Session {
    const prompt = request.prompt?.trim();
    if (!prompt) throw new HttpError(400, "Prompt is required");
    const cwd = expandHome(request.cwd?.trim() ?? "");
    if (!cwd || !existsSync(cwd) || !statSync(cwd).isDirectory()) {
      throw new HttpError(400, `Working directory does not exist: ${request.cwd}`);
    }
    if (!this.providers[request.provider]) throw new HttpError(400, `Unknown provider: ${request.provider}`);
    if (!Object.hasOwn(PERMISSION_LABEL, request.permission)) throw new HttpError(400, `Unknown access level: ${request.permission}`);
    const configDir = request.configDir ? this.resolveConfigDir(request.provider, request.configDir) : this.fallbackConfigDir(request.provider);
    this.assertProviderReady(request.provider, configDir);

    const now = Date.now();
    const sessionId = newId("ses");
    const lead = this.newAgent({
      sessionId,
      role: "lead",
      title: "Lead",
      provider: request.provider,
      model: request.model || undefined,
      configDir,
    });
    const session: Session = {
      id: sessionId,
      title: prompt.split("\n")[0].slice(0, 80),
      cwd,
      permission: request.permission,
      leadAgentId: lead.id,
      agentIds: [lead.id],
      createdAt: now,
      updatedAt: now,
    };
    this.store.sessions.set(session.id, session);
    this.store.agents.set(lead.id, lead);
    this.broadcast({ type: "session", session });
    this.broadcast({ type: "agent", agent: meta(lead) });
    this.startTurn(lead, prompt);
    return session;
  }

  sendMessage(agentId: string, text: string) {
    const agent = this.getAgent(agentId);
    if (!text.trim()) throw new HttpError(400, "Message is empty");
    if (!isTerminal(agent)) throw new HttpError(409, "This agent is still working. Stop it or wait for it to finish.");
    this.assertProviderReady(agent.provider, agent.configDir);
    this.startTurn(agent, text.trim());
  }

  /** Change an agent's model. Its next turn resumes the same conversation on the new one. */
  setModel(agentId: string, model: string) {
    const agent = this.getAgent(agentId);
    if (!isTerminal(agent)) throw new HttpError(409, "This agent is still working. Stop it or wait for it to finish.");
    const next = model.trim() || undefined;
    if (next === agent.model) return;
    const label = this.accountStatus(agent.provider, agent.configDir)?.models.find((m) => m.id === (next ?? ""))?.label;
    this.updateAgent(agent, { model: next });
    this.pushItem(agent, { kind: "notice", id: newId("note"), at: Date.now(), text: `Model changed to ${label ?? next ?? "Default"}.` });
  }

  /** Change a session's access level. It applies to every turn that starts afterwards and, where the provider can, to running ones. */
  setPermission(sessionId: string, permission: PermissionLevel) {
    const session = this.getSession(sessionId);
    if (!Object.hasOwn(PERMISSION_LABEL, permission)) throw new HttpError(400, `Unknown access level: ${permission}`);
    if (permission === session.permission) return;
    session.permission = permission;

    const running = session.agentIds.map((id) => this.getAgent(id)).filter((agent) => agent.status === "running");
    const unchanged = running.filter((agent) => !this.permissionListeners.has(agent.id));
    for (const agent of running) this.permissionListeners.get(agent.id)?.(permission);
    // Approvals are only requested at workspace-write, so the new level answers the pending ones.
    for (const pending of [...this.approvals.values()]) {
      if (pending.request.sessionId === sessionId) pending.resolve(permission === "full-access");
    }

    let text = `Access changed to ${PERMISSION_LABEL[permission]}.`;
    if (unchanged.length) {
      text += ` Still on the previous level until the current turn ends: ${unchanged.map((agent) => agent.title).join(", ")}.`;
    }
    this.pushItem(this.getAgent(session.leadAgentId), { kind: "notice", id: newId("note"), at: Date.now(), text });
    this.touchSession(session);
  }

  stopAgent(agentId: string) {
    this.controllers.get(agentId)?.abort();
  }

  stopSession(sessionId: string) {
    const session = this.getSession(sessionId);
    for (const id of session.agentIds) this.stopAgent(id);
  }

  deleteSession(sessionId: string) {
    const session = this.getSession(sessionId);
    this.stopSession(sessionId);
    for (const [token, leadId] of this.mcpTokens) if (leadId === session.leadAgentId) this.mcpTokens.delete(token);
    this.store.delete(sessionId);
    this.broadcast({ type: "session-deleted", sessionId });
  }

  resolveApproval(id: string, allowed: boolean) {
    const pending = this.approvals.get(id);
    if (!pending) throw new HttpError(404, "Approval request not found (it may have expired)");
    pending.resolve(allowed);
  }

  // ------------------------------------------------ delegation (MCP tools)

  leadForToken(token: string): Agent | undefined {
    const leadId = this.mcpTokens.get(token);
    return leadId ? this.store.agents.get(leadId) : undefined;
  }

  /** What list_providers shows a lead: for each provider, the account its workers would run as. */
  workerProviders(leadId: string): ProviderStatus[] {
    const lead = this.getAgent(leadId);
    return (Object.keys(this.providers) as ProviderId[])
      .map((id) => this.accountStatus(id, this.workerConfigDir(lead, id)))
      .filter((s): s is ProviderStatus => Boolean(s?.installed && s.loggedIn));
  }

  /** Workers on the lead's provider use the lead's account; other providers use their fallback account. */
  private workerConfigDir(lead: Agent, provider: ProviderId): string | undefined {
    return provider === lead.provider ? lead.configDir : this.fallbackConfigDir(provider);
  }

  spawnWorkers(leadId: string, tasks: WorkerTask[]): AgentMeta[] {
    const lead = this.getAgent(leadId);
    const session = this.getSession(lead.sessionId);
    const workers = tasks.map((task) => {
      const provider = task.provider ?? lead.provider;
      if (!this.providers[provider]) throw new Error(`Unknown provider "${provider}". Use list_providers.`);
      const configDir = this.workerConfigDir(lead, provider);
      this.assertProviderReady(provider, configDir);
      return this.newAgent({
        sessionId: session.id,
        parentId: lead.id,
        role: "worker",
        title: task.title.slice(0, 80) || "Worker",
        provider,
        model: task.model || (provider === lead.provider ? lead.model : undefined),
        configDir,
      });
    });
    workers.forEach((worker, index) => {
      this.store.agents.set(worker.id, worker);
      session.agentIds.push(worker.id);
      this.broadcast({ type: "agent", agent: meta(worker) });
      this.startTurn(worker, tasks[index].prompt);
    });
    this.touchSession(session);
    return workers.map(meta);
  }

  async waitForWorkers(leadId: string, workerIds: string[] | undefined, timeoutMs: number, signal: AbortSignal) {
    const lead = this.getAgent(leadId);
    const targets = () => {
      const ids = workerIds?.length ? workerIds : this.getSession(lead.sessionId).agentIds;
      return ids.map((id) => this.store.agents.get(id)).filter((a): a is Agent => a?.parentId === leadId);
    };
    const deadline = Date.now() + timeoutMs;
    while (!targets().every(isTerminal) && Date.now() < deadline && !signal.aborted) {
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          this.finishWaiters.delete(done);
          signal.removeEventListener("abort", done);
          resolve();
        };
        const timer = setTimeout(done, Math.max(0, deadline - Date.now()));
        this.finishWaiters.add(done);
        signal.addEventListener("abort", done, { once: true });
      });
    }
    const workers = targets();
    return {
      allDone: workers.every(isTerminal),
      workers: workers.map((w) => this.describeWorker(w, false)),
    };
  }

  describeWorker(worker: Agent, full: boolean) {
    const lastItem = worker.items.at(-1);
    return {
      workerId: worker.id,
      title: worker.title,
      provider: worker.provider,
      model: worker.model ?? "default",
      status: worker.status,
      ...(isTerminal(worker)
        ? { result: truncate(worker.result ?? "", full ? 100_000 : MAX_RESULT_FOR_LEAD) }
        : { lastActivity: lastItem ? summarizeItem(lastItem) : "starting" }),
    };
  }

  workerOf(leadId: string, workerId: string): Agent {
    const worker = this.store.agents.get(workerId);
    if (!worker || worker.parentId !== leadId) throw new Error(`No worker ${workerId} belongs to this lead.`);
    return worker;
  }

  // ------------------------------------------------------------- internals

  private getSession(id: string): Session {
    const session = this.store.sessions.get(id);
    if (!session) throw new HttpError(404, "Session not found");
    return session;
  }

  private getAgent(id: string): Agent {
    const agent = this.store.agents.get(id);
    if (!agent) throw new HttpError(404, "Agent not found");
    return agent;
  }

  private newAgent(fields: Pick<Agent, "sessionId" | "role" | "title" | "provider" | "model" | "configDir" | "parentId">): Agent {
    const now = Date.now();
    return { id: newId(fields.role === "lead" ? "lead" : "wrk"), status: "idle", items: [], createdAt: now, updatedAt: now, ...fields };
  }

  private touchSession(session: Session) {
    session.updatedAt = Date.now();
    this.store.markDirty(session.id);
    this.broadcast({ type: "session", session });
  }

  private updateAgent(agent: Agent, patch: Partial<Agent>) {
    Object.assign(agent, patch, { updatedAt: Date.now() });
    this.store.markDirty(agent.sessionId);
    this.broadcast({ type: "agent", agent: meta(agent) });
  }

  private pushItem(agent: Agent, item: TimelineItem) {
    agent.items.push(item);
    agent.updatedAt = Date.now();
    this.store.markDirty(agent.sessionId);
    this.broadcast({ type: "item", agentId: agent.id, item });
  }

  private async acquireWorkerSlot(signal: AbortSignal): Promise<boolean> {
    if (this.runningWorkers < this.options.maxParallel) {
      this.runningWorkers++;
      return true;
    }
    return new Promise<boolean>((resolve) => {
      const grant = () => {
        signal.removeEventListener("abort", cancel);
        this.runningWorkers++;
        resolve(true);
      };
      const cancel = () => {
        this.slotQueue = this.slotQueue.filter((g) => g !== grant);
        resolve(false);
      };
      this.slotQueue.push(grant);
      signal.addEventListener("abort", cancel, { once: true });
    });
  }

  private releaseWorkerSlot() {
    this.runningWorkers--;
    this.slotQueue.shift()?.();
  }

  private startTurn(agent: Agent, prompt: string) {
    const controller = new AbortController();
    this.controllers.set(agent.id, controller);
    this.pushItem(agent, { kind: "user", id: newId("msg"), at: Date.now(), text: prompt });
    void this.runTurn(agent, prompt, controller).finally(() => {
      this.controllers.delete(agent.id);
      for (const waiter of [...this.finishWaiters]) waiter();
    });
  }

  private async runTurn(agent: Agent, prompt: string, controller: AbortController) {
    const session = this.getSession(agent.sessionId);
    const isWorker = agent.role === "worker";
    const signal = controller.signal;

    if (isWorker) {
      this.updateAgent(agent, { status: "queued" });
      if (!(await this.acquireWorkerSlot(signal))) {
        this.updateAgent(agent, { status: "stopped", finishedAt: Date.now() });
        return;
      }
    }

    this.updateAgent(agent, { status: "running", startedAt: Date.now(), finishedAt: undefined });
    const itemsById = new Map(agent.items.map((item) => [item.id, item]));
    const emit = (event: AgentEvent) => this.applyEvent(agent, itemsById, event);

    try {
      const result = await this.providers[agent.provider].run({
        prompt,
        cwd: session.cwd,
        model: agent.model,
        configDir: agent.configDir,
        permission: session.permission,
        onPermissionChange: (listener) => this.permissionListeners.set(agent.id, listener),
        resumeId: agent.providerSessionId,
        instructions: isWorker ? WORKER_INSTRUCTIONS : leadInstructions(session.cwd, this.options.maxParallel),
        mcp: isWorker ? undefined : { name: MCP_SERVER_NAME, url: `http://127.0.0.1:${this.options.port}/mcp/${this.mcpTokenFor(agent.id)}` },
        signal,
        emit,
        requestApproval: (toolName, input) => this.requestApproval(agent, toolName, input, signal),
      });
      this.updateAgent(agent, {
        status: signal.aborted ? "stopped" : result.isError ? "error" : "done",
        result: result.finalText,
        costUsd: result.costUsd ?? agent.costUsd,
        finishedAt: Date.now(),
      });
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      this.pushItem(agent, { kind: "error", id: newId("err"), at: Date.now(), text });
      this.updateAgent(agent, { status: signal.aborted ? "stopped" : "error", result: text, finishedAt: Date.now() });
    } finally {
      this.permissionListeners.delete(agent.id);
      if (isWorker) this.releaseWorkerSlot();
      if (signal.aborted) this.pushItem(agent, { kind: "notice", id: newId("note"), at: Date.now(), text: "Stopped." });
      this.touchSession(session);
    }
  }

  private applyEvent(agent: Agent, itemsById: Map<string, TimelineItem>, event: AgentEvent) {
    const at = Date.now();
    const track = (item: TimelineItem) => {
      itemsById.set(item.id, item);
      this.pushItem(agent, item);
    };
    switch (event.type) {
      case "provider-session":
        if (agent.providerSessionId !== event.id) this.updateAgent(agent, { providerSessionId: event.id });
        break;
      case "text-delta": {
        const existing = itemsById.get(event.itemId);
        if (existing?.kind === "assistant") {
          existing.text += event.delta;
          this.store.markDirty(agent.sessionId);
          this.broadcast({ type: "item-append", agentId: agent.id, itemId: existing.id, field: "text", delta: event.delta });
        } else {
          track({ kind: "assistant", id: event.itemId, at, text: event.delta });
        }
        break;
      }
      case "tool-start":
        if (!itemsById.has(event.itemId)) track({ kind: "tool", id: event.itemId, at, name: event.name, input: event.input, status: "running" });
        break;
      case "tool-end": {
        const item = itemsById.get(event.itemId);
        if (item?.kind !== "tool") break;
        item.output = truncate(event.output, MAX_TOOL_OUTPUT);
        item.status = event.isError ? "error" : "done";
        this.store.markDirty(agent.sessionId);
        this.broadcast({ type: "item", agentId: agent.id, item });
        break;
      }
      case "notice":
        track({ kind: "notice", id: newId("note"), at, text: event.text });
        break;
      case "error":
        track({ kind: "error", id: newId("err"), at, text: event.text });
        break;
    }
  }

  private mcpTokenFor(leadId: string): string {
    for (const [token, id] of this.mcpTokens) if (id === leadId) return token;
    const token = randomBytes(24).toString("hex");
    this.mcpTokens.set(token, leadId);
    return token;
  }

  private requestApproval(agent: Agent, toolName: string, input: string, signal: AbortSignal): Promise<boolean> {
    const request: ApprovalRequest = {
      id: newId("apr"),
      sessionId: agent.sessionId,
      agentId: agent.id,
      agentTitle: agent.title,
      toolName,
      input,
      at: Date.now(),
    };
    return new Promise<boolean>((resolve) => {
      const finish = (allowed: boolean) => {
        if (!this.approvals.delete(request.id)) return;
        signal.removeEventListener("abort", onAbort);
        this.broadcast({ type: "approval-resolved", id: request.id });
        resolve(allowed);
      };
      const onAbort = () => finish(false);
      this.approvals.set(request.id, { request, resolve: finish });
      signal.addEventListener("abort", onAbort, { once: true });
      this.broadcast({ type: "approval", approval: request });
    });
  }
}

function meta(agent: Agent): AgentMeta {
  const { items: _items, ...rest } = agent;
  return rest;
}

function summarizeItem(item: TimelineItem): string {
  switch (item.kind) {
    case "tool":
      return `${item.name}: ${item.input.split("\n")[0].slice(0, 120)}`;
    case "assistant":
    case "user":
    case "notice":
    case "error":
      return item.text.slice(-200);
  }
}

function leadInstructions(cwd: string, maxParallel: number) {
  return `
# Teamlet: you are the lead agent
You coordinate a team of AI worker agents that run in parallel on the user's machine, using the user's own AI subscriptions. The \`${MCP_SERVER_NAME}\` MCP server gives you these tools:
- list_providers: which AI providers and models workers can use.
- spawn_workers: start one or more workers. Workers spawned in one call run simultaneously.
- wait_for_workers: block until workers finish (or a timeout) and collect their results.
- get_worker, message_worker (send a follow-up to a finished worker), stop_worker.

How to work:
1. If a task is small or tightly coupled, just do it yourself — delegation has overhead.
2. For bigger tasks, split the work into independent subtasks and start them in a single spawn_workers call so they run in parallel. Up to ${maxParallel} workers run at once; extra workers wait in a queue.
3. Workers cannot see this conversation. Every worker prompt must be self-contained: the goal, relevant files and context, constraints, and what to report back.
4. All workers share the working directory ${cwd}. Give each worker a disjoint set of files to change; never let two workers edit the same file at the same time.
5. Keep calling wait_for_workers until every worker is done. Review the results (check changed files when it matters), fix integration problems yourself or with message_worker, then give the user a concise final summary of what the team did.
`.trim();
}

const WORKER_INSTRUCTIONS = `
# Teamlet: you are a worker agent
A lead agent gave you the task below as one part of a larger job. Other workers are handling other parts in the same directory at the same time.
- Stay strictly within the scope of your task and only change the files it calls for.
- No one can answer clarifying questions. Make reasonable assumptions and state them.
- Finish with a short summary for the lead: what you did, which files you changed, and anything the lead needs to know.
`.trim();
