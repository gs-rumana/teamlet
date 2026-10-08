import { useEffect, useState } from "react";
import { CircleCheck, ExternalLink, FolderPlus, KeyRound, RefreshCw, SquareTerminal, Trash, X } from "lucide-react";
import type { ProviderId } from "../../../shared/protocol.ts";
import { accountKey, api, useStore } from "../store.ts";
import { FolderPicker } from "./FolderPicker.tsx";
import { accountLabel, Button, CopyButton, IconButton } from "./ui.tsx";

function Command({ command }: { command: string }) {
  return (
    <div className="command">
      <code>{command}</code>
      <CopyButton text={command} />
    </div>
  );
}

const parentFolder = (path: string) => path.slice(0, path.lastIndexOf("/")) || "/";

/** The variable each CLI reads its config folder from. */
const CONFIG_DIR_VARIABLE: Record<ProviderId, string> = { claude: "CLAUDE_CONFIG_DIR", codex: "CODEX_HOME" };

export function ConnectDialog({ providerId, configDir, onClose }: { providerId: ProviderId; configDir?: string; onClose: () => void }) {
  const store = useStore();
  const accounts = store.providers.filter((p) => p.id === providerId);
  const [selected, setSelected] = useState(configDir);
  const provider = accounts.find((p) => p.configDir === selected) ?? accounts[0];
  const login = provider && store.logins.get(accountKey(providerId, provider.configDir));
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [showOutput, setShowOutput] = useState(false);
  const [picking, setPicking] = useState(false);
  const [adding, setAdding] = useState(false);
  const remote = store.server ? !store.server.localOnly : false;

  useEffect(() => {
    // The folder picker closes itself on Escape; don't close this dialog with it.
    if (picking) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, picking]);

  if (!provider) return null;

  const attempt = (action: () => Promise<unknown>) => {
    setError("");
    action().catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };
  const refresh = () => {
    setRefreshing(true);
    attempt(() => api.refreshProviders().finally(() => setRefreshing(false)));
  };
  const submitCode = () => code && attempt(() => api.sendLoginInput(providerId, code, provider.configDir).then(() => setCode("")));
  const addAccount = (path: string) => {
    setPicking(false);
    setAdding(true);
    attempt(() =>
      api
        .addConfigDir(providerId, path)
        .then(() => setSelected(path))
        .finally(() => setAdding(false)),
    );
  };
  const removeAccount = (path: string) => {
    if (confirm(`Stop using the ${provider.name} account in ${path}? The folder and its sign-in are left as they are.`)) {
      attempt(() => api.removeConfigDir(providerId, path));
    }
  };

  return (
    <>
      <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
        <div className="modal" role="dialog" aria-label={`Connect ${provider.name}`}>
          <div className="modal-head">
            <div>
              <h2>{provider.name}</h2>
              <div className="muted small">{provider.subscription}</div>
            </div>
            <IconButton icon={X} label="Close" onClick={onClose} />
          </div>

          {accounts.length > 1 && (
            <div className="account-list" role="radiogroup" aria-label={`${provider.name} accounts`}>
              {accounts.map((account) => (
                <div key={account.configDir} className={`account-row ${account === provider ? "active" : ""}`}>
                  <button role="radio" aria-checked={account === provider} className="account-pick" onClick={() => setSelected(account.configDir)}>
                    <span className="account-text">
                      <span className="account-name">{account.loggedIn ? accountLabel(account) : "Not signed in"}</span>
                      <span className="account-dir">
                        {account.configDir}
                        {account.isDefaultConfigDir && " · default"}
                      </span>
                    </span>
                    {account.loggedIn && account.plan && <span className="provider-state">{account.plan}</span>}
                  </button>
                  {account.configDir && !account.isDefaultConfigDir && (
                    <IconButton icon={Trash} label="Remove account" onClick={() => removeAccount(account.configDir!)} />
                  )}
                </div>
              ))}
            </div>
          )}

          {provider.loggedIn ? (
            <div className="callout ok">
              <CircleCheck size={16} />
              <div>
                Connected{provider.account ? ` as ${provider.account}` : ""}
                {provider.plan ? ` · ${provider.plan}` : ""}
                <div className="small muted">
                  {provider.models.length - 1} models available{provider.version ? ` · CLI ${provider.version}` : ""}
                </div>
                {provider.detail && <div className="small">{provider.detail}</div>}
              </div>
            </div>
          ) : (
            <p className="muted">
              Teamlet uses your {provider.subscription} subscription through the official {provider.name} CLI. You sign in on {provider.name}'s
              own website, and the CLI keeps the credentials. This app never sees them.
            </p>
          )}

          {!provider.installed ? (
            <div className="steps-list">
              <div className="step-row">
                <span className="step-num">1</span>
                <div>
                  Install the {provider.name} CLI on the machine running Teamlet
                  <Command command={provider.installHint} />
                </div>
              </div>
              <div className="step-row">
                <span className="step-num">2</span>
                <div>
                  Check again
                  <div>
                    <Button icon={RefreshCw} onClick={refresh} disabled={refreshing}>
                      {refreshing ? "Checking…" : "I've installed it"}
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <>
              <div className="row wrap">
                <Button
                  variant="primary"
                  icon={KeyRound}
                  onClick={() => attempt(() => api.startLogin(providerId, provider.configDir))}
                  disabled={login?.running}
                >
                  {login?.running ? "Waiting for sign-in…" : provider.loggedIn ? "Sign in again" : `Sign in with ${provider.subscription.split(" /")[0]}`}
                </Button>
                {store.server?.canOpenTerminal && (
                  <Button icon={SquareTerminal} onClick={() => attempt(() => api.loginInTerminal(providerId, provider.configDir))}>
                    Open in Terminal
                  </Button>
                )}
                <Button variant="ghost" icon={RefreshCw} onClick={refresh} disabled={refreshing}>
                  {refreshing ? "Checking…" : "Refresh"}
                </Button>
              </div>

              {login && (
                <div className="login-flow">
                  {login.code && (
                    <div className="device-code">
                      <span className="muted small">Enter this code on the sign-in page</span>
                      <div className="device-code-value">
                        {login.code}
                        <CopyButton text={login.code} />
                      </div>
                    </div>
                  )}
                  {login.urls.length > 0 && login.running && (
                    <a className="btn btn-secondary btn-md" href={login.urls[0]} target="_blank" rel="noreferrer">
                      <ExternalLink size={15} />
                      Open the sign-in page
                    </a>
                  )}
                  {login.running && !login.code && (
                    <div className="row">
                      <span className="input-wrap grow">
                        <input
                          placeholder="Paste the code from the sign-in page, if it shows one"
                          value={code}
                          onChange={(e) => setCode(e.target.value)}
                          onKeyDown={(e) => e.key === "Enter" && submitCode()}
                        />
                      </span>
                      <Button disabled={!code} onClick={submitCode}>
                        Submit
                      </Button>
                    </div>
                  )}
                  {!login.running && login.exitCode === 0 && (
                    <div className="callout ok">
                      <CircleCheck size={16} /> Sign-in finished.
                    </div>
                  )}
                  {!login.running && login.exitCode !== 0 && login.exitCode !== undefined && (
                    <div className="callout warn">The sign-in command stopped (exit code {String(login.exitCode)}). Check its output below.</div>
                  )}
                  <div className="row">
                    {login.output && (
                      <button className="link-btn" onClick={() => setShowOutput(!showOutput)}>
                        {showOutput ? "Hide" : "Show"} CLI output
                      </button>
                    )}
                    {login.running && (
                      <button className="link-btn" onClick={() => attempt(() => api.cancelLogin(providerId, provider.configDir))}>
                        Cancel sign-in
                      </button>
                    )}
                  </div>
                  {showOutput && <pre className="login-output">{login.output}</pre>}
                </div>
              )}

              <details className="manual">
                <summary>Other ways to sign in</summary>
                <p className="muted small">Run this in a terminal on the machine running Teamlet, then click Refresh:</p>
                <Command command={provider.loginCommand} />
                {provider.id === "claude" && remote && (
                  <p className="muted small">
                    On a server you can also run <code>claude setup-token</code> on your own computer and set the token it prints as{" "}
                    <code>CLAUDE_CODE_OAUTH_TOKEN</code> in the server's environment.
                  </p>
                )}
              </details>

              {provider.configDir && (
                <div className="add-account">
                  <button className="link-btn" onClick={() => setPicking(true)} disabled={adding}>
                    <FolderPlus size={13} />
                    {adding ? "Adding account…" : "Add another account"}
                  </button>
                  <span className="muted small">Each account signs in under its own config folder ({CONFIG_DIR_VARIABLE[provider.id]}).</span>
                </div>
              )}
            </>
          )}
          {error && <div className="form-error">{error}</div>}
        </div>
      </div>
      {picking && provider.configDir && (
        <FolderPicker
          initialPath={parentFolder(provider.configDir)}
          initialShowHidden
          recents={false}
          onSelect={addAccount}
          onClose={() => setPicking(false)}
        />
      )}
    </>
  );
}
