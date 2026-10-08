import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { Agent, ProviderId, Session } from "../shared/protocol.ts";
import { config } from "./config.ts";

const SESSIONS_DIR = join(config.dataDir, "sessions");
const SETTINGS_FILE = join(config.dataDir, "settings.json");

interface SessionFile {
  session: Session;
  agents: Agent[];
}

export interface Settings {
  /** Config folders the user added per provider, one per extra account (e.g. a second Claude login). */
  configDirs: Partial<Record<ProviderId, string[]>>;
}

/** One JSON file per session under ~/.teamlet/sessions, plus settings.json. */
export class Store {
  readonly sessions = new Map<string, Session>();
  readonly agents = new Map<string, Agent>();
  readonly settings: Settings = { configDirs: {} };
  private dirty = new Set<string>();
  private timer: NodeJS.Timeout | undefined;

  constructor() {
    try {
      Object.assign(this.settings, JSON.parse(readFileSync(SETTINGS_FILE, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.warn("Ignoring unreadable settings.json:", error);
    }
    mkdirSync(SESSIONS_DIR, { recursive: true });
    for (const file of readdirSync(SESSIONS_DIR)) {
      if (!file.endsWith(".json")) continue;
      try {
        const data = JSON.parse(readFileSync(join(SESSIONS_DIR, file), "utf8")) as SessionFile;
        this.sessions.set(data.session.id, data.session);
        for (const agent of data.agents) {
          // Anything mid-flight when the server stopped can't be resumed mid-turn.
          if (agent.status === "running" || agent.status === "queued") {
            agent.status = "stopped";
            agent.items.push({ kind: "notice", id: `restart_${Date.now()}`, at: Date.now(), text: "Interrupted: the server restarted." });
          }
          this.agents.set(agent.id, agent);
        }
      } catch (error) {
        console.warn(`Skipping unreadable session file ${file}:`, error);
      }
    }
  }

  markDirty(sessionId: string) {
    this.dirty.add(sessionId);
    this.timer ??= setTimeout(() => this.flush(), 500);
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = undefined;
    for (const sessionId of this.dirty) {
      const session = this.sessions.get(sessionId);
      if (!session) continue;
      const agents = session.agentIds.map((id) => this.agents.get(id)).filter((a): a is Agent => Boolean(a));
      const path = join(SESSIONS_DIR, `${sessionId}.json`);
      writeFileSync(`${path}.tmp`, JSON.stringify({ session, agents } satisfies SessionFile));
      renameSync(`${path}.tmp`, path);
    }
    this.dirty.clear();
  }

  saveSettings() {
    writeFileSync(`${SETTINGS_FILE}.tmp`, JSON.stringify(this.settings, null, 2));
    renameSync(`${SETTINGS_FILE}.tmp`, SETTINGS_FILE);
  }

  delete(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    for (const id of session.agentIds) this.agents.delete(id);
    this.sessions.delete(sessionId);
    this.dirty.delete(sessionId);
    rmSync(join(SESSIONS_DIR, `${sessionId}.json`), { force: true });
  }
}
