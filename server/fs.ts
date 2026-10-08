import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { FolderListing } from "../shared/protocol.ts";
import { config } from "./config.ts";
import { HttpError } from "./orchestrator.ts";
import { expandHome } from "./util.ts";

const MAX_ENTRIES = 1000;
// macOS asks for permission when an app looks inside these, so don't peek into them just to draw a badge.
const PRIVACY_PROTECTED = new Set(["Desktop", "Documents", "Downloads", "Library", "Movies", "Music", "Pictures", "Public"]);

/** The native macOS folder dialog, opened with AppleScript. */
export const nativeFolderPicker = process.platform === "darwin";

function fsError(error: unknown, path: string): never {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOENT") throw new HttpError(404, `Folder not found: ${path}`);
  if (code === "EACCES" || code === "EPERM") throw new HttpError(403, `Permission denied: ${path}`);
  if (code === "ENOTDIR") throw new HttpError(400, `Not a folder: ${path}`);
  throw error;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory(); // follows symlinks
  } catch {
    return false;
  }
}

/** Subfolders of a folder on the machine running Teamlet (agents work on this machine's disk). */
export function listFolder(rawPath: string | null, showHidden: boolean): FolderListing {
  const path = expandHome(rawPath?.trim() || config.defaultCwd);
  let names: string[];
  try {
    if (!statSync(path).isDirectory()) throw new HttpError(400, `Not a folder: ${path}`);
    names = readdirSync(path);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    fsError(error, path);
  }
  const folders = names
    .filter((name) => showHidden || !name.startsWith("."))
    .map((name) => ({ name, path: join(path, name) }))
    .filter((entry) => isDirectory(entry.path))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }));
  const parent = dirname(path);
  return {
    path,
    parent: parent === path ? null : parent,
    home: homedir(),
    entries: folders.slice(0, MAX_ENTRIES).map((entry) => ({
      ...entry,
      git: !(path === homedir() && PRIVACY_PROTECTED.has(entry.name)) && existsSync(join(entry.path, ".git")),
    })),
    truncated: folders.length > MAX_ENTRIES,
  };
}

export function createFolder(parent: string, rawName: string): { path: string } {
  const name = rawName.trim();
  if (!name || name === "." || name === ".." || /[/\\\0]/.test(name) || name.length > 255) {
    throw new HttpError(400, "Folder names can't be empty or contain slashes.");
  }
  const base = expandHome(parent);
  if (!isDirectory(base)) throw new HttpError(404, `Folder not found: ${base}`);
  const path = join(base, name);
  if (existsSync(path)) throw new HttpError(409, `"${name}" already exists.`);
  try {
    mkdirSync(path);
  } catch (error) {
    fsError(error, path);
  }
  return { path };
}

/** Opens the macOS "Choose Folder" dialog. Resolves when the user picks or cancels. */
export function pickFolderNatively(start: string | undefined): Promise<{ path?: string; cancelled?: boolean }> {
  if (!nativeFolderPicker) throw new HttpError(400, "The Finder picker is only available on macOS.");
  const from = expandHome(start?.trim() || config.defaultCwd);
  const location = isDirectory(from) ? ` default location (POSIX file ${JSON.stringify(from)})` : "";
  const script = [
    // Bring the dialog to the front instead of opening behind the browser.
    "activate",
    `POSIX path of (choose folder with prompt "Choose a folder for Teamlet to work in"${location})`,
  ];
  return new Promise((resolve, reject) => {
    execFile("osascript", script.flatMap((line) => ["-e", line]), { timeout: 10 * 60 * 1000 }, (error, stdout, stderr) => {
      if (!error) return resolve({ path: stdout.trim().replace(/(.)\/$/, "$1") });
      if (/-128|cancel/i.test(stderr)) return resolve({ cancelled: true });
      reject(new HttpError(500, stderr.trim() || error.message));
    });
  });
}
