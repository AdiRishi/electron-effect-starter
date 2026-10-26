import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig, mergeConfig } from "vitest/config";

import {
  DEV_PROXIED_ORIGIN_PRESERVING_PREFIXES,
  DEV_PROXIED_PATH_PREFIXES,
} from "@app/shared/devProxy";
import shared from "@app/vitest-config";

const port = Number(process.env.APP_WEB_PORT ?? 5733);
const serverPort = process.env.APP_PORT?.trim();

// Dev is single-origin: Vite proxies the server's paths, so no server URL is baked into the bundle.
const proxy = serverPort
  ? Object.fromEntries(
      DEV_PROXIED_PATH_PREFIXES.map((prefix) => [
        prefix,
        {
          target: `http://127.0.0.1:${serverPort}`,
          ws: prefix === "/ws",
          changeOrigin: !DEV_PROXIED_ORIGIN_PRESERVING_PREFIXES.has(prefix),
        },
      ]),
    )
  : undefined;

export default mergeConfig(
  shared,
  defineConfig({
    plugins: [
      tanstackRouter({ autoCodeSplitting: true }),
      react({ compiler: true }),
      tailwindcss(),
    ],
    resolve: { tsconfigPaths: true },
    server: {
      host: "127.0.0.1",
      port,
      strictPort: true,
      ...(proxy ? { proxy } : {}),
    },
    build: {
      // The server reads the manifest to mark hashed assets as immutable.
      manifest: true,
      sourcemap: true,
    },
    test: {
      projects: [
        {
          extends: true,
          test: {
            name: "unit",
            include: ["tests/**/*.test.{ts,tsx}"],
            exclude: ["tests/**/*.browser.test.{ts,tsx}"],
          },
        },
        {
          extends: true,
          // Pre-bundle what browser tests import so a mid-run dependency discovery cannot reload the page.
          optimizeDeps: {
            include: [
              "vitest/browser",
              "react",
              "react/jsx-dev-runtime",
              "react-dom/client",
              "@tanstack/react-router",
              "@base-ui/react/merge-props",
              "@base-ui/react/use-render",
              "@base-ui/react/input",
              "@base-ui/react/field",
              "@base-ui/react/tooltip",
              "class-variance-authority",
              "tailwind-merge",
              "lucide-react",
            ],
          },
          test: {
            name: "browser",
            include: ["tests/**/*.browser.test.{ts,tsx}"],
            setupFiles: ["./tests/support/browserSetup.ts"],
            browser: {
              enabled: true,
              headless: true,
              provider: playwright(),
              instances: [{ browser: "chromium" }],
              screenshotFailures: false,
              commands: {
                // Playwright's mouse outlives each test, so whatever mounts under its last
                // position starts hovered. tests/support/browserSetup.ts parks it off the page.
                resetPointer: async ({ page }) => {
                  await page.mouse.move(-1, -1);
                },
              },
            },
          },
        },
      ],
    },
  }),
);
