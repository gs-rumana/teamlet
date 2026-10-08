import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { IncomingMessage } from "node:http";
import { config } from "./config.ts";

const COOKIE = "teamlet_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_FAILURES = 5;
const LOCKOUT_MS = 60_000;

const sha256 = (value: string) => createHash("sha256").update(value).digest();

/** Signing key, persisted so sessions survive restarts. */
function loadSecret(): Buffer {
  if (process.env.TEAMLET_SECRET) return sha256(process.env.TEAMLET_SECRET);
  const path = join(config.dataDir, "secret");
  if (existsSync(path)) return Buffer.from(readFileSync(path, "utf8").trim(), "hex");
  mkdirSync(config.dataDir, { recursive: true });
  const secret = randomBytes(32);
  writeFileSync(path, secret.toString("hex"), { mode: 0o600 });
  return secret;
}

const secret = config.authRequired ? loadSecret() : Buffer.alloc(0);
// Changing the password signs everyone out.
const passwordDigest = config.password ? sha256(config.password).toString("hex") : "";

function sign(expires: number): string {
  return createHmac("sha256", secret).update(`${expires}:${passwordDigest}`).digest("base64url");
}

function readCookie(req: IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return undefined;
}

export function isAuthenticated(req: IncomingMessage): boolean {
  if (!config.authRequired) return true;
  const [expires, signature] = (readCookie(req, COOKIE) ?? "").split(".");
  const expiresAt = Number(expires);
  if (!signature || !Number.isFinite(expiresAt) || expiresAt < Date.now()) return false;
  const expected = Buffer.from(sign(expiresAt));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

const isHttps = (req: IncomingMessage) =>
  (config.trustProxy && req.headers["x-forwarded-proto"] === "https") || Boolean((req.socket as { encrypted?: boolean }).encrypted);

function clientAddress(req: IncomingMessage): string {
  const forwarded = config.trustProxy ? (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0].trim() : undefined;
  return forwarded || req.socket.remoteAddress || "unknown";
}

function sessionCookie(req: IncomingMessage, value: string, maxAgeSeconds: number) {
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${isHttps(req) ? "; Secure" : ""}`;
}

const failures = new Map<string, { count: number; lockedUntil: number }>();

/** Returns a Set-Cookie header on success. Throws a message suitable for the UI on failure. */
export function login(req: IncomingMessage, password: string): string {
  const client = clientAddress(req);
  const record = failures.get(client);
  if (record && record.lockedUntil > Date.now()) {
    throw new Error(`Too many attempts. Try again in ${Math.ceil((record.lockedUntil - Date.now()) / 1000)}s.`);
  }
  const ok = Boolean(config.password) && timingSafeEqual(sha256(password), sha256(config.password ?? ""));
  if (!ok) {
    const count = (record?.count ?? 0) + 1;
    failures.set(client, { count, lockedUntil: count >= MAX_FAILURES ? Date.now() + LOCKOUT_MS : 0 });
    throw new Error("Wrong password");
  }
  failures.delete(client);
  const expires = Date.now() + SESSION_TTL_MS;
  return sessionCookie(req, `${expires}.${sign(expires)}`, SESSION_TTL_MS / 1000);
}

export function logoutCookie(req: IncomingMessage): string {
  return sessionCookie(req, "", 0);
}
