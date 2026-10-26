# Electron Effect Starter

Start your desktop app on [Effect](https://effect.website) v4 with the hard parts already solved.

A serious desktop app needs more than a window. It needs a local backend that starts, restarts and shuts down cleanly, clients that stay connected, authentication, a secure renderer, and installers that update themselves. Each of these takes weeks to get right. This starter has all of them working together, so you begin with your own features.

## What's solved

- **A supervised local server.** The Electron shell runs an Effect HTTP and WebSocket server as a child process, restarts it with backoff if it crashes, and waits for it to stop before quitting.
- **One UI for desktop and browser.** The same React build runs in the desktop window and in any browser on your machine, over typed RPC with live updates.
- **Connections that recover.** Clients reconnect after a server restart or a laptop sleep without your feature code handling it.
- **Security by default.** The renderer is sandboxed behind a strict CSP, IPC is checked against schemas, and every client signs in, browsers included.
- **Releases.** Tagging a version builds installers for macOS, Windows and Linux, and installed apps update from GitHub Releases.
- **Effect everywhere.** The server, the shell and the client share typed errors, services and layers. The Effect source is vendored, so coding agents write idiomatic Effect from day one.

A small notes feature shows where your code goes, from SQLite to the UI. Replace it with your app.

Built with Effect 4, Electron 45, React 19, TypeScript 7, Vite, Tailwind CSS 4, Turborepo, Vitest and oxlint.

## Get started

You need [pnpm](https://pnpm.io). It installs the right Node version for you.

```bash
npx degit AdiRishi/electron-effect-starter my-app
cd my-app
pnpm install
pnpm dev:desktop
```

To run it in a browser instead, use `pnpm dev` and open the sign-in link the server prints.

<details>
<summary>Make it yours</summary>

The name appears as `electron-effect-starter`, `Electron Effect Starter` and the app ID `com.example.electron-effect-starter`. Replace all three before you install:

```bash
grep -rlI --exclude-dir=repos -e electron-effect-starter -e "Electron Effect Starter" . | xargs sed -i '' -e 's/com\.example\.electron-effect-starter/com.acme.my-app/g' -e 's/electron-effect-starter/my-app/g' -e 's/Electron Effect Starter/My App/g'
```

On Linux, use `sed -i` without the empty string.

</details>

## Credits

This starter is heavily inspired by [T3 Code](https://github.com/pingdotgg/t3code). Its architecture comes from T3 Code's desktop app, and its connection supervisor, server supervision, shutdown handling, IPC bridge and session model are ported from T3 Code's source. Thank you to the T3 Code team for building it in the open; this project would not exist without it.
