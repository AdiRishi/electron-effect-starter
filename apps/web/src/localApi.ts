import type { DesktopTheme, LocalApi, PickFolderOptions } from "@app/contracts";

import { isElectron } from "./env.ts";

export const THEME_STORAGE_KEY = "app:theme";

/**
 * The capability surface the renderer programs against. In the shell it
 * delegates to `window.desktopBridge`; in a plain browser it uses web fallbacks
 * (`localStorage`, `window.open`, `window.confirm`). Same web build, both hosts.
 */
function createLocalApi(): LocalApi {
  const bridge =
    typeof window !== "undefined" ? window.desktopBridge : undefined;

  return {
    isDesktop: isElectron,

    setTheme: async (theme: DesktopTheme) => {
      // Persist in the browser so the pre-mount guard in index.html can read it.
      try {
        window.localStorage.setItem(THEME_STORAGE_KEY, theme);
      } catch {
        // Storage may be unavailable (private mode); the shell still gets it.
      }
      if (bridge) {
        await bridge.setTheme(theme);
      }
    },

    openExternal: async (url: string) => {
      if (bridge) {
        const opened = await bridge.openExternal(url);
        if (!opened) throw new Error("Unable to open the link.");
        return;
      }
      window.open(url, "_blank", "noopener,noreferrer");
    },

    confirm: async (message: string) => {
      if (bridge) return bridge.confirm(message);
      return window.confirm(message);
    },

    pickFolder: async (options?: PickFolderOptions) => {
      if (bridge) return bridge.pickFolder(options);
      // No native folder picker in a plain browser.
      return null;
    },

    onMenuAction: (listener) => {
      // Only the shell has a native menu; in a browser this is inert.
      if (bridge) return bridge.onMenuAction(listener);
      return () => {};
    },
  };
}

let cached: LocalApi | undefined;

export function localApi(): LocalApi {
  if (!cached) cached = createLocalApi();
  return cached;
}
