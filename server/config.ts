import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const env = process.env;

/**
 * All runtime settings, read once from the environment. The server only ever listens on
 * 127.0.0.1: Teamlet is an app for the computer it runs on, not a network service.
 */
export const config = {
  version: (JSON.parse(readFileSync(join(import.meta.dirname, "../package.json"), "utf8")) as { version: string }).version,
  host: "127.0.0.1",
  port: Number(env.TEAMLET_PORT ?? 4317),
  dataDir: env.TEAMLET_DATA_DIR ?? join(homedir(), ".teamlet"),
  defaultCwd: env.TEAMLET_DEFAULT_CWD ?? homedir(),
  maxParallel: Math.max(1, Number(env.TEAMLET_MAX_PARALLEL ?? 6)),
};
