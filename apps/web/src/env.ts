import type { DesktopBridge } from "@app/contracts";

declare global {
  interface Window {
    desktopBridge?: DesktopBridge;
  }
}

// The preload script installs the bridge before any web code runs, so module-load detection is reliable.
export const desktopBridge: DesktopBridge | undefined =
  typeof window === "undefined" ? undefined : window.desktopBridge;

export const isElectron = desktopBridge !== undefined;
