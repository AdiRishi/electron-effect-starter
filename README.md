# Desktop Starter

An opinionated starting point for **Effect-TS desktop apps**, extracted from the
[T3 Code](https://github.com/pingdotgg/t3code) architecture. An Electron shell supervises
a local Node server that serves a React renderer over http/ws — so the _same_ UI runs
inside the desktop shell **or** in a plain browser.

```
Electron shell (apps/desktop)  ──spawns──▶  Local server (apps/server)  ──serves──▶  Web renderer (apps/web)
  main.ts = Layer composition          bin.ts = Effect CLI                React + Vite + Tailwind
  Electron* wrappers (tagged errors)   /ws  = Effect RpcServer            isElectron + localApi fallback
  Desktop* services                    static SPA + readiness gate        @app/client-runtime (RpcClient
  typed IPC (DesktopBridge)            ordered lifecycle push bus          + reconnect supervisor)
        │                                                                        ▲
        └───────────── bootstrap token ─────────▶ bearer session ───────────────┘
```

## Why this exists

Desktop apps are hard to keep testable because the framework (Electron) is a pile of
global side effects. This starter keeps the patterns that solve that:

- **Pure composition root** — `apps/desktop/src/main.ts` is only `Layer` wiring, no logic.
- **Two-tier service split** — `Electron*` services wrap every raw Electron/Node call in
  `Effect.try` + a tagged error; `Desktop*` services hold logic and depend only on the
  wrappers. You test real logic against fake Electron layers.
- **Typed boundaries** — `@app/contracts` owns two schema-only contracts: `WsRpcGroup`
  (renderer↔server, via Effect RPC) and `DesktopBridge` (shell↔renderer, via IPC).
  Malformed data can't cross either wire.
- **Robust lifecycle** — scoped startup/shutdown, graceful `SIGTERM`, readiness gate,
  reconnect supervisor (credential minting lives _inside_ the retry loop, so a cold-start
  outage backs off and recovers instead of freezing), everything traced with spans.

Two shell capabilities are wired end-to-end as working references rather than stubs:
a native **application menu** whose clicks dispatch actions to the renderer, and an
**auto-updater** (`electron-updater`) that streams status to the UI — inert until packaged
and pointed at a feed (see the seam below).

## Layout

| Package                   | Role                                                                                                    |
| ------------------------- | ------------------------------------------------------------------------------------------------------- |
| `apps/desktop`            | Electron shell: composition root, Electron wrappers, backend supervision, typed IPC, settings, updates. |
| `apps/server`             | Node HTTP + WebSocket (Effect RPC) server. Serves the web app + `/ws`.                                  |
| `apps/web`                | React + Vite + Tailwind renderer. Runs in-shell or in a browser.                                        |
| `packages/contracts`      | Schema-only shared contracts (`WsRpcGroup`, `DesktopBridge`, …).                                        |
| `packages/client-runtime` | Shared client transport: `RpcClient` + reconnect supervisor.                                            |
| `packages/shared`         | Runtime utilities (subpath exports, no barrel).                                                         |
| `scripts`                 | `dev-runner` (deterministic ports + parallel dev) and dist tooling.                                     |

## Getting started

```bash
pnpm install
pnpm dev            # server + web; open the printed http://localhost:<port>
pnpm dev:desktop    # server + web + the Electron shell
pnpm typecheck
```

The `dev-runner` derives per-checkout ports, mints one shared bootstrap token, and wires
the environment so the three processes agree (see `scripts/dev-runner.ts`).

The toolchain is deliberately plain: core Vite for browser/server/Electron builds,
Vitest for tests, and `tsc` for typechecking. No Vite Plus.

## The auth handshake

The local server is not open to every process on the machine. The shell mints a random
**bootstrap token**, hands it to the spawned server (env / fd) and to the renderer (over
IPC). The renderer exchanges it at `POST /api/auth/bootstrap/bearer` for a short-lived
**bearer session**, which it presents on the `/ws` upgrade. In browser dev, the
`dev-runner` injects the same token as `VITE_BOOTSTRAP_TOKEN` so the flow is identical.

## Design seams — where you take over

Four spots are intentionally left for you to shape:

1. **Your RPCs** — `packages/contracts/src/rpc.ts` (`DESIGN SEAM #2`). Add a schema, an
   `Rpc.make(...)`, list it in `WsRpcGroup`, then handle it in `apps/server/src/ws.ts`.
   `stream: true` turns any method into a server-push subscription.
2. **Your settings** — `apps/desktop/src/settings/DesktopAppSettings.ts` (`DESIGN SEAM #3`).
   Add fields to the schema; migration + atomic write are already handled.
3. **Your bridge surface** — `packages/contracts/src/ipc.ts` (`DesktopBridge`). Add a method,
   wire a channel in `apps/desktop/src/ipc/`, implement the preload delegate.
4. **Your update feed** — `apps/desktop/src/updates/DesktopUpdater.ts`. The updater is wired
   end-to-end (events → state → renderer, plus check/download/install); drop your published
   `setFeedURL(...)` into `configure` to make packaged builds fetch real releases.

## What was deliberately dropped

From T3 Code: the coding-agent orchestration engine, WSL/SSH/Tailscale remote access,
Clerk auth, the preview browser, terminals, git/VCS, and SQLite persistence. Those are
_product_, not _pattern_. This starter keeps the skeleton.
