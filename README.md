# Electron Effect Starter

A starter for desktop apps built on [Effect](https://effect.website) v4. An Electron shell supervises a local Effect HTTP and WebSocket RPC server. One React build runs inside the shell and in a plain browser, so the same app works as a desktop app and as a local web app.

The example feature is a notes list that stays in sync across every connected window and browser.

## Stack

Turborepo with pnpm, TypeScript 7 with the Effect language service, Effect 4, Electron 45, React 19 with the React Compiler, Vite, TanStack Router, Tailwind CSS 4, SQLite through `node:sqlite`, Vitest, oxlint and oxfmt.

## Getting started

pnpm downloads the Node version that `package.json` pins.

```bash
pnpm install
```

Run the server and the web app, then open the pairing URL that the server logs:

```bash
pnpm dev
```

Run the desktop app against the Vite dev server:

```bash
pnpm dev:desktop
```

The dev runner picks a free port pair derived from the checkout path, so several checkouts can run at once. Set `APP_PORT_OFFSET` to choose the offset.

## Scripts

| Script               | What it does                                                                 |
| -------------------- | ---------------------------------------------------------------------------- |
| `pnpm dev`           | Server and web app with hot reload. `dev:server` and `dev:web` run one each. |
| `pnpm dev:desktop`   | Web app and the Electron shell.                                              |
| `pnpm build`         | Builds the web app, the server and the shell.                                |
| `pnpm start:desktop` | Runs the built shell.                                                        |
| `pnpm dist:desktop`  | Packages installers for the current platform into `release/`.                |
| `pnpm check`         | Typecheck, lint and format check.                                            |
| `pnpm test`          | Unit tests, plus browser tests for the web app.                              |
| `pnpm sync:repos`    | Updates the vendored Effect repository in `repos/effect`.                    |

## Layout

| Path                        | Contents                                                            |
| --------------------------- | ------------------------------------------------------------------- |
| `apps/server`               | Effect HTTP and WebSocket RPC server.                               |
| `apps/web`                  | React app.                                                          |
| `apps/desktop`              | Electron shell.                                                     |
| `packages/contracts`        | Schemas for the RPC, HTTP, IPC and bootstrap contracts.             |
| `packages/client-runtime`   | Connection supervisor and typed RPC client.                         |
| `packages/shared`           | Runtime helpers shared by the apps.                                 |
| `tooling/oxlint-plugin-app` | The repository's own lint rules.                                    |
| `tooling/scripts`           | Dev runner and desktop packaging.                                   |
| `tooling/typescript`        | Shared `tsconfig` that every package extends.                       |
| `tooling/vitest`            | Shared Vitest config that every package merges.                     |
| `repos/effect`              | The Effect repository, vendored as reference for people and agents. |

`docs/architecture.md` describes the process model, auth, reconnection and shutdown.

## Running the server on its own

`node apps/server/dist/bin.mjs --help` lists the flags. Each flag has an environment variable: `APP_PORT`, `APP_HOST`, `APP_HOME` (the data directory, default `~/.electron-effect-starter`), `APP_MODE` and `APP_LOG_LEVEL`.

## Releases

Pushing a `v*.*.*` tag runs `.github/workflows/release.yml`, which builds installers on macOS, Windows and Linux and publishes them to a GitHub release. Installed apps update from those releases.

macOS builds are signed and notarized when these repository secrets are set: `CSC_LINK` and `CSC_KEY_PASSWORD` (the Developer ID certificate as base64 `.p12`), and `APPLE_API_KEY` (the `.p8` contents), `APPLE_API_KEY_ID` and `APPLE_API_ISSUER`. Without them the build is unsigned, and macOS auto-update does not work.

## Renaming

The project name appears as `electron-effect-starter` (the package, the URL scheme, the data directory and artifact names), `Electron Effect Starter` (the product name) and `com.example.electron-effect-starter` (the app ID). Replace all three:

```bash
git grep -l -e electron-effect-starter -e "Electron Effect Starter" -- ':!repos' | xargs sed -i '' -e 's/com\.example\.electron-effect-starter/com.acme.my-app/g' -e 's/electron-effect-starter/my-app/g' -e 's/Electron Effect Starter/My App/g'
```

On Linux, use `sed -i` without the empty string. Run `pnpm install` afterwards to refresh the lockfile.
