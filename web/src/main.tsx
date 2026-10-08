import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./theme.ts";
import { App } from "./App.tsx";
import "./styles.css";

// In the desktop app the page draws under the macOS title bar; styles.css makes room for it.
if (window.teamletDesktop) document.documentElement.dataset.desktop = window.teamletDesktop.platform;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
