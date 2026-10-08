import { execFile } from "node:child_process";
import { createWriteStream, mkdirSync, readFileSync, writeFileSync, type WriteStream } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, screen, session, shell, utilityProcess } from "electron";
import type { IpcMainEvent, IpcMainInvokeEvent, MenuItemConstructorOptions, MessageBoxOptions, Rectangle, UtilityProcess } from "electron";
import type { Snapshot } from "../shared/protocol.ts";

/**
 * Kept stable so the UI's origin, and with it the theme and recent folders it keeps in
 * localStorage, survives restarts. Not 4317, so `pnpm dev` can run alongside the app.
 */
const PREFERRED_PORT = 4327;
const isMac = process.platform === "darwin";

let server: UtilityProcess | undefined;
let serverUrl = "";
/** The server's recent output, shown if it fails. */
let serverOutput = "";
let serverLog: WriteStream | undefined;
let mainWindow: BrowserWindow | undefined;
let quitting = false;

const logFile = () => join(app.getPath("logs"), "server.log");
const windowStateFile = () => join(app.getPath("userData"), "window.json");

const LOADING_PAGE = `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html>
<meta charset="utf-8">
<title>Teamlet</title>
<style>
  html, body { height: 100%; margin: 0; }
  body { display: grid; place-items: center; background: #fff; color: #8b909b; font: 13px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; user-select: none; -webkit-app-region: drag; }
  @media (prefers-color-scheme: dark) { body { background: #0d0e11; color: #6b707c; } }
  p { margin: 0; animation: pulse 1.6s ease-in-out infinite; }
  @keyframes pulse { 50% { opacity: 0.45; } }
</style>
<p>Starting Teamlet…</p>`)}`;

// ------------------------------------------------------------------- environment

/**
 * Apps opened from Finder or the Dock start with launchd's bare environment: none of the
 * PATH entries from the shell profile (node, git, the provider CLIs), no CLAUDE_CONFIG_DIR,
 * proxies, and so on. Read what a login shell sees, so agents run as they would in a terminal.
 */
function loginShellEnv(): Promise<Record<string, string>> {
  const mark = "__TEAMLET_ENV__";
  return new Promise((resolve) => {
    execFile(
      process.env.SHELL || "/bin/zsh",
      ["-ilc", `printf ${mark}; /usr/bin/env -0; printf ${mark}`],
      { timeout: 10_000, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) => {
        // Profile scripts may print their own output (or fail after the env is printed).
        const output = stdout.split(mark)[1];
        if (output === undefined) {
          console.warn("Could not read the login shell's environment:", error?.message);
          return resolve({});
        }
        const env: Record<string, string> = {};
        for (const entry of output.split("\0")) {
          const separator = entry.indexOf("=");
          if (separator > 0) env[entry.slice(0, separator)] = entry.slice(separator + 1);
        }
        for (const name of ["PWD", "OLDPWD", "SHLVL", "_"]) delete env[name];
        resolve(env);
      },
    );
  });
}

function serverEnv(port: number): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, TEAMLET_PORT: String(port) };
  // It would reach every agent's commands and break any Electron app they start (VS Code's `code`, …).
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

// ------------------------------------------------------------------------ server

/** `preferred` if it's free, otherwise any free port. */
function freePort(preferred: number): Promise<number> {
  const probe = (port: number) =>
    new Promise<number>((resolve, reject) => {
      const listener = createServer();
      listener.once("error", reject);
      listener.listen(port, "127.0.0.1", () => {
        const { port: bound } = listener.address() as AddressInfo;
        listener.close(() => resolve(bound));
      });
    });
  return probe(preferred).catch(() => probe(0));
}

/**
 * Runs the regular server (server/index.ts, through desktop/server.ts) in a utility process:
 * Electron's Node strips the types, exactly as `node server/index.ts` does. Resolves with its
 * URL once it answers, or with undefined if it exits first (the exit handler reports that).
 */
async function startServer(): Promise<string | undefined> {
  const port = await freePort(PREFERRED_PORT);
  const url = `http://127.0.0.1:${port}`;
  serverOutput = "";
  const child = utilityProcess.fork(join(import.meta.dirname, "server.ts"), [], {
    cwd: homedir(),
    env: serverEnv(port),
    stdio: "pipe",
    serviceName: "Teamlet server",
  });
  server = child;
  const capture = (chunk: Buffer) => {
    serverLog?.write(chunk);
    serverOutput = (serverOutput + chunk.toString()).slice(-4000);
    if (!app.isPackaged) process.stdout.write(chunk);
  };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);
  child.once("exit", (code) => {
    if (server !== child) return;
    server = undefined;
    if (!quitting) void serverFailed(`The Teamlet server stopped (exit code ${code}).`);
  });

  // It listens once the provider CLIs have reported their status, which takes a few seconds.
  while (server === child) {
    try {
      if ((await fetch(`${url}/healthz`)).ok) return url;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return undefined;
}

async function launch() {
  const url = await startServer();
  if (!url) return;
  serverUrl = url;
  void mainWindow?.loadURL(url);
}

/** A sheet on the window when there is one: an app-modal alert would also block quitting. */
function showMessage(options: MessageBoxOptions) {
  return mainWindow ? dialog.showMessageBox(mainWindow, options) : dialog.showMessageBox(options);
}

async function serverFailed(message: string) {
  const { response } = await showMessage({
    type: "error",
    message,
    detail: serverOutput.trim().split("\n").slice(-12).join("\n") || undefined,
    buttons: ["Restart", "Quit"],
    defaultId: 0,
    cancelId: 1,
  });
  if (response === 0) void launch();
  else app.quit();
}

/** Lets the server stop its agents and save their history (it allows them 5s), then makes sure it's gone. */
function stopServer(): Promise<void> {
  const child = server;
  if (!child) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill();
      resolve();
    }, 8000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.postMessage("shutdown");
  });
}

async function activeAgentCount(): Promise<number> {
  try {
    const { agents } = (await (await fetch(`${serverUrl}/api/state`)).json()) as Snapshot;
    return agents.filter((agent) => agent.status === "running" || agent.status === "queued").length;
  } catch {
    return 0;
  }
}

async function confirmQuit() {
  const active = await activeAgentCount();
  if (active > 0) {
    const { response } = await showMessage({
      type: "warning",
      message: active === 1 ? "An agent is still working" : `${active} agents are still working`,
      detail: "Quitting stops them. You can continue each conversation later with a follow-up message.",
      buttons: ["Quit", "Cancel"],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 1) {
      showWindow();
      return;
    }
  }
  quitting = true;
  await stopServer();
  app.quit();
}

// ------------------------------------------------------------------------ window

interface WindowState {
  bounds: Partial<Rectangle>;
  maximized: boolean;
}

function loadWindowState(): WindowState {
  try {
    const state = JSON.parse(readFileSync(windowStateFile(), "utf8")) as { bounds: Rectangle; maximized: boolean };
    // Ignore a position on a display that's no longer connected.
    const { x, y, width, height } = state.bounds;
    const area = screen.getDisplayMatching(state.bounds).workArea;
    if (x < area.x + area.width && x + width > area.x && y < area.y + area.height && y + height > area.y) return state;
  } catch {}
  return { bounds: { width: 1280, height: 820 }, maximized: false };
}

function saveWindowState(window: BrowserWindow) {
  try {
    writeFileSync(windowStateFile(), JSON.stringify({ bounds: window.getNormalBounds(), maximized: window.isMaximized() }));
  } catch {}
}

function openExternal(url: string) {
  if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
}

function showWindow(): BrowserWindow {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    return mainWindow;
  }
  const saved = loadWindowState();
  const window = new BrowserWindow({
    ...saved.bounds,
    minWidth: 720,
    minHeight: 480,
    show: false,
    title: "Teamlet",
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#0d0e11" : "#ffffff",
    // The web UI makes room for the traffic lights (see [data-desktop] in styles.css).
    ...(isMac ? { titleBarStyle: "hiddenInset" as const, trafficLightPosition: { x: 18, y: 18 } } : { autoHideMenuBar: true }),
    // Windows and macOS take the icon from the app bundle; Linux windows need it set.
    ...(process.platform === "linux" ? { icon: join(import.meta.dirname, "icon.png") } : {}),
    webPreferences: { preload: join(import.meta.dirname, "preload.cjs"), sandbox: true, contextIsolation: true },
  });
  mainWindow = window;
  if (saved.maximized) window.maximize();
  window.once("ready-to-show", () => window.show());
  window.on("close", () => saveWindowState(window));
  window.on("closed", () => (mainWindow = undefined));

  // Sign-in links and links in agent output open in the default browser.
  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (serverUrl && url.startsWith(`${serverUrl}/`)) return;
    event.preventDefault();
    openExternal(url);
  });

  void window.loadURL(serverUrl || LOADING_PAGE);
  return window;
}

/** IPC from the preload, accepted only from the app's own page. */
function fromApp(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  return Boolean(serverUrl) && event.sender === mainWindow?.webContents && Boolean(event.senderFrame?.url.startsWith(`${serverUrl}/`));
}

ipcMain.handle("teamlet:pick-folder", async (event, start: unknown) => {
  if (!fromApp(event) || !mainWindow) return undefined;
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: "Choose a folder for Teamlet to work in",
    properties: ["openDirectory", "createDirectory"],
    ...(typeof start === "string" && start ? { defaultPath: start } : {}),
  });
  return canceled ? undefined : filePaths[0];
});

ipcMain.on("teamlet:set-theme", (event, theme: unknown) => {
  if (fromApp(event) && (theme === "system" || theme === "light" || theme === "dark")) nativeTheme.themeSource = theme;
});

function newTask() {
  const window = showWindow();
  if (serverUrl && window.webContents.getURL().startsWith(serverUrl)) void window.webContents.executeJavaScript(`location.hash = "#/"`);
}

function setMenu() {
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: "appMenu" as const }] : []),
    {
      label: "File",
      submenu: [{ label: "New Task", accelerator: "CmdOrCtrl+N", click: newTask }, { type: "separator" }, isMac ? { role: "close" } : { role: "quit" }],
    },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
    { role: "help", submenu: [{ label: "Show Server Log", click: () => void shell.openPath(logFile()) }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ------------------------------------------------------------------------- start

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => showWindow());
  app.on("window-all-closed", () => {
    if (!isMac) app.quit();
  });
  app.on("before-quit", (event) => {
    if (quitting || !server) return;
    event.preventDefault();
    void confirmQuit();
  });

  // Groups the app's windows and notifications under its installed shortcut.
  if (process.platform === "win32") app.setAppUserModelId("dev.teamlet.app");

  void app.whenReady().then(async () => {
    app.on("activate", () => showWindow());
    // Only copying text out of the page needs a permission.
    session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => callback(permission === "clipboard-sanitized-write"));
    setMenu();
    showWindow();

    mkdirSync(app.getPath("logs"), { recursive: true });
    serverLog = createWriteStream(logFile());
    if (app.isPackaged && process.platform !== "win32") Object.assign(process.env, await loginShellEnv());
    await launch();
  });
}
