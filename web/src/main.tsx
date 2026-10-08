import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./theme.ts";
import { App } from "./App.tsx";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
