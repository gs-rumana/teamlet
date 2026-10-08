import { useState } from "react";
import { Monitor, Moon, Plus, Search, Sun, X } from "lucide-react";
import { TeamletMark } from "./Logo.tsx";
import type { Agent, ProviderId, Session } from "../../../shared/protocol.ts";
import { accountKey, useStore } from "../store.ts";
import { useTheme, type ThemePreference } from "../theme.ts";
import { accountLabel, IconButton, isActive, relativeTime, StatusDot, useNow } from "./ui.tsx";

function sessionStatus(session: Session, agents: Map<string, Agent>) {
  const all = session.agentIds.map((id) => agents.get(id)).filter((a): a is Agent => Boolean(a));
  if (all.some((a) => a.status === "running")) return "running" as const;
  if (all.some((a) => a.status === "queued")) return "queued" as const;
  return agents.get(session.leadAgentId)?.status ?? "idle";
}

const THEMES: { value: ThemePreference; icon: typeof Sun; label: string }[] = [
  { value: "light", icon: Sun, label: "Light" },
  { value: "system", icon: Monitor, label: "System" },
  { value: "dark", icon: Moon, label: "Dark" },
];

export function Sidebar({
  activeId,
  onSelect,
  onNew,
  onConnect,
  onClose,
}: {
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onConnect: (id: ProviderId, configDir?: string) => void;
  onClose: () => void;
}) {
  const store = useStore();
  const [query, setQuery] = useState("");
  const [theme, setTheme] = useTheme();
  const now = useNow(true, 30_000);

  const sessions = [...store.sessions.values()]
    .filter((s) => !query || s.title.toLowerCase().includes(query.toLowerCase()))
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const startOfToday = new Date().setHours(0, 0, 0, 0);
  const groups: [string, Session[]][] = [
    ["Active", sessions.filter((s) => s.agentIds.some((id) => { const a = store.agents.get(id); return a && isActive(a); }))],
    ["Today", []],
    ["Earlier", []],
  ];
  for (const s of sessions) {
    if (groups[0][1].includes(s)) continue;
    (s.updatedAt >= startOfToday ? groups[1][1] : groups[2][1]).push(s);
  }

  return (
    <nav className="sidebar">
      <div className="brand">
        <TeamletMark />
        <span className="brand-name">Teamlet</span>
        <IconButton icon={X} label="Close menu" className="sidebar-close" onClick={onClose} />
      </div>

      <button className="new-task-btn" onClick={onNew}>
        <Plus size={16} />
        New task
      </button>

      {store.sessions.size > 4 && (
        <label className="search">
          <Search size={14} />
          <input placeholder="Search sessions" value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
      )}

      <div className="session-list">
        {store.loaded && sessions.length === 0 && (
          <div className="empty-note">{query ? "No matching sessions" : "Your sessions will show up here."}</div>
        )}
        {groups.map(([label, items]) =>
          items.length === 0 ? null : (
            <div key={label} className="session-group">
              <div className="section-label">{label}</div>
              {items.map((s) => (
                <button key={s.id} className={`session-item ${s.id === activeId ? "active" : ""}`} onClick={() => onSelect(s.id)}>
                  <StatusDot status={sessionStatus(s, store.agents)} />
                  <span className="session-item-title">{s.title}</span>
                  <span className="session-item-meta">{relativeTime(s.updatedAt, now).replace(" ago", "")}</span>
                </button>
              ))}
            </div>
          ),
        )}
      </div>

      <div className="sidebar-foot">
        <div className="section-label">Subscriptions</div>
        {store.providers.map((p) => (
          <button key={accountKey(p.id, p.configDir)} className="provider-row" title={p.configDir} onClick={() => onConnect(p.id, p.configDir)}>
            <span className="provider-row-name">
              {p.name}
              {store.providers.some((q) => q.id === p.id && q !== p) && <span className="provider-row-account">{accountLabel(p)}</span>}
            </span>
            <span className={`provider-state ${p.loggedIn ? "" : "cta"}`}>
              {p.loggedIn ? (p.plan ?? "Connected") : p.installed ? "Sign in" : "Set up"}
            </span>
          </button>
        ))}

        <div className="sidebar-bottom">
          <div className="theme-switch" role="radiogroup" aria-label="Theme">
            {THEMES.map(({ value, icon: Icon, label }) => (
              <button key={value} role="radio" aria-checked={theme === value} className={theme === value ? "active" : ""} title={label} onClick={() => setTheme(value)}>
                <Icon size={13} />
              </button>
            ))}
          </div>
          <span className="version">{store.server ? `v${store.server.version}` : ""}</span>
        </div>
        {!store.connected && store.loaded && <div className="offline">Reconnecting…</div>}
      </div>
    </nav>
  );
}
