import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const env = process.env;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

const host = env.TEAMLET_HOST ?? "127.0.0.1";
const password = env.TEAMLET_PASSWORD?.trim() || undefined;
const authDisabled = env.TEAMLET_AUTH === "none";

/** All runtime settings, read once from the environment. */
export const config = {
  version: (JSON.parse(readFileSync(join(import.meta.dirname, "../package.json"), "utf8")) as { version: string }).version,
  port: Number(env.TEAMLET_PORT ?? env.PORT ?? 4317),
  host,
  /** Bound only to this machine: no other device can reach the server. */
  localOnly: LOOPBACK_HOSTS.has(host),
  password,
  /** A password is enforced whenever one is set. */
  authRequired: Boolean(password) && !authDisabled,
  authDisabled,
  dataDir: env.TEAMLET_DATA_DIR ?? join(homedir(), ".teamlet"),
  defaultCwd: env.TEAMLET_DEFAULT_CWD ?? homedir(),
  maxParallel: Math.max(1, Number(env.TEAMLET_MAX_PARALLEL ?? 6)),
  /** Behind a reverse proxy: trust X-Forwarded-For/-Host/-Proto. Off by default because clients can forge them. */
  trustProxy: env.TEAMLET_TRUST_PROXY === "1" || env.TEAMLET_TRUST_PROXY === "true",
  /** Extra browser origins allowed to call the API (comma separated), e.g. behind a proxy on another host. */
  allowedOrigins: (env.TEAMLET_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
};

/** Refuse to expose agents that can run commands to the network without a password. */
export function assertSafeConfig() {
  if (!config.localOnly && !config.password && !config.authDisabled) {
    console.error(
      `Refusing to listen on ${config.host} without a password: anyone who can reach this port could run commands on this machine.\n` +
        "Set TEAMLET_PASSWORD, or set TEAMLET_AUTH=none if an authenticating proxy (Tailscale, Cloudflare Access, …) already protects it.",
    );
    process.exit(1);
  }
  if (!config.localOnly && config.authDisabled) {
    console.warn(`Warning: listening on ${config.host} with TEAMLET_AUTH=none. Make sure something in front of it authenticates users.`);
  }
}
