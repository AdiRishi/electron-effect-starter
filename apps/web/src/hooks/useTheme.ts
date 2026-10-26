import { useSyncExternalStore } from "react";

type ThemeAppearance = "light" | "dark";

const MEDIA_QUERY = "(prefers-color-scheme: dark)";

let listeners: Array<() => void> = [];
let lastAppliedTheme: ThemeAppearance | null = null;

function emitChange() {
  for (const listener of listeners) listener();
}

function getSystemDark() {
  return window.matchMedia(MEDIA_QUERY).matches;
}

function resolveThemeAppearance(): ThemeAppearance {
  return getSystemDark() ? "dark" : "light";
}

function applyTheme({ suppressTransitions = false } = {}) {
  const resolvedAppearance = resolveThemeAppearance();

  if (lastAppliedTheme === resolvedAppearance) return;

  if (suppressTransitions) {
    document.documentElement.classList.add("no-transitions");
  }

  document.documentElement.classList.toggle("dark", resolvedAppearance === "dark");
  lastAppliedTheme = resolvedAppearance;

  if (suppressTransitions) {
    // Force a reflow so the no-transitions class takes effect before removal
    void document.documentElement.offsetHeight;
    requestAnimationFrame(() => {
      document.documentElement.classList.remove("no-transitions");
    });
  }
}

applyTheme();

function handleSystemAppearanceChange() {
  applyTheme({ suppressTransitions: true });
  emitChange();
}

let removeWindowListeners: (() => void) | null = null;

function subscribe(listener: () => void): () => void {
  listeners.push(listener);

  if (!removeWindowListeners) {
    const mq = window.matchMedia(MEDIA_QUERY);
    mq.addEventListener("change", handleSystemAppearanceChange);
    removeWindowListeners = () => {
      mq.removeEventListener("change", handleSystemAppearanceChange);
    };
  }

  return () => {
    listeners = listeners.filter((l) => l !== listener);

    if (listeners.length === 0) {
      removeWindowListeners?.();
      removeWindowListeners = null;
    }
  };
}

function getServerSnapshot(): ThemeAppearance {
  return "light";
}

/** Follows the operating system's light or dark appearance while a component uses it. */
export function useTheme() {
  const resolvedTheme = useSyncExternalStore(subscribe, resolveThemeAppearance, getServerSnapshot);

  return { resolvedTheme } as const;
}
