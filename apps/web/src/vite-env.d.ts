/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly APP_VERSION: string;
  readonly VITE_HTTP_URL?: string;
  readonly VITE_WS_URL?: string;
}
