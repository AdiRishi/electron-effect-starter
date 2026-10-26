# Desktop shell

The Electron main process, built from Effect layers. It supervises the server and hosts the web build. The backend manager, the shutdown handshake and the IPC bridge are ported from [T3 Code](https://github.com/pingdotgg/t3code)'s desktop app.

- **The server runs as a child process.** The backend manager starts the bundled server with Electron's own binary (`ELECTRON_RUN_AS_NODE=1`). It writes the bootstrap envelope, including the bootstrap token, to fd 3, so the token never appears in argv or the environment. It waits for an HTTP readiness probe, restarts the server after an unexpected exit with a backoff of 500 ms doubling to 10 s, and stops restarting on exit code 78.
- **Quitting waits for the server.** `before-quit` is held until the server has stopped. Process signals take the same path, and if shutdown stalls for 10 seconds the app exits anyway.
- **The renderer is locked down.** It loads from a custom scheme (`electron-effect-starter://app`, or the `-dev` scheme, which proxies Vite) that serves a strict CSP. It runs sandboxed, and permission requests are denied. It reaches the main process only through the preload bridge, and each IPC method decodes its arguments and encodes its result with a schema from `@app/contracts`.
- **Verify a shell change** with `pnpm build` and `pnpm --filter @app/desktop smoke-test`, as well as `pnpm check` and `pnpm test`.
