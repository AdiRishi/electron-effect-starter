import type {
  ContextMenuItem,
  ContextMenuPosition,
  DesktopAppInfo,
  DesktopServerBootstrap,
  DesktopTheme,
  DesktopUpdateChannel,
  DesktopUpdateState,
  PickFolderOptions,
} from "./desktop.ts";

/** Unsubscribe handle returned by every `on*` event subscription. */
export type Unsubscribe = () => void;

/**
 * The typed contract for `window.desktopBridge`. `preload.ts` implements this
 * with `... satisfies DesktopBridge` (context isolation on), and the renderer
 * consumes the SAME type — so main, preload, and renderer share one contract.
 *
 * Sync methods (`ipcRenderer.sendSync`) return values directly; everything
 * else is `ipcRenderer.invoke` and returns a Promise.
 *
 * ── DESIGN SEAM (bridge surface) ──
 * Add a method here, wire a channel in the desktop `ipc/` layer, implement the
 * preload delegate, and it's typed end-to-end.
 */
export interface DesktopBridge {
  /** Synchronous: static identity read at boot for branding. */
  readonly getAppInfo: () => DesktopAppInfo | null;
  /** Synchronous: where the local server lives (null before it's ready). */
  readonly getServerBootstrap: () => DesktopServerBootstrap | null;

  /** Exchange the bootstrap token for a `/ws` bearer session (async). */
  readonly getBearerToken: () => Promise<string>;

  readonly setTheme: (theme: DesktopTheme) => Promise<void>;
  readonly openExternal: (url: string) => Promise<boolean>;
  readonly confirm: (message: string) => Promise<boolean>;
  readonly pickFolder: (options?: PickFolderOptions) => Promise<string | null>;
  readonly showContextMenu: (
    items: readonly ContextMenuItem[],
    position?: ContextMenuPosition,
  ) => Promise<string | null>;

  readonly getUpdateState: () => Promise<DesktopUpdateState>;
  readonly setUpdateChannel: (channel: DesktopUpdateChannel) => Promise<void>;
  readonly checkForUpdate: () => Promise<void>;
  readonly downloadUpdate: () => Promise<void>;
  readonly installUpdate: () => Promise<void>;
  readonly onUpdateState: (
    listener: (state: DesktopUpdateState) => void,
  ) => Unsubscribe;

  readonly onMenuAction: (listener: (action: string) => void) => Unsubscribe;
}

/**
 * The capability surface the renderer actually programs against. It degrades:
 * in the shell it delegates to `window.desktopBridge`; in a plain browser it
 * uses web fallbacks (`window.open`, `window.confirm`, `localStorage`). This is
 * why the SAME web build runs in both places.
 */
export interface LocalApi {
  readonly isDesktop: boolean;
  readonly setTheme: (theme: DesktopTheme) => Promise<void>;
  readonly openExternal: (url: string) => Promise<void>;
  readonly confirm: (message: string) => Promise<boolean>;
  /** Returns null in the browser (no native folder picker). */
  readonly pickFolder: (options?: PickFolderOptions) => Promise<string | null>;
}

declare global {
  interface Window {
    readonly desktopBridge?: DesktopBridge;
  }
}
