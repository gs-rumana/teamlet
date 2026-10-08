import { useCallback, useEffect, useMemo, useState } from "react";
import { Cpu, Folder, LoaderCircle, Square, Trash, UserRound, X } from "lucide-react";
import type { Agent, PermissionLevel, ProviderStatus, Session, TimelineItem } from "../../../shared/protocol.ts";
import { api, useStore } from "../store.ts";
import { Composer } from "./Composer.tsx";
import { SessionContext } from "./sessionContext.ts";
import { Timeline } from "./Timeline.tsx";
import {
  accountLabel,
  AgentAvatar,
  basename,
  Button,
  Elapsed,
  IconButton,
  isActive,
  modelLabel,
  PERMISSIONS,
  plainText,
  PROVIDER_LABEL,
  ProviderTag,
  relativeTime,
  StatusPill,
} from "./ui.tsx";

function activity(item: TimelineItem | undefined): string {
  if (!item) return "";
  if (item.kind === "tool") {
    let target = item.input.split("\n")[0];
    try {
      const input = JSON.parse(item.input) as Record<string, unknown>;
      target = String(input.file_path ?? input.command ?? input.pattern ?? input.url ?? input.query ?? target);
    } catch {}
    return `${item.name.replace(/^mcp__\w+__/, "")} ${target}`;
  }
  return "text" in item ? (item.text.split("\n").filter(Boolean).at(-1) ?? "") : "";
}

const report = (error: unknown) => alert(error instanceof Error ? error.message : String(error));

/** The lead's provider and a model picker. The server only accepts a change between turns. */
function LeadModel({ lead, account }: { lead: Agent; account?: ProviderStatus }) {
  // The text of a custom model id while the user types one.
  const [custom, setCustom] = useState<string | null>(null);
  const busy = isActive(lead);
  const current = lead.model ?? "";
  const models = account?.models ?? [];
  const change = (model: string) => void api.setModel(lead.id, model).catch(report);

  return (
    <label className="chip" title={busy ? "You can change the model once the lead finishes or is stopped" : "The lead's model, used from its next turn"}>
      <Cpu size={12} />
      {PROVIDER_LABEL[lead.provider]} ·
      {custom === null ? (
        <select
          className="inline-select"
          aria-label="Lead model"
          value={current}
          disabled={busy}
          onChange={(e) => (e.target.value === "__custom" ? setCustom("") : change(e.target.value))}
        >
          {/* A model this account doesn't list, such as a custom id. */}
          {!models.some((m) => m.id === current) && <option value={current}>{current || "Default"}</option>}
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
          <option value="__custom">Custom model id…</option>
        </select>
      ) : (
        <input
          className="inline-input"
          aria-label="Custom model id"
          value={custom}
          placeholder="model id, then Enter"
          autoFocus
          spellCheck={false}
          onChange={(e) => setCustom(e.target.value)}
          onBlur={() => setCustom(null)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && custom.trim()) change(custom);
            if (e.key === "Enter" || e.key === "Escape") setCustom(null);
          }}
        />
      )}
    </label>
  );
}

function WorkerCard({ worker, index, selected, onSelect }: { worker: Agent; index: number; selected: boolean; onSelect: () => void }) {
  const store = useStore();
  const tools = worker.items.filter((i) => i.kind === "tool").length;
  const active = isActive(worker);
  const preview = active ? activity(worker.items.at(-1)) : plainText(worker.result ?? activity(worker.items.at(-1)));
  return (
    <button className={`worker-card status-${worker.status} ${selected ? "selected" : ""}`} onClick={onSelect}>
      <div className="worker-card-head">
        <AgentAvatar label={String(index + 1)} />
        <div className="worker-card-title">
          <span className="worker-title">{worker.title}</span>
          <span className="worker-meta">
            <ProviderTag provider={worker.provider} model={modelLabel(store.providers, worker.provider, worker.model)} />
          </span>
        </div>
        <StatusPill status={worker.status} />
      </div>
      <div className={`worker-preview ${active ? "live" : ""}`}>
        {preview || <span className="muted">{worker.status === "queued" ? "Waiting for a free slot" : "Starting…"}</span>}
      </div>
      <div className="worker-foot">
        <span>{tools === 1 ? "1 step" : `${tools} steps`}</span>
        <span className="sep" />
        <Elapsed agent={worker} />
      </div>
    </button>
  );
}

function WorkerDrawer({ worker, index, onClose }: { worker: Agent; index: number; onClose: () => void }) {
  const store = useStore();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <>
      <div className="drawer-scrim" onClick={onClose} />
      <aside className="drawer" aria-label={`Worker ${worker.title}`}>
        <header className="drawer-head">
          <AgentAvatar label={String(index + 1)} />
          <div className="drawer-title">
            <h3>{worker.title}</h3>
            <div className="meta-row">
              <ProviderTag provider={worker.provider} model={modelLabel(store.providers, worker.provider, worker.model)} />
              <span className="muted">
                <Elapsed agent={worker} />
              </span>
            </div>
          </div>
          <StatusPill status={worker.status} />
          {isActive(worker) && <IconButton icon={Square} label="Stop worker" onClick={() => void api.stopAgent(worker.id)} />}
          <IconButton icon={X} label="Close" onClick={onClose} />
        </header>
        <Timeline agent={worker} />
        <Composer
          placeholder="Message this worker directly…"
          busy={isActive(worker)}
          onSend={(text) => api.sendMessage(worker.id, text)}
          onStop={() => void api.stopAgent(worker.id)}
        />
      </aside>
    </>
  );
}

function TeamBar({ workers }: { workers: Agent[] }) {
  const counts = {
    running: workers.filter((w) => w.status === "running").length,
    queued: workers.filter((w) => w.status === "queued").length,
    done: workers.filter((w) => w.status === "done").length,
    failed: workers.filter((w) => w.status === "error" || w.status === "stopped").length,
  };
  const parts = [
    counts.running && `${counts.running} working`,
    counts.queued && `${counts.queued} queued`,
    counts.done && `${counts.done} done`,
    counts.failed && `${counts.failed} stopped or failed`,
  ].filter(Boolean);
  return (
    <div className="teambar">
      <div className="teambar-track">
        {workers.map((w) => (
          <span key={w.id} className={`teambar-seg seg-${w.status}`} title={`${w.title}: ${w.status}`} />
        ))}
      </div>
      <span className="teambar-label">{parts.join(" · ")}</span>
    </div>
  );
}

export function SessionView({ session, onDeleted }: { session: Session; onDeleted: () => void }) {
  const store = useStore();
  const lead = store.agents.get(session.leadAgentId);
  const workers = session.agentIds.map((id) => store.agents.get(id)).filter((a): a is Agent => a?.role === "worker");
  const [selectedWorker, setSelectedWorker] = useState<string | null>(null);
  const [tab, setTab] = useState<"lead" | "team">("lead");
  const selectedIndex = workers.findIndex((w) => w.id === selectedWorker);
  const anyActive = [lead, ...workers].some((a) => a && isActive(a));
  const runningWorkers = workers.filter((w) => w.status === "running").length;
  const Permission = PERMISSIONS[session.permission];

  const openWorker = useCallback((id: string) => setSelectedWorker(id), []);
  const context = useMemo(() => ({ cwd: session.cwd, openWorker }), [session.cwd, openWorker]);

  useEffect(() => setSelectedWorker(null), [session.id]);

  if (!lead) return null;
  // With several accounts for the lead's provider, show which one this session runs on.
  const leadAccounts = store.providers.filter((p) => p.id === lead.provider);
  const leadAccount = leadAccounts.find((p) => p.configDir === lead.configDir);

  return (
    <SessionContext.Provider value={context}>
      <div className="session">
        <header className="session-head">
          <div className="session-head-main">
            <h1 title={session.title}>{session.title}</h1>
            <div className="meta-row">
              <span className="chip mono" title={session.cwd}>
                <Folder size={12} />
                {session.cwd}
              </span>
              <label className={`chip ${session.permission === "full-access" ? "chip-warn" : ""}`} title={Permission.hint}>
                <Permission.icon size={12} />
                <select
                  className="inline-select"
                  aria-label="Access"
                  value={session.permission}
                  onChange={(e) => void api.setPermission(session.id, e.target.value as PermissionLevel).catch(report)}
                >
                  {(Object.keys(PERMISSIONS) as PermissionLevel[]).map((level) => (
                    <option key={level} value={level}>
                      {PERMISSIONS[level].label}
                    </option>
                  ))}
                </select>
              </label>
              <LeadModel lead={lead} account={leadAccount ?? leadAccounts[0]} />
              {lead.configDir && leadAccounts.length > 1 && (
                <span className="chip" title={lead.configDir}>
                  <UserRound size={12} />
                  {leadAccount ? accountLabel(leadAccount) : basename(lead.configDir)}
                </span>
              )}
              <span className="muted small">Started {relativeTime(session.createdAt)}</span>
            </div>
          </div>
          <div className="session-actions">
            {anyActive && (
              <Button variant="danger" size="sm" icon={Square} onClick={() => void api.stopSession(session.id)}>
                Stop all
              </Button>
            )}
            <IconButton
              icon={Trash}
              label="Delete session"
              onClick={() => {
                if (confirm("Delete this session and its history? Files the agents changed are kept.")) {
                  void api.deleteSession(session.id).then(onDeleted);
                }
              }}
            />
          </div>
        </header>

        {workers.length > 0 && <TeamBar workers={workers} />}

        <div className="tabs" role="tablist">
          <button role="tab" aria-selected={tab === "lead"} className={tab === "lead" ? "active" : ""} onClick={() => setTab("lead")}>
            Lead
          </button>
          <button role="tab" aria-selected={tab === "team"} className={tab === "team" ? "active" : ""} onClick={() => setTab("team")}>
            Workers <span className="tab-count">{workers.length}</span>
            {runningWorkers > 0 && <LoaderCircle size={12} className="spin" />}
          </button>
        </div>

        <div className={`session-body show-${tab}`}>
          <section className="lead-pane">
            <div className="pane-head">
              <span className="pane-title">Lead</span>
              <ProviderTag provider={lead.provider} model={modelLabel(store.providers, lead.provider, lead.model)} />
              <span className="pane-head-spacer" />
              <span className="muted small">
                <Elapsed agent={lead} />
              </span>
              <StatusPill status={lead.status} />
            </div>
            <Timeline agent={lead} />
            <Composer
              placeholder="Reply to the lead…"
              busy={isActive(lead)}
              onSend={(text) => api.sendMessage(lead.id, text)}
              onStop={() => void api.stopAgent(lead.id)}
            />
          </section>

          <section className="team-pane">
            <div className="pane-head">
              <span className="pane-title">Workers</span>
              <span className="muted small">up to {store.maxParallel} at once</span>
            </div>
            {workers.length === 0 ? (
              <div className="team-empty">
                <div className="team-empty-art" aria-hidden>
                  <span className="node lead" />
                  <span className="edge" />
                  <span className="node" />
                  <span className="node" />
                  <span className="node" />
                </div>
                <p>When the lead splits the task, its workers appear here and run side by side.</p>
                <p className="muted small">Small tasks it may simply do itself.</p>
              </div>
            ) : (
              <div className="worker-grid">
                {workers.map((worker, index) => (
                  <WorkerCard
                    key={worker.id}
                    worker={worker}
                    index={index}
                    selected={worker.id === selectedWorker}
                    onSelect={() => setSelectedWorker(worker.id === selectedWorker ? null : worker.id)}
                  />
                ))}
              </div>
            )}
          </section>
        </div>

        {selectedWorker && selectedIndex >= 0 && (
          <WorkerDrawer worker={workers[selectedIndex]} index={selectedIndex} onClose={() => setSelectedWorker(null)} />
        )}
      </div>
    </SessionContext.Provider>
  );
}
