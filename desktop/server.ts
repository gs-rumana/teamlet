// The desktop app's entry point for the server's utility process. Windows can't deliver SIGTERM
// to it, so the app asks for a clean shutdown with a message, on every platform; the server
// handles it like SIGTERM (stop agents, save history, exit).
process.parentPort.on("message", (event) => {
  if (event.data === "shutdown") process.emit("SIGTERM");
});

await import("../server/index.ts");
