import type { DesktopTheme } from "@app/contracts";
import { useCallback, useSyncExternalStore } from "react";

import { localApi, THEME_STORAGE_KEY } from "../localApi.ts";

const MEDIA_QUERY = "(prefers-color-scheme: dark)";
const DEFAULT_THEME: DesktopTheme = "system";

function readStored(): DesktopTheme {
  if (typeof window === "undefined") return DEFAULT_THEME;
  try {
    const raw = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (raw === "light" || raw === "dark" || raw === "system") return raw;
  } catch {
    // ignore
  }
  return DEFAULT_THEME;
}

function systemDark(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia(MEDIA_QUERY).matches
  );
}

/** Toggle the `.dark` class on <html> to match the effective theme. */
function applyTheme(theme: DesktopTheme): void {
  if (typeof document === "undefined") return;
  const isDark = theme === "dark" || (theme === "system" && systemDark());
  document.documentElement.classList.toggle("dark", isDark);
}

const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  const mq =
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia(MEDIA_QUERY)
      : null;
  const onSystemChange = () => {
    if (readStored() === "system") applyTheme("system");
    onChange();
  };
  mq?.addEventListener("change", onSystemChange);
  return () => {
    listeners.delete(onChange);
    mq?.removeEventListener("change", onSystemChange);
  };
}

function getSnapshot(): DesktopTheme {
  return readStored();
}

/**
 * Theme state wired through `LocalApi.setTheme`, so a change persists to
 * localStorage (browser) AND syncs to the shell (bridge). Returns the stored
 * preference plus the resolved light/dark value the UI can display.
 */
export function useTheme() {
  const theme = useSyncExternalStore(
    subscribe,
    getSnapshot,
    () => DEFAULT_THEME,
  );
  const resolved: "light" | "dark" =
    theme === "system" ? (systemDark() ? "dark" : "light") : theme;

  const setTheme = useCallback((next: DesktopTheme) => {
    void localApi().setTheme(next);
    applyTheme(next);
    emit();
  }, []);

  return { theme, resolvedTheme: resolved, setTheme } as const;
}
