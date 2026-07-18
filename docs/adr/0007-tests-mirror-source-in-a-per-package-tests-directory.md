# Tests Mirror Source In A Per-Package tests Directory

Every workspace package keeps implementation under its source tree and unit tests under a sibling `tests/` directory whose paths mirror the source tree: the test for `src/state/connection.ts` lives at `tests/state/connection.test.ts` (for packages without a `src/`, like `scripts`, tests mirror the package root — `lib/public-config.ts` → `tests/lib/public-config.test.ts`). Test-only helpers live under `tests/` as well. This keeps production directories focused on implementation while every test stays one predictable path away from the file it covers.

This decides between the two reference repos, which disagree: T3 Code colocates tests (`src/foo.test.ts`), while the Effect monorepo (vendored under `.repos/effect`) keeps a separate per-package test directory. We take the Effect shape.

One constraint keeps the pattern honest: each package's `tsconfig.json` **must** include `tests/**` alongside `src/**`. With an `src`-only include, `tsc --noEmit` silently skips test files and `pnpm check` stays green while the tests rot — the failure is invisible until `vitest` hits a runtime error.
