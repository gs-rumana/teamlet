// Boots the real server (server/index.ts) and checks the security boundary from the README:
// origin and CSRF checks, DNS-rebinding protection, password sign-in, and the MCP endpoint.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import WebSocket from "ws";

const ROOT = join(import.meta.dirname, "..");
const VERSION = (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string }).version;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const listener = createServer().once("error", reject);
    listener.listen(0, "127.0.0.1", () => {
      const { port } = listener.address() as AddressInfo;
      listener.close(() => resolve(port));
    });
  });
}

/**
 * Runs the server with a throwaway HOME and data folder and a minimal environment, so it
 * never touches the real ~/.teamlet or a signed-in Claude / Codex account.
 */
function serverEnv(home: string, extra: Record<string, string>): NodeJS.ProcessEnv {
  return { HOME: home, PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, TEAMLET_DATA_DIR: join(home, "data"), ...extra };
}

async function startServer(extra: Record<string, string> = {}) {
  const home = mkdtempSync(join(tmpdir(), "teamlet-test-"));
  const port = await freePort();
  const child = spawn(process.execPath, [join(ROOT, "server/index.ts")], {
    env: serverEnv(home, { TEAMLET_PORT: String(port), ...extra }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => (output += chunk));
  child.stderr.on("data", (chunk: Buffer) => (output += chunk));
  const url = `http://127.0.0.1:${port}`;
  for (const started = Date.now(); ; ) {
    if (child.exitCode !== null) throw new Error(`Server exited early:\n${output}`);
    if (Date.now() - started > 30_000) throw new Error(`Server did not start:\n${output}`);
    try {
      if ((await fetch(`${url}/healthz`)).ok) break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return {
    url,
    port,
    async stop() {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGTERM");
      await exited;
      rmSync(home, { recursive: true, force: true });
    },
  };
}

type Server = Awaited<ReturnType<typeof startServer>>;

const post = (server: Server, path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${server.url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-teamlet": "1", ...headers },
    body: JSON.stringify(body),
  });

/**
 * A request from a DNS-rebinding page: the attacker's host name in both Host and Origin.
 * Goes through node:http because fetch() always sends the real Host header.
 */
function rebound(server: Server, method: string, path: string, body?: unknown): Promise<number> {
  const host = `evil.example:${server.port}`;
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port: server.port,
        method,
        path,
        headers: { host, origin: `http://${host}`, "x-teamlet": "1", "content-type": "application/json" },
      },
      (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      },
    );
    request.once("error", reject);
    request.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

/** Opens /ws and resolves with the first message, or rejects with the HTTP status of a refused upgrade. */
function openSocket(server: Server, headers: Record<string, string>): Promise<{ type: string }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, { headers });
    socket.once("message", (data) => {
      socket.close();
      resolve(JSON.parse(String(data)) as { type: string });
    });
    socket.once("unexpected-response", (_request, response) => reject(new Error(`HTTP ${response.statusCode}`)));
    socket.once("error", reject);
  });
}

describe("local server without a password", () => {
  let server: Server;
  before(async () => {
    server = await startServer();
  });
  after(() => server.stop());

  test("answers health checks with its version", async () => {
    const response = await fetch(`${server.url}/healthz`);
    assert.equal(response.status, 200);
    assert.equal(((await response.json()) as { version: string }).version, VERSION);
  });

  test("serves state to its own pages", async () => {
    const response = await fetch(`${server.url}/api/state`, { headers: { origin: server.url } });
    assert.equal(response.status, 200);
    assert.equal(((await response.json()) as { type: string }).type, "snapshot");
  });

  test("rejects changes without the x-teamlet header", async () => {
    const response = await fetch(`${server.url}/api/sessions`, { method: "POST", body: "{}" });
    assert.equal(response.status, 403);
  });

  test("rejects requests from other websites", async () => {
    const response = await post(server, "/api/fs/mkdir", { parent: "/tmp", name: "x" }, { origin: "https://evil.example" });
    assert.equal(response.status, 403);
  });

  test("rejects DNS-rebinding requests addressed to another host name", async () => {
    assert.equal(await rebound(server, "GET", "/api/state"), 403);
    assert.equal(await rebound(server, "POST", "/api/fs/mkdir", { parent: "/tmp", name: "x" }), 403);
  });

  test("streams state over the WebSocket to its own pages only", async () => {
    assert.equal((await openSocket(server, { origin: server.url })).type, "snapshot");
    await assert.rejects(openSocket(server, { origin: "https://evil.example" }), /HTTP 401/);
    const host = `evil.example:${server.port}`;
    await assert.rejects(openSocket(server, { host, origin: `http://${host}` }), /HTTP 401/);
  });

  test("never serves files from outside dist/", async () => {
    const body = await (await fetch(`${server.url}/..%2fpackage.json`)).text();
    assert.doesNotMatch(body, /"name": "teamlet"/);
  });

  test("validates input", async () => {
    assert.equal((await post(server, "/api/sessions", { prompt: "" })).status, 400);
    assert.equal((await post(server, "/api/fs/mkdir", { parent: "/tmp", name: "../escape" })).status, 400);
  });

  test("hides the MCP endpoint from unknown tokens and proxied requests", async () => {
    assert.equal((await fetch(`${server.url}/mcp/abc123`, { method: "POST" })).status, 404);
    const proxied = await fetch(`${server.url}/mcp/abc123`, { method: "POST", headers: { "x-forwarded-for": "203.0.113.7" } });
    assert.equal(proxied.status, 403);
  });
});

describe("server with a password", () => {
  const password = "correct horse battery staple";
  let server: Server;
  before(async () => {
    server = await startServer({ TEAMLET_PASSWORD: password });
  });
  after(() => server.stop());

  test("requires signing in", async () => {
    const status = (await (await fetch(`${server.url}/api/auth`)).json()) as { required: boolean; authenticated: boolean };
    assert.deepEqual(status, { required: true, authenticated: false });
    assert.equal((await fetch(`${server.url}/api/state`)).status, 401);
    await assert.rejects(openSocket(server, { origin: server.url }), /HTTP 401/);
  });

  test("signs in with the password and issues a strict, HttpOnly cookie", async () => {
    const response = await post(server, "/api/auth/login", { password });
    assert.equal(response.status, 200);
    const cookie = response.headers.get("set-cookie") ?? "";
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    const session = cookie.split(";")[0];
    assert.equal((await fetch(`${server.url}/api/state`, { headers: { cookie: session } })).status, 200);
    assert.equal((await openSocket(server, { origin: server.url, cookie: session })).type, "snapshot");

    const forged = session.replace(/.$/, (last) => (last === "A" ? "B" : "A"));
    assert.equal((await fetch(`${server.url}/api/state`, { headers: { cookie: forged } })).status, 401);
  });

  // Runs last: it locks this client out for a minute.
  test("locks a client out after repeated wrong passwords", async () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      assert.equal((await post(server, "/api/auth/login", { password: "wrong" })).status, 401);
    }
    const locked = await post(server, "/api/auth/login", { password });
    assert.equal(locked.status, 401);
    assert.match(((await locked.json()) as { error: string }).error, /Too many attempts/);
  });
});

describe("startup safety", () => {
  test("refuses to listen beyond this machine without a password", async () => {
    const home = mkdtempSync(join(tmpdir(), "teamlet-test-"));
    try {
      const child = spawn(process.execPath, [join(ROOT, "server/index.ts")], {
        env: serverEnv(home, { TEAMLET_HOST: "0.0.0.0", TEAMLET_PORT: String(await freePort()) }),
        stdio: ["ignore", "ignore", "pipe"],
      });
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk));
      const code = await new Promise((resolve) => child.once("exit", resolve));
      assert.equal(code, 1);
      assert.match(stderr, /Refusing to listen/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
