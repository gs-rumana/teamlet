// Runs before the page in the sandboxed renderer (so it's plain CommonJS, not TypeScript).
// Gives the web UI the few things only the desktop app can do; see `teamletDesktop` in
// web/src/vite-env.d.ts.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("teamletDesktop", {
  platform: process.platform,
  pickFolder: (start) => ipcRenderer.invoke("teamlet:pick-folder", typeof start === "string" ? start : undefined),
  setTheme: (theme) => ipcRenderer.send("teamlet:set-theme", theme),
});
