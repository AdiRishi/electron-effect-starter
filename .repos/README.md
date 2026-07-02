# Vendored Reference Repositories

This directory vendors external repositories as **read-only reference material** for coding agents and humans. Effect's own guidance for getting agents to write idiomatic Effect code is to point them at the real source; this folder makes that source part of every checkout, pinned to the exact version this workspace installs.

Rules:

- Prefer examples and patterns from the vendored source over generated guesses or web search results.
- **When writing Effect code, read [`effect-smol/LLMS.md`](./effect-smol/LLMS.md) first**, and inspect `effect-smol/` for idiomatic usage, tests, module structure, and API design.
- Do not edit files under `.repos/` — they are synced subtrees, not project code.
- Do not import from `.repos/`; application code imports from normal package dependencies.
- Sync with `pnpm sync:repos` (`--repo <id>` for one repo, `--latest` to track the default branch, `--dry-run` to preview). When bumping a dependency that has a vendored subtree, sync the subtree in the same change so the copy matches the installed version.

| Repo           | Pinned to                                              |
| -------------- | ------------------------------------------------------ |
| `effect-smol/` | the installed `effect` version (tag `effect@<version>`) |
