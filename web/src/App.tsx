import { useEffect, useState } from "react";
import { Menu, Plus, ShieldAlert } from "lucide-react";
import type { ProviderId } from "../../shared/protocol.ts";
import { accountKey, api, useStore } from "./store.ts";
import { ConnectDialog } from "./components/ConnectDialog.tsx";
import { NewTask } from "./components/NewTask.tsx";
import { SessionView } from "./components/SessionView.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { Button, IconButton } from "./components/ui.tsx";

function useHashRoute(): [string | null, (id: string | null) => void] {
  const read = () => location.hash.match(/^#\/s\/([\w-]+)/)?.[1] ?? null;
  const [id, setId] = useState(read);
  useEffect(() => {
    const onChange = () => setId(read());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return [id, (next) => (location.hash = next ? `#/s/${next}` : "#/")];
}

function Approvals() {
  const store = useStore();
  const approvals = [...store.approvals.values()];
  if (!approvals.length) return null;
  return (
    <div className="approvals" aria-live="polite">
      {approvals.map((approval) => {
        const session = store.sessions.get(approval.sessionId);
        return (
          <div key={approval.id} className="approval">
            <div className="approval-head">
              <ShieldAlert size={16} />
              <span>
                <strong>{approval.agentTitle}</strong> wants to run <strong>{approval.toolName}</strong>
              </span>
            </div>
            {session && <div className="muted small approval-session">{session.title}</div>}
            <pre className="terminal">{approval.input}</pre>
            <div className="row end">
              <Button variant="ghost" size="sm" onClick={() => void api.resolveApproval(approval.id, false)}>
                Deny
              </Button>
              <Button variant="primary" size="sm" onClick={() => void api.resolveApproval(approval.id, true)}>
                Allow
              </Button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Splash() {
  return (
    <div className="splash">
      <span className="thinking-dots">
        <i />
        <i />
        <i />
      </span>
    </div>
  );
}

export function App() {
  const store = useStore();
  const [sessionId, setSessionId] = useHashRoute();
  const [connecting, setConnecting] = useState<{ providerId: ProviderId; configDir?: string } | null>(null);
  const connect = (providerId: ProviderId, configDir?: string) => setConnecting({ providerId, configDir });
  const [menuOpen, setMenuOpen] = useState(false);
  const session = sessionId ? store.sessions.get(sessionId) : undefined;

  useEffect(() => {
    document.title = session ? `${session.title} · Teamlet` : "Teamlet";
  }, [session]);

  const go = (id: string | null) => {
    setSessionId(id);
    setMenuOpen(false);
  };

  return (
    <div className={`app ${menuOpen ? "menu-open" : ""}`}>
      <Sidebar activeId={sessionId} onSelect={go} onNew={() => go(null)} onConnect={connect} onClose={() => setMenuOpen(false)} />
      <div className="sidebar-scrim" onClick={() => setMenuOpen(false)} />

      <main className="main">
        <div className="topbar">
          <IconButton icon={Menu} label="Open menu" onClick={() => setMenuOpen(true)} />
          <span className="topbar-title">{session?.title ?? "New task"}</span>
          {session && <IconButton icon={Plus} label="New task" onClick={() => go(null)} />}
        </div>
        {!store.loaded ? (
          <Splash />
        ) : session ? (
          <SessionView key={session.id} session={session} onDeleted={() => go(null)} />
        ) : (
          <NewTask onCreated={go} onConnect={connect} />
        )}
      </main>

      <Approvals />
      {connecting && (
        <ConnectDialog
          key={accountKey(connecting.providerId, connecting.configDir)}
          providerId={connecting.providerId}
          configDir={connecting.configDir}
          onClose={() => setConnecting(null)}
        />
      )}
    </div>
  );
}
