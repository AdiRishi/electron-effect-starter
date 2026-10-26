# AGENTS.md

This is a starter for Effect v4 desktop apps: an Electron shell supervises a local Effect server, and one React build runs in the shell and in a browser. It uses pnpm workspaces and Turborepo.

## Verify a change

- `pnpm check` (typecheck, lint and format) and `pnpm test` pass.
- A change to the desktop shell or to a build config also needs `pnpm build` and `pnpm --filter @app/desktop smoke-test`.
- To see the app, run `pnpm dev` and open the sign-in URL the server prints. `pnpm dev:desktop` runs the desktop shell.

## Effect

Read `repos/effect/LLMS.md` before writing Effect code. Treat `repos/effect/` as the source of truth for idiomatic usage, tests and API design, and prefer its patterns over guesses or web search. `repos/` holds vendored reference repositories: read them, but never edit or import from them. `pnpm sync:repos` updates them.

## Conventions the code doesn't show

- Tests live in each package's `tests/` directory, mirroring `src/`. A new package includes `tests/**` in its `tsconfig.json`, or its tests stop typechecking.
- A test that opens a real socket uses `it.layer(layer, { excludeTestServices: true })`. Under the default test clock, network timeouts never fire and the test hangs.
- A lint error names its rule, and the rule's file under `tooling/oxlint-plugin-*/rules/` says what it protects. Fix the code it points at. Suppress a rule only at a real boundary, such as an untyped Electron, Node or log value, on that line and with a reason: `// oxlint-disable-next-line <rule> -- <reason>`.

## Design notes

Read the notes for an area before changing it:

- [`apps/server/AGENTS.md`](apps/server/AGENTS.md): state ownership, subscriptions and auth.
- [`apps/desktop/AGENTS.md`](apps/desktop/AGENTS.md): server supervision, shutdown and renderer security.
- [`packages/client-runtime/AGENTS.md`](packages/client-runtime/AGENTS.md): reconnection.
