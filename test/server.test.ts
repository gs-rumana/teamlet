// Boots the real server (server/index.ts) and checks the security boundary from the README:
// origin and CSRF checks, DNS-rebinding protection, and the MCP endpoint.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
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
async function startServer() {
  const home = mkdtempSync(join(tmpdir(), "teamlet-test-"));
  const port = await freePort();
  const child = spawn(process.execPath, [join(ROOT, "server/index.ts")], {
    env: {
      HOME: home,
      USERPROFILE: home,
      PATH: [dirname(process.execPath), ...(process.platform === "win32" ? [] : ["/usr/bin", "/bin"])].join(delimiter),
      // Windows can't start processes without it.
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      TEAMLET_DATA_DIR: join(home, "data"),
      TEAMLET_PORT: String(port),
    },
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
      rmSync(home, { recursive: true, force: true, maxRetries: 5 });
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

describe("server", () => {
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
    await assert.rejects(openSocket(server, { origin: "https://evil.example" }), /HTTP 403/);
    const host = `evil.example:${server.port}`;
    await assert.rejects(openSocket(server, { host, origin: `http://${host}` }), /HTTP 403/);
  });

  test("never serves files from outside dist/", async () => {
    const body = await (await fetch(`${server.url}/..%2fpackage.json`)).text();
    assert.doesNotMatch(body, /"name": "teamlet"/);
  });

  test("validates input", async () => {
    assert.equal((await post(server, "/api/sessions", { prompt: "" })).status, 400);
    assert.equal((await post(server, "/api/fs/mkdir", { parent: "/tmp", name: "../escape" })).status, 400);
  });

  test("hides the MCP endpoint from unknown tokens", async () => {
    assert.equal((await fetch(`${server.url}/mcp/abc123`, { method: "POST" })).status, 404);
  });
});
