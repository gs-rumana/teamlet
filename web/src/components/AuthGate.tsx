import { useState } from "react";
import { Lock } from "lucide-react";
import { TeamletMark } from "./Logo.tsx";
import { api } from "../store.ts";
import { Button } from "./ui.tsx";

export function AuthGate() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      await api.login(password);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <div className="auth">
      <form
        className="auth-card"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <TeamletMark size={40} />
        <h1>Teamlet</h1>
        <p className="muted">This workspace is password protected.</p>
        <label className="input-wrap">
          <Lock size={14} className="input-icon" />
          <input type="password" autoFocus autoComplete="current-password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {error && <div className="form-error">{error}</div>}
        <Button variant="primary" size="lg" disabled={!password || busy} type="submit">
          {busy ? "Signing in…" : "Sign in"}
        </Button>
      </form>
    </div>
  );
}
