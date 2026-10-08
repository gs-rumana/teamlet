/// <reference types="vite/client" />

interface Window {
  /** Set by the desktop app (desktop/preload.cjs). */
  teamletDesktop?: {
    platform: string;
    /** The system's folder dialog. Resolves with the chosen folder, or undefined if cancelled. */
    pickFolder(start?: string): Promise<string | undefined>;
    /** Match the window's title bar and menus to the app's theme. */
    setTheme(theme: "system" | "light" | "dark"): void;
  };
}
