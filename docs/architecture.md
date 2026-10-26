# Architecture

One server, two clients. The server owns all state and logic; the desktop shell and the browser are clients of it over the same HTTP and WebSocket RPC API.

```
Electron main process ── spawns, supervises ──▶ server (Node, ELECTRON_RUN_AS_NODE)
        │                                          ▲          ▲
   IPC bridge                                 WebSocket RPC  WebSocket RPC
        ▼                                          │          │
Electron renderer (React build) ───────────────────┘   browser (same React build)
```

## Server

`apps/server` is an Effect HTTP server. It serves the built web app, the auth endpoints and the WebSocket RPC endpoint at `/ws`. The wire contracts live in `packages/contracts`.

**State directory.** All state sits below a base directory: `--base-dir`, `APP_HOME`, the desktop bootstrap, or `~/.electron-effect-starter`, in that order. The server writes to `userdata/` there, or to `dev/` when it runs behind the Vite dev server, so a dev run never migrates the real database. The directory holds `state.sqlite` (migrations in `src/persistence/migrations/`), the signing secret in `secrets/`, and `server-owner.sqlite`.

**One owner per state directory.** At startup the server takes an exclusive SQLite lock on `server-owner.sqlite`. A second server for the same directory exits with code 78 (`SERVER_EXIT_CODE_STATE_DIR_OWNED`), and the desktop shell stops restarting when it sees that code.

**Streams.** Subscriptions send a snapshot and then live events. `NotesStore` stamps every change with a revision under a semaphore, so a subscriber that filters live events by the snapshot's revision sees each change exactly once.

## Auth

Sessions are stateless HMAC-signed tokens, valid for 30 days. The signing secret is generated once per state directory. Every client ends up with a session, and every WebSocket is authenticated at the upgrade.

**Desktop.** The shell generates a bootstrap token and writes it to the server on file descriptor 3 inside the bootstrap envelope, so it never appears in argv or the environment. The renderer exchanges it at `/oauth/token` for a bearer session, then trades the bearer for a 5-minute WebSocket ticket that it passes as `?wsTicket=`.

**Browser.** In web mode the server logs a one-time pairing URL at startup (`...#token=...`, valid 15 minutes). The page posts the token to `/api/auth/browser-session` and receives an `HttpOnly`, `SameSite=Lax` cookie. Session endpoints accept browser credentials only from the server's own origin or the Vite dev origin.

The server closes a WebSocket when its session expires. The client then re-authenticates.

## Client connection

`packages/client-runtime` holds the only reconnect logic. The `ConnectionSupervisor` owns one RPC session at a time. It retries transient failures with jittered backoff and waits out offline periods. When the app becomes active, it probes the live socket instead of replacing it, so a healthy connection survives sleep and wake. Feature code subscribes through `followSession`, which restarts a stream on every new session, so a feature never handles reconnects itself.

## Desktop shell

`apps/desktop` is the Electron main process, written as Effect layers.

**Backend manager.** `DesktopBackendManager` spawns the bundled server with Electron's own binary (`ELECTRON_RUN_AS_NODE=1`), waits for its HTTP readiness probe, and restarts it after an unexpected exit with a backoff of 500 ms doubling to a 10 s cap. Exit code 78 stops the restarts.

**Shutdown.** `before-quit` is held until the server has stopped. Signals take the same path. If shutdown stalls for 10 seconds, the app exits anyway.

**Renderer.** The window loads the app from a custom scheme (`electron-effect-starter://app`, or `electron-effect-starter-dev://app` in development, which proxies Vite). The scheme serves a strict CSP. The window is sandboxed, permission requests are denied, and the preload exposes a small IPC bridge whose arguments and results are validated against the schemas in `packages/contracts/src/ipc.ts`.

**Updates.** `electron-updater` checks GitHub Releases when the build embeds a publish target (see `scripts/build-desktop-artifact.ts`).

## Build

Workspace packages export raw TypeScript. Vite builds the web app, and `tsdown` bundles the server and the shell into self-contained files with every dependency inlined. The server's build copies the web build into `apps/server/dist/client`. Packaging stages `apps/desktop/dist-electron` and `apps/server/dist` without a `node_modules` tree.
