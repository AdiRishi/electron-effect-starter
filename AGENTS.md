# AGENTS.md

## Task Completion Requirements

- `pnpm check` and `pnpm test` must pass before considering tasks completed.

## Project Snapshot

Electron Effect Starter is a starter for Effect v4 desktop apps: an Electron shell supervising a local Effect server (HTTP + WebSocket RPC), with one React web build that runs in the shell and in a plain browser.

## Core Priorities

1. Performance first.
2. Reliability first.
3. Keep behavior predictable under load and during failures (session restarts, reconnects, partial streams).

If a tradeoff is required, choose correctness and robustness over short-term convenience.

## Maintainability

Long term maintainability is a core priority. If you add new functionality, first check if there is shared logic that can be extracted to a separate module. Duplicate logic across multiple files is a code smell and should be avoided. Don't be afraid to change existing code. Don't take shortcuts by just adding local logic to solve a problem.

## Package Roles

- `apps/desktop`: Electron shell. Spawns and supervises the local server, owns windows/menus/updates, and exposes a schema-validated IPC bridge to the renderer.
- `apps/server`: Effect HTTP + WebSocket RPC server. Serves the built web app, handles the bearer-auth exchange, and publishes lifecycle events.
- `apps/web`: React/Vite UI. Connects to the server over WebSocket RPC; the same build runs in the shell and in a plain browser.
- `packages/contracts`: effect/Schema contracts for the WS RPC surface, the IPC bridge, and the auth/bootstrap types. Keep this package schema-only — no runtime logic.
- `packages/shared`: Runtime utilities consumed by multiple apps. Explicit subpath exports (e.g. `@app/shared/Net`) — no barrel index.
- `packages/client-runtime`: Client transport: the connection supervisor and typed RPC client. Subpath exports only (`/connection`, `/rpc`, `/authorization`).
- `scripts`: Repo tooling — dev runner, desktop packaging, reference-repo sync.
- `oxlint-plugin-app`: Custom oxlint rules (Node namespace imports, HostProcess injection, hoisted Schema compilers, @effect/vitest in tests). Wired via `jsPlugins` in `.oxlintrc.json`.

## Vendored Repositories

`.repos/` holds read-only vendored reference repos. See `.repos/AGENTS.md` for more details.

- When writing Effect code, read `.repos/effect-smol/LLMS.md` first and inspect `.repos/effect-smol/` for examples of idiomatic usage, tests, module structure, and API design.
