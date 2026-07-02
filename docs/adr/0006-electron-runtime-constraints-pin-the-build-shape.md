# Electron Runtime Constraints Pin The Build Shape

Three facts about the Electron runtime dictate build decisions across _multiple_ configs, and each looks like cleanup bait in isolation:

1. **Electron's main and preload entries must be CommonJS, but Effect v4 is ESM-only** — and CJS cannot `require()` ESM. So the desktop build bundles `effect`/`@effect/*` into `main.cjs`/`preload.cjs`. "Why is everything bundled?" — this. Only `electron` (runtime-injected) and `electron-updater` (CJS with dynamic requires) stay external.
2. **The runtime floor is Electron's bundled Node (20.x), not the workspace's Node 24.** The shell spawns the server bundle via `ELECTRON_RUN_AS_NODE`, so both the desktop entries _and_ `apps/server/dist/bin.mjs` target `node20`, even though development runs on Node 24. Raising either target breaks the packaged app while dev keeps working.
3. **The HTTP client is `FetchHttpClient` (global fetch), never the undici-based Node client** — in both the desktop main and the server. Bundling npm undici into the CJS main crashes Electron at load (`webidl.util.markAsUncloneable is not a function`), and the server child running on Electron's Node hits the same class of failure.

Any change to these ("switch to ESM output", "bump the target, we're on Node 24", "use the real Node HttpClient") must be verified against a **packaged** app — dev mode exercises none of the three constraints.
