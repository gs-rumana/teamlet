# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Teamlet: a single-user desktop app (Electron, for macOS, Windows, and Linux) that drives the user's own signed-in `claude` and `codex` CLIs (their subscriptions, never API keys). A **lead** agent gets delegation tools through a local MCP server and splits work across **worker** agents that run in parallel in the same folder. The server only ever listens on `127.0.0.1`; there is no sign-in and no remote mode. `README.md` covers installing, env vars (`TEAMLET_*`), and the security model.

## Commands

```bash
pnpm install
pnpm dev          # server (node --watch, :4317) + Vite UI with HMR (:5173, proxies /api and /ws to :4317)
pnpm typecheck    # tsc --noEmit over server, shared, web/src, desktop
pnpm build        # Vite builds web/ into dist/ (the server serves dist/ when it exists)
pnpm test         # node --test: boots the server and checks its security boundary
pnpm check        # typecheck + build + test
pnpm start        # the built UI in a browser: node server/index.ts
pnpm desktop      # build the UI and open the Electron app
pnpm desktop:dist # package an installer for this OS into release/ (electron-builder.yml)
```

There is no linter. To verify a change, run `pnpm check`. The tests (`test/server.test.ts`, Node's built-in runner) start the real server with a throwaway `HOME` and data dir and check the origin/CSRF rules, DNS-rebinding protection, and the MCP endpoint. `test/util.test.ts` covers the Windows helpers in `server/util.ts`. A change to that boundary needs a test there. Use `node:http` for requests with a forged `Host` header: `fetch()` always sends the real one. CI (`.github/workflows/ci.yml`) runs the checks on Linux (Node 22.18 and 24), Windows, and macOS, and packages the app on all three and checks that it starts its server. To run a server by hand without touching `~/.teamlet`, use `TEAMLET_DATA_DIR=/tmp/teamlet-dev node server/index.ts`.

Releases are cut by pushing a `vX.Y.Z` tag that matches `package.json` and has a `CHANGELOG.md` section. `.github/workflows/release.yml` then builds installers for the three OSes and publishes the GitHub release (see CONTRIBUTING.md → Releasing).

## TypeScript runs without a build step on the server

Node (≥ 22.18) runs `server/*.ts` directly through native type stripping. Only the web UI is bundled. This leads to rules that `tsconfig.json` enforces:

- Relative imports must include the `.ts`/`.tsx` extension (`import { config } from "./config.ts"`).
- Use erasable syntax only (`erasableSyntaxOnly`): no `enum`, no `namespace`, and no constructor parameter properties. Classes declare their fields and assign them in the constructor; follow that pattern.
- Type-only imports must use `import type` (`verbatimModuleSyntax`).
- `pnpm start` runs the server from source too, so server code can't depend on anything that needs compiling.
- The desktop app works the same way: Electron 44's bundled Node strips types too, so `desktop/main.ts` and the server run from source, including from inside the packaged `app.asar`. The exception is `desktop/preload.cjs`: sandboxed preloads aren't loaded through Node, so it stays plain CommonJS.

## Architecture

```
web (React, ClientStore) ──ws /ws + http /api──▶ server/index.ts ──▶ Orchestrator ──▶ ProviderAdapter.run()
                                                                         ▲                 ├─ claude: Agent SDK query()
                                       lead CLI ──http /mcp/<token>── server/mcp.ts         └─ codex: `codex exec --json`
```

**`shared/protocol.ts` is the contract** between server and UI: domain types (`Session`, `Agent`, `TimelineItem`, `ProviderStatus`), the `ServerEvent` union pushed over the WebSocket, and request bodies. Any change to state that the UI shows starts here.

**State flow.** All state lives in memory in `Store` (`server/store.ts`). It is persisted as one JSON file per session under `$TEAMLET_DATA_DIR/sessions/`, with writes debounced 500 ms and committed through an atomic rename. On startup, agents that were `running`/`queued` become `stopped`, because a turn can't resume midway. The `Orchestrator` mutates state only through `updateAgent`/`pushItem`/`touchSession`. Each of those marks the session dirty *and* broadcasts a `ServerEvent`. If you mutate an `Agent` directly, you must do both yourself (see `applyEvent`). A new WebSocket client gets a full `snapshot` and then incremental events. `web/src/store.ts` (`ClientStore`) mirrors the state and batches re-renders into one per animation frame through `useSyncExternalStore`.

**Provider adapters** (`server/providers/`) implement `ProviderAdapter` from `types.ts`. `run()` turns a CLI's output into a small `AgentEvent` stream (`text-delta`, `tool-start`/`tool-end` keyed by `itemId`, `provider-session`, `notice`, `error`). `Orchestrator.applyEvent` turns those events into `TimelineItem`s. The adapters handle each provider differently:
- Lead/worker instructions are defined in `orchestrator.ts` (`leadInstructions`, `WORKER_INSTRUCTIONS`). Claude appends them to the `claude_code` preset system prompt. Codex has no system-prompt flag, so they are prepended to the first prompt only.
- Follow-up turns resume through the provider's own session/thread id (`agent.providerSessionId`).
- `PermissionLevel` maps to Claude's `permissionMode` plus a `canUseTool` callback. `canUseTool` auto-allows the `teamlet` MCP tools, enforces the read-only allowlist, and sends everything else to `requestApproval`, which appears as an approval card in the UI. For Codex it maps to `--sandbox` or `--dangerously-bypass-approvals-and-sandbox`.
- The model (per agent, `setModel`) and the access level (per session, `setPermission`) can change after a session starts. Both are passed again on every turn, and both CLIs honor new values when resuming. A model change is refused while the agent is working. An access change also reaches running turns through `RunInput.onPermissionChange`: Claude switches with `setPermissionMode()` and a `canUseTool` that reads the live level, and pending approvals are answered. Codex can't switch a running `codex exec`, so that turn keeps its sandbox and the timeline notice names the agents still on the old level.
- Model lists come from the CLIs themselves (Claude's `supportedModels()` on a session that never sends a prompt; `codex app-server`'s `model/list` over JSON-RPC). The hardcoded lists are only fallbacks.
- Find CLIs with `which()` and start them with `launch()` (`server/util.ts`), never `spawn(name)` directly. On Windows npm installs CLIs as `.cmd` shims, which Node can only start through `cmd.exe`, and `cmd.exe` mangles arguments with newlines; `which()` returns the shim's target (`claude.exe`, `codex.js`) and `launch()` runs `.js` targets with node. Pass `windowsHide: true`, stop CLIs with `stopProcess()` (on Windows it kills the whole tree; `child.kill()` would orphan codex.exe), and send prompts through stdin (Codex reads `-`). Paths shown in the UI can use `\` as well as `/`.
- Always spawn CLIs with `childEnv()` (`server/util.ts`). It strips the `CLAUDECODE*` variables, so a server started from inside a Claude Code session doesn't make the child CLIs think they're nested.
- Both providers support several accounts, one per config folder (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`). An adapter opts in by implementing `defaultConfigDir()`, and `configFolder()` in `server/util.ts` builds the env for a given folder. The orchestrator then keeps one `ProviderStatus` per account: the default first, followed by the folders the user added, which are saved in `settings.json` in the data dir. Each agent stores its `configDir`, so follow-up turns resume in the same folder. Workers on the lead's provider inherit the lead's account. A CLI's built-in folder (`~/.claude`, `~/.codex`) is reached by unsetting the variable, not by pointing it at that folder. Claude needs this: with the variable set, Claude Code reads `.claude.json` from inside the folder instead of `~/.claude.json`. Codex accounts are labelled by folder name, because the app-server's `account/read` (the only source of the email) takes several seconds. Claude's plan comes from the account profile Claude Code caches in `.claude.json` (`oauthAccount.organizationType` plus the rate-limit tier, e.g. "max 5x"). `claude auth status` and the SDK's `accountInfo()` keep reporting the plan from sign-in time, so an upgrade wouldn't show there.

**Delegation.** Only leads get the MCP attachment. Workers never get one, so delegation is one level deep. Each lead gets a random token, and `/mcp/<token>` only exposes tools for that lead's own workers (`workerOf` checks `parentId`). The MCP endpoint is stateless: every request builds a fresh `McpServer` and transport. Worker concurrency is a semaphore (`acquireWorkerSlot`, capped by `TEAMLET_MAX_PARALLEL`). Leads don't count against it. `wait_for_workers` blocks on `finishWaiters`, which runs whenever any turn ends.

**Desktop app** (`desktop/main.ts`). Electron's main process forks the unchanged server in a `utilityProcess` (through `desktop/server.ts`), waits for `/healthz`, and loads the server's URL in a sandboxed window. Quitting posts `shutdown` to the utility process, which `desktop/server.ts` turns into the server's SIGTERM handler (Windows can't deliver real signals to it). Electron adds nothing to the server, so don't make server code depend on Electron. On macOS and Linux a packaged app copies the login shell's environment first (`loginShellEnv`), because a GUI launch's PATH lacks node and the CLIs. `serverEnv` drops `ELECTRON_RUN_AS_NODE`, which would otherwise reach agents' commands. The preload exposes `window.teamletDesktop`: `platform`, `pickFolder()` (the system folder dialog) and `setTheme()` (syncs `nativeTheme` with the app's theme); main only answers IPC from its own window's page. `web/src/main.tsx` copies the platform to `<html data-desktop>`, and the `desktop app` section of `styles.css` uses it to make room for the macOS traffic lights and to mark drag regions (`-webkit-app-region`). A new element at the top of the window, or an overlay that can cover the headers, must be added to the drag or no-drag lists there, or its buttons will move the window instead of clicking.

**HTTP API** (`server/index.ts`) is a flat `routes` table matched with regexes. It has no framework. Throw `HttpError(status, msg)` to return a non-500 error. Every non-GET `/api/*` request needs an `x-teamlet: 1` header and an allowed `Origin` (CSRF protection). The web `call()` helper in `web/src/store.ts` already sends the header. Every request must also be addressed to a loopback name (`isAllowedHost`), which blocks DNS rebinding.

## Adding a provider

The README says this takes one new file, but the ID is also hardcoded in several places:
- a new adapter in `server/providers/`, registered in the `providers` record in `server/index.ts`
- the `ProviderId` union in `shared/protocol.ts`
- the `z.enum([...])` for `spawn_workers` in `server/mcp.ts`
- the `(claude|codex)` login and config-folder route regexes in `server/index.ts`
- any provider-specific UI in `web/src/components/`

## UI conventions

React 19, no component library. Shared primitives (`Button`, `IconButton`, …) live in `web/src/components/ui.tsx`. Icons come from `lucide-react`. All styling is in `web/src/styles.css`, built on CSS custom-property tokens with `[data-theme="light"|"dark"]` overrides. Use the existing tokens instead of literal colors. The theme is monochrome to match the logo: the text color doubles as the accent, and hue is reserved for errors (`--err`), warnings (`--warn`) and diffs. Providers are told apart by name, not color. Routing is hash-based (`#/s/<sessionId>`).
