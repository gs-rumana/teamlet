<p align="center"><img src="web/public/favicon.svg" width="88" alt="Teamlet logo"></p>

# Teamlet

Use the AI subscriptions you already pay for (Claude Pro/Max, ChatGPT Plus/Pro) as a team. You give a task to a **lead agent**. It splits the work, starts **worker agents that run in parallel**, collects their reports, checks how the pieces fit together, and summarizes.

The design follows [t3code](https://github.com/pingdotgg/t3code). Teamlet doesn't handle API keys or OAuth tokens itself. It drives the official CLIs that are signed in with your subscription, and a local MCP server gives the lead its delegation tools.

## Quick start (local)

Requirements: Node.js ≥ 22.18, pnpm, and at least one provider CLI:

- **Claude**: `npm i -g @anthropic-ai/claude-code`, then `claude auth login --claudeai`
- **Codex**: `npm i -g @openai/codex`, then `codex login` ("Sign in with ChatGPT")

You can also sign in from the app: click a provider under **Subscriptions** in the sidebar.

```bash
pnpm install
pnpm dev                    # API on :4317, UI with hot reload on http://localhost:5173
# or, production build:
pnpm build && pnpm start    # everything on http://localhost:4317
```

Locally the server only listens on `127.0.0.1`, so no password is needed.

### Several accounts

Each CLI keeps its sign-in in a config folder. Claude Code uses `~/.claude` (or `CLAUDE_CONFIG_DIR`), and Codex uses `~/.codex` (or `CODEX_HOME`). To use another account, open the provider under **Subscriptions**, click **Add another account**, and choose its folder (for example `~/.claude-work`). For a brand-new account, create an empty folder in the picker and then sign in. A new Codex folder starts without your `config.toml`, so copy it over if you want the same settings. When a provider has more than one account, the new-task form shows an **Account** picker. The lead and its workers on the same provider all run on the account you pick, and follow-up messages stay on it. Teamlet saves the list in `settings.json` in its data folder. In Docker, keep extra config folders under `/data` so they persist.

## Desktop app (macOS)

The same app in its own window, without a terminal or a browser tab:

```bash
pnpm desktop                # build the UI and open the app (for development)
pnpm desktop:dist           # package release/Teamlet-<version>-<arch>.dmg
```

The desktop app starts its own server on `127.0.0.1` (port 4327 when it's free, so `pnpm dev` can run alongside) and stops it when you quit. If agents are still working, it asks first. It keeps history in the same data folder as `pnpm start` (`~/.teamlet`, or `TEAMLET_DATA_DIR`), so don't run both against one folder at the same time. When you open it from Finder or the Dock, it reads `PATH` and the rest of your login shell's environment, so agents find `node`, `git`, and the provider CLIs just as they would in a terminal. The server's output goes to `~/Library/Logs/Teamlet/server.log` (**Help → Show Server Log**).

`desktop:dist` signs the app with a certificate from your keychain if it finds one. Otherwise it signs ad hoc, which is enough to run it on the Mac that built it. To share the app with others, sign it with a Developer ID and notarize it ([electron-builder docs](https://www.electron.build/docs/mac)).

## Deploy (self-hosted)

Teamlet is a **single-user app you run for yourself**: on a home server, a VPS, or a dev box you reach over Tailscale. Agents run commands on the machine it's deployed to, so treat access to it like SSH access.

### Docker Compose

```bash
cp .env.example .env        # set TEAMLET_PASSWORD, and TEAMLET_WORKSPACE to your projects folder
docker compose up -d --build
```

Open `http://<server>:4317`, sign in with the password, then connect Claude and/or Codex from the sidebar:

- **Codex** signs in with a device code: open the link shown and enter the code.
- **Claude** shows a sign-in link; paste the code it gives you back into the dialog. Or run `claude setup-token` on your own computer and set `CLAUDE_CODE_OAUTH_TOKEN` in `.env`.

| Volume | Holds |
| --- | --- |
| `/data` | Session history, the session-signing secret, and the Claude / Codex sign-ins (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`) |
| `/workspace` | The projects agents work on. Choose folders under `/workspace` in the UI |

The image includes git, ripgrep, python3, and both CLIs. Pin their versions with `--build-arg CLAUDE_CODE_VERSION=… CODEX_VERSION=…`. It runs as a non-root user, has a `/healthz` health check, and stops agents cleanly on `SIGTERM`.

### HTTPS

Put a TLS-terminating proxy in front and set `TEAMLET_TRUST_PROXY=1`. Example with Caddy:

```
teamlet.example.com {
  reverse_proxy localhost:4317
}
```

WebSockets (`/ws`) pass through without extra configuration. Session cookies are marked `Secure` automatically when the proxy reports HTTPS.

### Without Docker

Any host with Node ≥ 22.18 works:

```bash
pnpm install --frozen-lockfile && pnpm build
TEAMLET_HOST=0.0.0.0 TEAMLET_PASSWORD=… pnpm start
```

Use `TEAMLET_HOST=0.0.0.0` (all interfaces) rather than one specific IP. Agents reach the delegation tools over `127.0.0.1`.

### Configuration

| Variable | Default | |
| --- | --- | --- |
| `TEAMLET_PASSWORD` | – | Required whenever the host isn't `127.0.0.1`/`localhost` (the server refuses to start otherwise) |
| `TEAMLET_HOST` | `127.0.0.1` | Interface to listen on (`0.0.0.0` in Docker) |
| `TEAMLET_PORT` / `PORT` | `4317` | |
| `TEAMLET_DATA_DIR` | `~/.teamlet` | Session history, settings, and signing secret |
| `TEAMLET_DEFAULT_CWD` | home folder | Default working folder in the UI |
| `TEAMLET_MAX_PARALLEL` | `6` | Max workers running at once; extra workers queue |
| `TEAMLET_TRUST_PROXY` | off | Trust `X-Forwarded-*` headers. Set this only behind a reverse proxy |
| `TEAMLET_ALLOWED_ORIGINS` | – | Extra browser origins allowed to call the API |
| `TEAMLET_AUTH` | – | `none` disables the password, only for use behind an authenticating proxy (Tailscale, Cloudflare Access) |
| `TEAMLET_SECRET` | random, saved in data dir | Key for signing session cookies |

### Security model

- Every API call and WebSocket needs a signed, HttpOnly, `SameSite=Strict` session cookie once a password is set. After 5 failed sign-ins, that client is locked out for 1 minute.
- Requests from other websites are rejected (origin check plus a required custom header).
- Without a password, the server only answers requests addressed to `localhost` or `127.0.0.1`, so a website can't reach it through DNS rebinding. To use another name for it, add that origin to `TEAMLET_ALLOWED_ORIGINS`.
- The MCP endpoint only accepts direct connections from this machine (`127.0.0.1`). Each lead gets its own random token, so it can only see and control its own workers.
- Permission levels per session: *Read only*, *Edit files* (Claude asks you before running commands; Codex runs them in its `workspace-write` sandbox), *Full access*. In a container, Codex's own sandbox may not be available, so use *Full access* if Codex reports sandbox errors. The container itself is then the boundary. You can change the level from the session header at any time. It applies to every turn that starts afterwards. Claude agents that are working switch immediately; a working Codex agent keeps its level until its turn ends.

## How it works

```
Browser UI ──ws/http──▶ server (Node)
                          ├─ Orchestrator: sessions, agents, worker queue, approvals
                          ├─ Provider adapters
                          │    ├─ Claude → @anthropic-ai/claude-agent-sdk using your `claude` binary
                          │    └─ Codex  → `codex exec --json`
                          └─ MCP server /mcp/<token>  ◀── the lead agent calls these tools
                               list_providers · spawn_workers · wait_for_workers
                               get_worker · message_worker · stop_worker
```

- **Lead**: a normal Claude Code or Codex session with the `teamlet` MCP server attached and extra instructions on how to delegate.
- **Workers**: separate sessions in the same working folder, without delegation tools (one level deep). The lead chooses each worker's provider and model, so a Claude lead can hand a task to Codex.
- **Models** come from each CLI: Claude Code's `supportedModels()` (no prompt is sent, so nothing is used) and `codex app-server`'s `model/list`. The lists reflect your plan and refresh when you click *Refresh*. The lead sees the same list through `list_providers`. The lead's model can be switched from the session header whenever the lead isn't working; its next turn continues the same conversation on the new model.
- **Follow-ups**: you can keep chatting with the lead or message any worker directly from its panel. Conversations resume through the provider's own session ID.

```
shared/protocol.ts          types shared by the server and UI
server/index.ts             HTTP routes, WebSocket, static files, shutdown
server/config.ts            environment configuration and startup safety checks
server/auth.ts              password sign-in and signed session cookies
server/orchestrator.ts      sessions, lead/worker lifecycle, parallel queue, approvals
server/mcp.ts               delegation tools (Streamable HTTP, stateless)
server/login.ts             runs provider sign-in (browser or device code) and streams it to the UI
server/providers/*.ts       Claude and Codex adapters → normalized events
web/src/                    React UI (light/dark, mobile layout)
```

Adding another provider (Gemini CLI, OpenCode, …) means one new file in `server/providers/` that implements `ProviderAdapter`.

## Notes

- Workers share one folder. The lead is told to give each worker a separate set of files, but nothing enforces that.
- Usage counts against your plan's normal limits. Many workers at once can hit rate limits sooner.
- **Use your own subscription, for yourself.** Don't host this for other people on your subscription, and don't build a multi-user service on top of it without checking each provider's terms. Anthropic, for example, doesn't allow third-party products to offer claude.ai login without approval.
