// Runs before the page in the sandboxed renderer (so it's plain CommonJS, not TypeScript).
// Tells the web UI it's inside the desktop app, so it can make room for the window controls.
const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld("teamletDesktop", { platform: process.platform });
