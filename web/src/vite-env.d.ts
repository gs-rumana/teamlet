/// <reference types="vite/client" />

interface Window {
  /** Set by the desktop app (desktop/preload.cjs). */
  teamletDesktop?: { platform: string };
}
