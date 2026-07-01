# AGENTS.md

## Task Completion Requirements

- `pnpm typecheck` must pass before considering a task complete.
- Prefer `pnpm test` (Vitest) for the test suite.

## Project Snapshot

An Effect-TS desktop-app starter. An **Electron shell** (`apps/desktop`) supervises a
local **Node server** (`apps/server`) that serves a **React web renderer** (`apps/web`)
over http/ws. The same web build runs inside the shell OR in a plain browser.

Extracted from the T3 Code architecture. Keep it minimal — this is a starting point,
not a product.

## Core Priorities

1. Performance first.
2. Reliability first — predictable behavior under load and failure (server restarts,
   reconnects, partial streams).
3. When a tradeoff is required, choose correctness and robustness over convenience.

## Architecture Rules (the DNA worth preserving)

- **Pure composition root.** `apps/desktop/src/main.ts` is only `Layer` wiring — no logic.
- **Two-tier service split.** `Electron*` services wrap every raw Electron/Node call in
  `Effect.try` producing a `Schema.TaggedErrorClass`. `Desktop*` services hold logic and
  depend only on the wrappers — never on Electron directly. This is what makes the shell
  testable.
- **Typed boundaries.** `packages/contracts` owns two contracts, schema-only:
  `WsRpcGroup` (renderer↔server, via Effect RPC) and `DesktopBridge` (shell↔renderer, via
  IPC). Malformed data cannot cross either wire.
- **Every effect gets a span.** Use `Effect.withSpan` / `Effect.fn("name")` for
  observability.

## Package Roles

- `apps/server`: Node HTTP + WebSocket (Effect RPC) server. Serves the web app and the
  `/ws` RPC endpoint. Bottoms out at a single `ServerConfig` service.
- `apps/desktop`: Electron shell. Composition root, Electron wrappers, backend supervision,
  typed IPC, settings, updates, observability.
- `apps/web`: React/Vite/Tailwind renderer. Owns UX and client state.
- `packages/contracts`: shared effect/Schema contracts. Schema-only, no runtime logic.
- `packages/client-runtime`: shared client transport (RPC client + reconnect supervisor).
- `packages/shared`: runtime utilities. Explicit subpath exports, no barrel index.
