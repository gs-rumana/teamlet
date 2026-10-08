const RECENT_KEY = "teamlet.recentFolders";

/** Folders recently used for sessions, newest first. */
export function recentFolders(): string[] {
  try {
    return (JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]") as string[]).slice(0, 6);
  } catch {
    return [];
  }
}

export function rememberFolder(path: string) {
  localStorage.setItem(RECENT_KEY, JSON.stringify([path, ...recentFolders().filter((p) => p !== path)].slice(0, 6)));
}
