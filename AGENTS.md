# AGENTS.md

Electron Effect Starter: an Electron shell that supervises a local Effect HTTP and WebSocket RPC server, with one React build that runs in the shell and in a plain browser. Read `docs/architecture.md` before changing auth, the connection supervisor, the backend manager, or shutdown.

## Done means

`pnpm check` and `pnpm test` pass. For a change to the desktop shell or its build, `pnpm build` and `pnpm --filter @app/desktop smoke-test` pass too.

## Effect

- Read `repos/effect/LLMS.md` first, then find the idiom in `repos/effect/packages/` (source and tests). `repos/` is a vendored subtree: read it, never edit it. `pnpm sync:repos` updates it.
- Services are `Context.Service` classes with an inline interface, keyed `@app/<package>/<path>` (for example `@app/server/notes/NotesStore`).
- Service methods and reusable functions are `Effect.fn("Name")`. Errors are `Schema.TaggedError` classes, handled with `catchTags`.
- Use Effect's `FileSystem`, `Path`, `ChildProcess` and `Config`. Where a Node builtin is the right tool, suppress the diagnostic with a reason: `// @effect-diagnostics nodeBuiltinImport:off -- <reason>`.
- The `@effect/tsgo` language service runs inside `tsc`, so its diagnostics fail `pnpm typecheck`.

## Packages

- `packages/contracts`: wire schemas only (RPC, HTTP API, IPC, bootstrap). No runtime logic.
- `packages/shared`: runtime helpers used by more than one app. Subpath exports, no barrel.
- `packages/client-runtime`: the connection supervisor and RPC client, exported as `/connection` and `/rpc`.
- Workspace packages export raw `.ts`. The Turbo `transit` task carries their source into dependents' task hashes.

## Tests

- Tests live in each package's `tests/`, mirroring `src/`: `src/notes/NotesStore.ts` is tested by `tests/notes/NotesStore.test.ts`. A new package extends `@app/tsconfig/base.json`, merges `@app/vitest-config`, and includes `tests/**` in its `tsconfig.json`.
- Write tests with `@effect/vitest` and `TestClock`. Tests that open real sockets use `it.layer(layer, { excludeTestServices: true })`.
- Web component tests are `*.browser.test.tsx` and run in Playwright Chromium.

## Lint rules

`tooling/` holds repo tooling: code that runs on the repository and never ships. Two oxlint plugins are configured in `oxlint.config.ts`: the repo's own rules in `tooling/oxlint-plugin-app/`, and anti-slop in `tooling/oxlint-plugin-anti-slop/`, vendored from upstream with its source recorded in `UPSTREAM.md`. A lint error names the rule; read its file in the plugin's `rules/` directory for what it protects.

Fix the code a rule points at, not the symptom. Where the code sits at a real boundary (an untyped Electron, Node or log value), suppress the rule on that line with a reason: `// oxlint-disable-next-line <rule> -- <reason>`.
