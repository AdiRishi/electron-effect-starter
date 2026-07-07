# Electron Effect Starter

![Effect](https://img.shields.io/badge/Effect-v4-312E81) ![Electron](https://img.shields.io/badge/Electron-33-47848F?logo=electron&logoColor=white) ![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black) ![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white) ![pnpm](https://img.shields.io/badge/pnpm-11-F69220?logo=pnpm&logoColor=white)

**Everything you need to build a serious desktop app with [Effect](https://effect.website) and Electron.** A shell that supervises a local Effect server, typed RPC and IPC everywhere, and one React build that runs in the shell _and_ in your browser.

## 🤔 Why should I use this?

Most Electron starters give you a window and a bundler, then leave the hard parts to you — process supervision, secure IPC, auth, reconnect logic, packaging landmines. This one ships with the hard parts already solved, as Effect programs end to end.

- ⚡️ **Effect v4 everywhere** — the Electron main process, the server, and the client transport are all Effect programs: Layers, typed errors, scoped cleanup
- 🔒 **Typed wires** — every RPC and IPC message is an `effect/Schema` contract, validated on both sides
- 🛡️ **Secure by default** — sandboxed renderer, context isolation, secrets passed over fd 3 (never argv or env), bearer auth on the WebSocket
- 🔄 **Reconnects that just work** — one supervisor, capped backoff, streams re-attach themselves after every blip
- 🌐 **Develop in the browser** — the same web build runs in the Electron shell and in a plain browser tab with HMR
- 🖥️ **A supervised backend** — the shell health-checks the server before showing a window, and restarts it with backoff if it dies
- 📦 **Packaging solved** — electron-builder wiring with the ESM/CJS and Node-version landmines already defused
- 🤖 **Agent-ready** — `AGENTS.md` conventions and the Effect source vendored in-repo, so coding agents read real code instead of guessing

## ⚡️ Quick start

Requires Node 24 and pnpm 11.

```bash
pnpm install
pnpm dev            # server + web UI in your browser, with HMR
```

```bash
pnpm dev:desktop    # the real Electron shell
pnpm dist:desktop   # build a distributable installer
pnpm check          # typecheck + lint + format
pnpm test           # vitest across every package
```

No `.env` needed — ports are derived per checkout, so multiple clones never collide.

Dependency updates: run [`ncu`](https://www.npmjs.com/package/npm-check-updates) — `.ncurc.json` enables workspace mode, which also checks the `pnpm-workspace.yaml` catalog. It excludes the packages that must move deliberately, not mechanically: the `effect` family (pinned in lockstep to the T3 Code reference; bumping it means re-vendoring `.repos/` via `pnpm sync:repos`), `electron` (majors change the bundled Node and the `node-abi` override), and `@types/node` (tracks the Node major in `engines`, not npm latest).

## 🏗️ How it works

```
┌─────────────────────────────┐    spawns · supervises · restarts    ┌──────────────────────────┐
│  Electron shell             │─────────────────────────────────────▶│  Local Effect server     │
│  apps/desktop               │    bootstrap token over fd 3         │  apps/server             │
│  (an Effect program)        │                                      │  HTTP + WS RPC, loopback │
└──────────────┬──────────────┘                                      └────────────▲─────────────┘
               │  schema-validated IPC bridge                                     │
               ▼                                                                  │
┌─────────────────────────────┐    WebSocket RPC at /ws, bearer-authorized        │
│  Renderer — apps/web        │───────────────────────────────────────────────────┘
│  (same build also runs in   │
│  a plain browser)           │
└─────────────────────────────┘
```

- **The shell owns the server.** It picks the port, spawns the server, probes its health endpoint, and reveals the window only when the backend answers.
- **Trust is minted once.** A per-launch token reaches the server over fd 3, gets exchanged for a bearer, and is checked once — at the WebSocket upgrade.
- **Exactly one thing reconnects.** The connection supervisor is the only retrier; a browser opened before the server starts simply converges on "Connected".
- **One build, two hosts.** Bridge present → shell. Bridge absent → browser fallbacks. Components never branch on the host.

The `docs/` folder has the full story behind every decision.

## 📁 Repo tour

| Path                      | What it is                                                                               |
| ------------------------- | ---------------------------------------------------------------------------------------- |
| `apps/desktop`            | Electron shell: backend supervision, window, menus, updater, IPC bridge                  |
| `apps/server`             | Effect HTTP + WS RPC server; serves the built web app, owns the auth exchange            |
| `apps/web`                | React 19 + Vite + Tailwind UI; a demo card that exercises every RPC                      |
| `packages/contracts`      | Schema-only wire contracts: RPC surface, IPC bridge, auth. No runtime logic              |
| `packages/client-runtime` | Connection supervisor + typed RPC client (`/connection`, `/rpc`, `/authorization`)       |
| `packages/shared`         | Cross-app utilities: port finding, readiness probes, atomic writes. Subpath imports only |
| `scripts`                 | Dev runner, desktop packaging, `.repos` sync — dependency-free where it matters          |
| `docs/adr`                | Six short records of every decision you might otherwise be tempted to revisit            |
| `.repos`                  | Vendored, read-only Effect source for reference — never imported, never edited           |

## ❤️ Built on T3 Code

This starter is distilled from [**T3 Code**](https://github.com/pingdotgg/t3code) — the shell-supervised server, the schema contracts, the connection supervisor, even the tooling choices all trace back to patterns it pioneered. If you want to see them driving a real product, go read that codebase. Huge thanks to the T3 team. 🙏
