import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { WebSocketServer } from "ws";
import type { CreateSessionRequest, PermissionLevel, ProviderId, ServerEvent, ServerInfo } from "../shared/protocol.ts";
import { assertSafeConfig, config } from "./config.ts";
import { isAuthenticated, login, logoutCookie } from "./auth.ts";
import { HttpError, Orchestrator } from "./orchestrator.ts";
import { handleMcpRequest } from "./mcp.ts";
import { canOpenTerminal, LoginManager } from "./login.ts";
import { createFolder, listFolder, nativeFolderPicker, pickFolderNatively } from "./fs.ts";
import { Store } from "./store.ts";
import { ClaudeProvider } from "./providers/claude.ts";
import { CodexProvider } from "./providers/codex.ts";
import type { ProviderAdapter } from "./providers/types.ts";
import { expandHome } from "./util.ts";

assertSafeConfig();

const ROOT = resolve(import.meta.dirname, "..");
const DIST_DIR = join(ROOT, "dist");
const VERSION = (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string }).version;

const serverInfo: ServerInfo = {
  version: VERSION,
  localOnly: config.localOnly,
  authRequired: config.authRequired,
  canOpenTerminal,
  nativeFolderPicker,
};

const providers: Record<ProviderId, ProviderAdapter> = {
  claude: new ClaudeProvider(),
  codex: new CodexProvider(),
};
const store = new Store();
const orchestrator = new Orchestrator(store, providers, {
  maxParallel: config.maxParallel,
  port: config.port,
  defaultCwd: config.defaultCwd,
});
const logins = new LoginManager(
  providers,
  (event) => broadcast(event),
  () => void orchestrator.refreshProviders(),
);
const snapshot = (): ServerEvent => ({ ...orchestrator.snapshot(), logins: logins.list(), server: serverInfo });

// ------------------------------------------------------------------ websocket

const wss = new WebSocketServer({ noServer: true });
function broadcast(event: ServerEvent) {
  const data = JSON.stringify(event);
  for (const client of wss.clients) if (client.readyState === client.OPEN) client.send(data);
}
orchestrator.subscribe(broadcast);

// ---------------------------------------------------------------------- http

const LOOPBACK_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

/** Only the app's own pages may call the API; other websites must not drive agents. */
function isAllowedOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  if (LOOPBACK_ORIGIN.test(origin) || config.allowedOrigins.includes(origin)) return true;
  try {
    const host = (config.trustProxy && req.headers["x-forwarded-host"]) || req.headers.host;
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/** The MCP endpoint is for agent CLIs on this machine only, never for proxied traffic. */
function isDirectLoopback(req: IncomingMessage): boolean {
  const address = req.socket.remoteAddress ?? "";
  const loopback = address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
  return loopback && !req.headers["x-forwarded-for"];
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 2_000_000) throw new HttpError(413, "Request body too large");
    chunks.push(chunk as Buffer);
  }
  if (!chunks.length) return {} as T;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers }).end(JSON.stringify(body));
}

/** Body of the sign-in routes; `configDir` picks the account and must be one the provider lists. */
async function readLogin(req: IncomingMessage, id: string) {
  const body = await readJson<{ configDir?: string; text?: string }>(req);
  return { ...body, configDir: orchestrator.resolveConfigDir(id as ProviderId, body.configDir) };
}

type Handler = (req: IncomingMessage, params: string[]) => Promise<unknown> | unknown;
const routes: [method: string, pattern: RegExp, handler: Handler][] = [
  ["GET", /^\/api\/state$/, () => snapshot()],
  ["POST", /^\/api\/providers\/refresh$/, () => orchestrator.refreshProviders()],
  [
    "POST",
    /^\/api\/providers\/(claude|codex)\/config-dirs$/,
    async (req, [id]) => orchestrator.addConfigDir(id as ProviderId, (await readJson<{ path?: string }>(req)).path ?? ""),
  ],
  [
    "POST",
    /^\/api\/providers\/(claude|codex)\/config-dirs\/remove$/,
    async (req, [id]) => {
      const { path = "" } = await readJson<{ path?: string }>(req);
      orchestrator.removeConfigDir(id as ProviderId, path);
      logins.cancel(id as ProviderId, path);
    },
  ],
  ["POST", /^\/api\/providers\/(claude|codex)\/login$/, async (req, [id]) => logins.start(id as ProviderId, (await readLogin(req, id)).configDir)],
  [
    "POST",
    /^\/api\/providers\/(claude|codex)\/login\/terminal$/,
    async (req, [id]) => logins.openInTerminal(id as ProviderId, (await readLogin(req, id)).configDir),
  ],
  ["POST", /^\/api\/providers\/(claude|codex)\/login\/cancel$/, async (req, [id]) => logins.cancel(id as ProviderId, (await readLogin(req, id)).configDir)],
  [
    "POST",
    /^\/api\/providers\/(claude|codex)\/login\/input$/,
    async (req, [id]) => {
      const { text = "", configDir } = await readLogin(req, id);
      logins.sendInput(id as ProviderId, text, configDir);
    },
  ],
  ["POST", /^\/api\/sessions$/, async (req) => orchestrator.createSession(await readJson<CreateSessionRequest>(req))],
  ["POST", /^\/api\/sessions\/([\w-]+)\/stop$/, (_req, [id]) => orchestrator.stopSession(id)],
  ["DELETE", /^\/api\/sessions\/([\w-]+)$/, (_req, [id]) => orchestrator.deleteSession(id)],
  [
    "POST",
    /^\/api\/sessions\/([\w-]+)\/permission$/,
    async (req, [id]) => orchestrator.setPermission(id, (await readJson<{ permission: PermissionLevel }>(req)).permission),
  ],
  [
    "POST",
    /^\/api\/agents\/([\w-]+)\/messages$/,
    async (req, [id]) => orchestrator.sendMessage(id, (await readJson<{ text: string }>(req)).text ?? ""),
  ],
  ["POST", /^\/api\/agents\/([\w-]+)\/stop$/, (_req, [id]) => orchestrator.stopAgent(id)],
  [
    "POST",
    /^\/api\/agents\/([\w-]+)\/model$/,
    async (req, [id]) => orchestrator.setModel(id, (await readJson<{ model?: string }>(req)).model ?? ""),
  ],
  [
    "POST",
    /^\/api\/approvals\/([\w-]+)$/,
    async (req, [id]) => orchestrator.resolveApproval(id, Boolean((await readJson<{ allow: boolean }>(req)).allow)),
  ],
  [
    "GET",
    /^\/api\/fs\/check$/,
    (req) => {
      const path = new URL(req.url ?? "", "http://x").searchParams.get("path") ?? "";
      const expanded = expandHome(path.trim());
      return { path: expanded, ok: Boolean(expanded) && existsSync(expanded) && statSync(expanded).isDirectory() };
    },
  ],
  [
    "GET",
    /^\/api\/fs\/list$/,
    (req) => {
      const params = new URL(req.url ?? "", "http://x").searchParams;
      return listFolder(params.get("path"), params.get("hidden") === "1");
    },
  ],
  [
    "POST",
    /^\/api\/fs\/mkdir$/,
    async (req) => {
      const { parent, name } = await readJson<{ parent?: string; name?: string }>(req);
      return createFolder(parent ?? "", name ?? "");
    },
  ],
  ["POST", /^\/api\/fs\/pick-native$/, async (req) => pickFolderNatively((await readJson<{ start?: string }>(req)).start)],
];

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
};

function serveStatic(pathname: string, res: ServerResponse) {
  if (!existsSync(DIST_DIR)) {
    res
      .writeHead(200, { "content-type": "text/plain" })
      .end("Teamlet API is running. Start the UI with `pnpm dev` (http://localhost:5173) or build it with `pnpm build`.");
    return;
  }
  let file = normalize(join(DIST_DIR, decodeURIComponent(pathname)));
  if (!file.startsWith(DIST_DIR) || !existsSync(file) || statSync(file).isDirectory()) file = join(DIST_DIR, "index.html");
  // Vite fingerprints everything under /assets, so it can be cached forever.
  const immutable = file.startsWith(join(DIST_DIR, "assets"));
  res.writeHead(200, {
    "content-type": MIME[extname(file)] ?? "application/octet-stream",
    "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
    "x-content-type-options": "nosniff",
    "referrer-policy": "same-origin",
  });
  createReadStream(file).pipe(res);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  try {
    if (url.pathname === "/healthz") {
      return send(res, 200, { ok: true, version: VERSION, providers: [...new Set(orchestrator.availableProviders().map((p) => p.id))] });
    }

    const mcpMatch = url.pathname.match(/^\/mcp\/([a-f0-9]+)$/);
    if (mcpMatch) {
      if (!isDirectLoopback(req)) return send(res, 403, { error: "Forbidden" });
      return await handleMcpRequest(orchestrator, mcpMatch[1], req, res);
    }

    if (url.pathname.startsWith("/api/")) {
      // A custom header forces a CORS preflight, which this server never approves for other sites.
      if (!isAllowedOrigin(req) || (req.method !== "GET" && req.headers["x-teamlet"] !== "1")) {
        return send(res, 403, { error: "Forbidden" });
      }
      if (url.pathname === "/api/auth" && req.method === "GET") {
        return send(res, 200, { required: config.authRequired, authenticated: isAuthenticated(req) });
      }
      if (url.pathname === "/api/auth/login" && req.method === "POST") {
        const { password } = await readJson<{ password?: string }>(req);
        try {
          return send(res, 200, { ok: true }, { "set-cookie": login(req, password ?? "") });
        } catch (error) {
          return send(res, 401, { error: (error as Error).message });
        }
      }
      if (url.pathname === "/api/auth/logout" && req.method === "POST") {
        return send(res, 200, { ok: true }, { "set-cookie": logoutCookie(req) });
      }
      if (!isAuthenticated(req)) return send(res, 401, { error: "Sign in required" });

      for (const [method, pattern, handler] of routes) {
        const match = url.pathname.match(pattern);
        if (match && req.method === method) return send(res, 200, (await handler(req, match.slice(1))) ?? { ok: true });
      }
      return send(res, 404, { error: "Not found" });
    }
    serveStatic(url.pathname, res);
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    if (status === 500) console.error(error);
    if (!res.headersSent) send(res, status, { error: error instanceof Error ? error.message : String(error) });
  }
});

server.on("upgrade", (req, socket, head) => {
  if (req.url !== "/ws" || !isAllowedOrigin(req) || !isAuthenticated(req)) {
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => ws.send(JSON.stringify(snapshot())));
});

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received, stopping agents…`);
  server.close();
  for (const client of wss.clients) client.close(1001, "Server shutting down");
  await orchestrator.shutdown();
  store.flush();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

await orchestrator.refreshProviders();
server.listen(config.port, config.host, () => {
  const shownHost = config.host === "0.0.0.0" || config.host === "::" ? "localhost" : config.host;
  console.log(`Teamlet ${VERSION} listening on http://${shownHost}:${config.port}${config.authRequired ? " (password required)" : ""}`);
  for (const p of orchestrator.snapshot().providers) {
    const state = p.installed ? (p.loggedIn ? `signed in${p.plan ? ` (${p.plan})` : ""}` : "not signed in") : "not installed";
    console.log(`  ${p.name.padEnd(7)} ${state}${p.isDefaultConfigDir === false ? ` · ${p.configDir}` : ""}`);
  }
});
