/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** WebSocket base URL of the server, e.g. `ws://127.0.0.1:13773`. */
  readonly VITE_WS_URL: string;
  /** Bootstrap credential exchanged for a `/ws` bearer session in the browser. */
  readonly VITE_BOOTSTRAP_TOKEN: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

// Injected by the desktop preload via contextBridge; absent in a plain
// browser. The inline `import()` type keeps this file a script — a top-level
// import would turn it into a module and the interfaces above would stop
// merging into the global scope.
interface Window {
  readonly desktopBridge?: import("@app/contracts").DesktopBridge;
}
