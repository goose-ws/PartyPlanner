import { useEffect, useState } from "react";

export type Theme = "light" | "dark";
const STORAGE_KEY = "pp-theme";

function systemPrefersDark(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches;
}

function readSavedTheme(): Theme | null {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved === "light" || saved === "dark" ? saved : null;
  } catch {
    return null;
  }
}

/**
 * Manual toggle, remembered per-device via localStorage. Until the person
 * picks a theme explicitly, this follows the OS/browser's prefers-color-scheme
 * — index.html's inline script mirrors this same fallback so there's no
 * flash of the wrong theme before React mounts.
 */
export function useTheme(): { theme: Theme; setTheme: (t: Theme) => void; toggle: () => void } {
  const [theme, setThemeState] = useState<Theme>(() => readSavedTheme() ?? (systemPrefersDark() ? "dark" : "light"));

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  // If the person never made an explicit choice, keep following the OS
  // preference live (e.g. their phone switches to dark mode at sunset).
  useEffect(() => {
    if (readSavedTheme() !== null) return;
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (e: MediaQueryListEvent) => setThemeState(e.matches ? "dark" : "light");
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  function setTheme(next: Theme) {
    setThemeState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Private browsing / locked-down storage — the choice just won't persist across reloads.
    }
  }

  function toggle() {
    setTheme(theme === "dark" ? "light" : "dark");
  }

  return { theme, setTheme, toggle };
}
