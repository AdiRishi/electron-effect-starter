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
