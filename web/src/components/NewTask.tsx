import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowRight, CircleCheck, CircleX, Folder, FolderOpen } from "lucide-react";
import { TeamletMark } from "./Logo.tsx";
import type { PermissionLevel, ProviderId } from "../../../shared/protocol.ts";
import { api, useStore } from "../store.ts";
import { rememberFolder } from "../recentFolders.ts";
import { FolderPicker } from "./FolderPicker.tsx";
import { accountLabel, Button, Kbd, PERMISSIONS, PROVIDER_LABEL } from "./ui.tsx";

const EXAMPLES = [
  {
    title: "Audit a codebase",
    prompt:
      "Audit this repo: one worker reviews security, one reviews performance, one reviews test coverage. Then merge the findings into a single prioritized list with file references.",
  },
  {
    title: "Ship a feature with tests",
    prompt: "Add a dark mode toggle to the settings page, with tests. Split the UI work and the test work between workers, then make sure everything passes.",
  },
  {
    title: "Compare approaches",
    prompt:
      "Research three approaches for adding full-text search to this project. Have each worker prototype one in its own folder, then compare them and recommend one.",
  },
];

export function NewTask({ onCreated, onConnect }: { onCreated: (sessionId: string) => void; onConnect: (id: ProviderId) => void }) {
  const store = useStore();
  const ready = store.providers.filter((p) => p.installed && p.loggedIn);
  // Each provider once, as its default account; accounts are picked separately.
  const providerChoices = store.providers.filter((p, index, all) => all.findIndex((q) => q.id === p.id) === index);
  const [prompt, setPrompt] = useState("");
  const [cwd, setCwd] = useState(() => localStorage.getItem("teamlet.cwd") ?? "");
  const [provider, setProvider] = useState<ProviderId>(() => (localStorage.getItem("teamlet.provider") as ProviderId) ?? "claude");
  const [model, setModel] = useState(() => localStorage.getItem(`teamlet.model.${localStorage.getItem("teamlet.provider") ?? "claude"}`) ?? "");
  const [configDir, setConfigDir] = useState(
    () => localStorage.getItem(`teamlet.configDir.${localStorage.getItem("teamlet.provider") ?? "claude"}`) ?? "",
  );
  const [customModel, setCustomModel] = useState(false);
  const [permission, setPermission] = useState<PermissionLevel>(
    () => (localStorage.getItem("teamlet.permission") as PermissionLevel) ?? "workspace-write",
  );
  const [cwdOk, setCwdOk] = useState<boolean | null>(null);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const promptRef = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const el = promptRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(Math.max(el.scrollHeight, 132), 360)}px`;
  }, [prompt]);

  useEffect(() => {
    if (!cwd && store.defaultCwd) setCwd(store.defaultCwd);
  }, [store.defaultCwd, cwd]);

  useEffect(() => {
    if (ready.length && !ready.some((p) => p.id === provider)) chooseProvider(ready[0].id);
  }, [ready, provider]);

  useEffect(() => {
    if (!cwd) return;
    const timer = setTimeout(() => {
      api.checkDir(cwd).then((r) => setCwdOk(r.ok), () => setCwdOk(null));
    }, 250);
    return () => clearTimeout(timer);
  }, [cwd]);

  const accounts = store.providers.filter((p) => p.id === provider);
  // A remembered account that was removed or signed out falls back to the first signed-in one.
  const account = accounts.find((p) => p.loggedIn && p.configDir === configDir) ?? accounts.find((p) => p.loggedIn) ?? accounts[0];
  const models = account?.models ?? [];
  // A remembered model that this account no longer lists is shown as a custom id.
  const showCustomInput = customModel || (model !== "" && models.length > 0 && !models.some((m) => m.id === model));
  const canStart = Boolean(prompt.trim()) && !busy && cwdOk !== false && Boolean(account?.loggedIn);

  function chooseProvider(next: ProviderId) {
    setProvider(next);
    setModel(localStorage.getItem(`teamlet.model.${next}`) ?? "");
    setConfigDir(localStorage.getItem(`teamlet.configDir.${next}`) ?? "");
    setCustomModel(false);
  }

  const start = async () => {
    if (!canStart) return;
    setBusy(true);
    setError("");
    try {
      const session = await api.createSession({ prompt, cwd, provider, model: model || undefined, configDir: account?.configDir, permission });
      localStorage.setItem("teamlet.cwd", cwd);
      rememberFolder(cwd);
      localStorage.setItem("teamlet.provider", provider);
      localStorage.setItem(`teamlet.model.${provider}`, model);
      if (account?.configDir) localStorage.setItem(`teamlet.configDir.${provider}`, account.configDir);
      localStorage.setItem("teamlet.permission", permission);
      onCreated(session.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (store.loaded && ready.length === 0) {
    return (
      <div className="page">
        <div className="hero">
          <TeamletMark size={40} />
          <h1>Connect an AI subscription</h1>
          <p>
            Teamlet runs on subscriptions you already pay for. Sign in with at least one provider to start. Your credentials stay
            inside the provider's own CLI and never pass through this app.
          </p>
        </div>
        <div className="connect-grid">
          {providerChoices.map((p) => (
            <button key={p.id} className="connect-card" onClick={() => onConnect(p.id)}>
              <span className="connect-card-title">{p.name}</span>
              <span className="muted">{p.subscription}</span>
              <span className="connect-card-cta">
                {p.installed ? "Sign in" : "Set up"} <ArrowRight size={14} />
              </span>
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="page">
        <div className="hero">
          <TeamletMark size={40} />
          <h1>Put a team of AIs on it</h1>
          <p>
            A lead agent plans the work and hands pieces to up to {store.maxParallel || 6} workers running in parallel, all on the subscriptions
            you already have.
          </p>
        </div>

        <div className="task-card">
          <textarea
            ref={promptRef}
            className="task-prompt"
            value={prompt}
            autoFocus
            placeholder="Describe what you want done…"
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void start();
            }}
          />

          <div className={`task-options ${accounts.length > 1 ? "with-account" : ""}`}>
            <div className="field field-wide">
              <span className="field-label">Folder</span>
              <div className="folder-field">
                <span className={`input-wrap grow ${cwdOk === false ? "invalid" : ""}`}>
                  <Folder size={14} className="input-icon" />
                  <input value={cwd} onChange={(e) => setCwd(e.target.value)} spellCheck={false} placeholder="/path/to/project" aria-label="Folder" />
                  {cwdOk === true && <CircleCheck size={14} className="input-icon" />}
                  {cwdOk === false && <CircleX size={14} className="input-bad" />}
                </span>
                <Button icon={FolderOpen} onClick={() => setPicking(true)}>
                  Browse
                </Button>
              </div>
              {cwdOk === false && <span className="field-hint error">This folder doesn't exist on the server</span>}
            </div>

            <div className="field">
              <span className="field-label">Lead</span>
              <div className="segmented">
                {providerChoices.map((p) => {
                  const signedIn = ready.find((r) => r.id === p.id);
                  return (
                    <button
                      key={p.id}
                      className={provider === p.id ? "active" : ""}
                      disabled={!signedIn}
                      onClick={() => chooseProvider(p.id)}
                      title={signedIn ? `${p.name} · ${signedIn.plan ?? "connected"}` : `${p.name} is not connected`}
                    >
                      {PROVIDER_LABEL[p.id]}
                    </button>
                  );
                })}
              </div>
            </div>

            {accounts.length > 1 && (
              <label className="field">
                <span className="field-label">Account</span>
                <select className="select" value={account?.configDir} title={account?.configDir} onChange={(e) => setConfigDir(e.target.value)}>
                  {accounts.map((a) => (
                    <option key={a.configDir} value={a.configDir} disabled={!a.loggedIn}>
                      {`${accountLabel(a)}${a.loggedIn ? (a.plan ? ` · ${a.plan}` : "") : " (not signed in)"}`}
                    </option>
                  ))}
                </select>
              </label>
            )}

            <label className="field">
              <span className="field-label">Model</span>
              {showCustomInput ? (
                <span className="input-wrap">
                  <input
                    value={model}
                    placeholder="model id"
                    autoFocus={customModel}
                    onChange={(e) => setModel(e.target.value)}
                    onBlur={() => !model && setCustomModel(false)}
                  />
                </span>
              ) : (
                <select
                  className="select"
                  value={model}
                  onChange={(e) => {
                    if (e.target.value === "__custom") {
                      setCustomModel(true);
                      setModel("");
                    } else setModel(e.target.value);
                  }}
                >
                  {models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                  <option value="__custom">Custom model id…</option>
                </select>
              )}
            </label>

            <div className="field">
              <span className="field-label">Access</span>
              <div className="segmented">
                {(Object.keys(PERMISSIONS) as PermissionLevel[]).map((level) => (
                  <button
                    key={level}
                    className={`${permission === level ? "active" : ""} ${level === "full-access" ? "warn" : ""}`}
                    onClick={() => setPermission(level)}
                    title={PERMISSIONS[level].hint}
                  >
                    {PERMISSIONS[level].label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="task-foot">
            <div className={`task-hint ${permission === "full-access" ? "warn" : ""}`}>{PERMISSIONS[permission].hint}</div>
            <Button variant="primary" size="lg" disabled={!canStart} onClick={() => void start()}>
              {busy ? "Starting…" : "Start"}
              <Kbd>⌘↵</Kbd>
            </Button>
          </div>
          {error && <div className="form-error">{error}</div>}
        </div>

        <div className="examples">
          {EXAMPLES.map((example) => (
            <button
              key={example.title}
              className="example"
              title={example.prompt}
              onClick={() => {
                setPrompt(example.prompt);
                promptRef.current?.focus();
              }}
            >
              {example.title}
            </button>
          ))}
        </div>
      </div>
      {/* Outside .page, whose children are capped at the column width. */}
      {picking && (
        <FolderPicker
          initialPath={cwd}
          onSelect={(path) => {
            setCwd(path);
            setPicking(false);
          }}
          onClose={() => setPicking(false)}
        />
      )}
    </>
  );
}
