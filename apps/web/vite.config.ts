import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const wsUrl = process.env.VITE_WS_URL?.trim() || "ws://127.0.0.1:13773";
const bootstrapToken = process.env.VITE_BOOTSTRAP_TOKEN?.trim() || "";
const port = Number(process.env.PORT ?? 5733);

// The http origin form of the ws URL, used both for the /api proxy target and
// as the browser's `httpBaseUrl` default (see src/env.ts).
function httpTarget(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.protocol = parsed.protocol === "wss:" ? "https:" : "http:";
    parsed.pathname = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return "http://127.0.0.1:13773";
  }
}

const proxyHttpTarget = httpTarget(wsUrl);

export default defineConfig(() => ({
  plugins: [react(), tailwindcss()],
  define: {
    "import.meta.env.VITE_WS_URL": JSON.stringify(wsUrl),
    "import.meta.env.VITE_BOOTSTRAP_TOKEN": JSON.stringify(bootstrapToken),
  },
  server: {
    port,
    strictPort: true,
    proxy: {
      "/api": { target: proxyHttpTarget, changeOrigin: true },
      "/ws": { target: proxyHttpTarget, changeOrigin: true, ws: true },
      "/.well-known": { target: proxyHttpTarget, changeOrigin: true },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
}));
