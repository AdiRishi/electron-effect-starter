# Upstream

This directory is a vendored copy of [anti-slop](https://github.com/dmmulroy/anti-slop) (MIT). The repository owns it now: change rules here when our policy differs.

- Source: `skills/install-anti-slop/assets/anti-slop/` at commit `13909c9e07590f5a85d93c62712259fe14a883f7` (2026-10-13). That bundle matches upstream `src/` without the rule tests.
- Installed with the upstream `install-anti-slop` skill's `scripts/install.mjs`.
- Entry points: `index.ts` (generic rules) and `effect/index.ts` (Effect rules), registered in `oxlint.config.ts`.
- Local additions: `package.json`, so the plugin resolves `@oxlint/plugins` from the workspace catalog, and this file.

To take upstream changes, follow the upstream skill's `references/update.md`. It merges against the commit above.
