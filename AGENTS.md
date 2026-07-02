# AGENTS.md

## Task Completion Requirements

- `pnpm typecheck` and `pnpm test` (Vitest) must pass before considering a task complete.
- CI also runs `pnpm fmt:check` (Prettier); run `pnpm fmt` after larger edits.

## Project Snapshot

An Effect-TS desktop-app starter extracted from the T3 Code architecture. An
**Electron shell** (`apps/desktop`) supervises a local **Node server**
(`apps/server`) that serves a **React renderer** (`apps/web`) over http/ws. The
same web build runs inside the shell OR in a plain browser.

Keep it minimal — this is a starting point, not a product.

## Core Priorities

1. Performance first.
2. Reliability first — predictable behavior under load and during failure
   (server restarts, reconnects, partial streams).
3. When a tradeoff is required, choose correctness and robustness over
   convenience.

## Maintainability

If you add functionality, first check whether shared logic can be extracted to
a module. Duplicate logic across files is a code smell. Don't be afraid to
change existing code; don't take shortcuts by adding local logic to patch over
a structural problem. Every line in a starter seeds future projects — trim what
is not used, and wire what is kept end-to-end.

## Architecture Rules (the DNA worth preserving)

- **Pure composition root.** `apps/desktop/src/main.ts` is only `Layer`
  wiring — no logic.
- **Two-tier service split.** `Electron*` services are the only code that
  touches Electron; `Desktop*` services hold the logic and depend only on the
  wrappers. Fallible wrapper operations surface `Schema.TaggedErrorClass`
  errors (structured diagnostics even when the caller `orDie`s); trivial calls
  are plain `Effect.sync`. This split is what makes the shell testable — see
  `DesktopUpdater.test.ts`, which runs the real logic against fake wrappers.
- **Typed boundaries.** `packages/contracts` owns two contracts, schema-only:
  `WsRpcGroup` (renderer↔server, via Effect RPC) and `DesktopBridge`
  (shell↔renderer, via IPC). Malformed data cannot cross either wire.
- **Every effect gets a span.** Use `Effect.withSpan` / `Effect.fn("name")`
  for observability.

## Package Roles

- `apps/server`: Node HTTP + WebSocket (Effect RPC) server. Serves the web app
  and the `/ws` RPC endpoint. Bottoms out at a single `ServerConfig` service.
- `apps/desktop`: Electron shell. Composition root, Electron wrappers, backend
  supervision, typed IPC, settings, updates, observability.
- `apps/web`: React/Vite/Tailwind renderer. Owns UX and client state.
- `packages/contracts`: shared effect/Schema contracts. Schema-only, no runtime
  logic.
- `packages/client-runtime`: shared client transport (RPC client + reconnect
  supervisor).
- `packages/shared`: runtime utilities. Explicit subpath exports, no barrel
  index.
- `scripts`: dependency-free Node scripts (dev runner, packaging).

## Reference Repo

This starter is extracted from [T3 Code](https://github.com/pingdotgg/t3code).
When extending the wrappers, supervision, transport, or readiness code, prefer
the patterns in that repository over invention — several modules here
(`ElectronWindow`, `httpReadiness`, the IPC layer) are deliberate ports of it.
