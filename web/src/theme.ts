import { useEffect, useState } from "react";

export type ThemePreference = "system" | "light" | "dark";

const query = window.matchMedia("(prefers-color-scheme: dark)");

function apply(preference: ThemePreference) {
  const dark = preference === "dark" || (preference === "system" && query.matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? "#111216" : "#f8f8f9");
}

const initial = (localStorage.getItem("teamlet.theme") as ThemePreference | null) ?? "system";
apply(initial);

export function useTheme(): [ThemePreference, (next: ThemePreference) => void] {
  const [preference, setPreference] = useState<ThemePreference>(initial);
  useEffect(() => {
    apply(preference);
    localStorage.setItem("teamlet.theme", preference);
    if (preference !== "system") return;
    const onChange = () => apply("system");
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, [preference]);
  return [preference, setPreference];
}
