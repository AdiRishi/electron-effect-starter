#!/usr/bin/env node
// Vendors read-only reference repositories under `.repos/` as squashed git
// subtrees, pinned to the version of the dependency this workspace installs.
// The vendored copies are reference material only: never edit them, never
// import from them, and re-sync them whenever the pinned dependency is bumped.
//
// Usage:
//   pnpm sync:repos                 sync every configured repo
//   pnpm sync:repos --repo <id>     sync one repo
//   pnpm sync:repos --latest        track the default branch instead of the pin
//   pnpm sync:repos --dry-run       print the git commands without running them
//
// The T3 Code original is an Effect CLI program; this starter keeps it as a
// dependency-free Node script like the other scripts here.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { REFERENCE_REPOS, type ReferenceRepo } from "./lib/reference-repos.ts";

const REPO_ROOT = NodePath.dirname(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)));

// pnpm does not hoist workspace dependencies to the root node_modules, so
// resolve installed packages the way a workspace package would. Contracts is
// the anchor because it depends on `effect` by definition.
const resolveFromContracts = NodeModule.createRequire(
  NodePath.join(REPO_ROOT, "packages/contracts/package.json"),
).resolve;

interface CliOptions {
  readonly repoId: string | undefined;
  readonly latest: boolean;
  readonly dryRun: boolean;
}

function parseCliOptions(argv: ReadonlyArray<string>): CliOptions {
  const repoFlagIndex = argv.indexOf("--repo");
  return {
    repoId: repoFlagIndex !== -1 ? argv[repoFlagIndex + 1] : undefined,
    latest: argv.includes("--latest"),
    dryRun: argv.includes("--dry-run"),
  };
}

function selectRepos(repoId: string | undefined): ReadonlyArray<ReferenceRepo> {
  if (repoId === undefined) {
    return REFERENCE_REPOS;
  }
  const repo = REFERENCE_REPOS.find((candidate) => candidate.id === repoId);
  if (!repo) {
    const expected = REFERENCE_REPOS.map((candidate) => candidate.id).join(", ");
    throw new Error(`Unknown reference repo "${repoId}". Expected one of: ${expected}.`);
  }
  return [repo];
}

/** The exact version of the dependency as installed in the workspace. */
function installedVersion(packageName: string): string {
  const packageJsonPath = resolveFromContracts(`${packageName}/package.json`);
  const parsed = JSON.parse(NodeFS.readFileSync(packageJsonPath, "utf8")) as {
    version?: unknown;
  };
  if (typeof parsed.version !== "string") {
    throw new Error(`Could not read an installed version from ${packageJsonPath}.`);
  }
  return parsed.version;
}

function resolveRef(repo: ReferenceRepo, latest: boolean): string {
  return latest
    ? repo.latestRef
    : `${repo.versionTagPrefix}${installedVersion(repo.installedPackage)}`;
}

function ensureCleanWorkingTree(): void {
  const status = NodeChildProcess.execSync("git status --porcelain", {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  if (status.trim().length > 0) {
    throw new Error(
      "The working tree has uncommitted changes. `git subtree` needs a clean tree — commit or stash first.",
    );
  }
}

function main(): void {
  const options = parseCliOptions(process.argv.slice(2));
  const repos = selectRepos(options.repoId);

  if (!options.dryRun) {
    ensureCleanWorkingTree();
  }

  for (const repo of repos) {
    // `add` creates the subtree; `pull` updates an existing one to the new ref.
    const action = NodeFS.existsSync(NodePath.join(REPO_ROOT, repo.prefix)) ? "pull" : "add";
    const ref = resolveRef(repo, options.latest);
    const args = ["subtree", action, `--prefix=${repo.prefix}`, repo.repository, ref, "--squash"];

    process.stdout.write(`[sync:repos] ${repo.id}: git ${args.join(" ")}\n`);
    if (options.dryRun) {
      continue;
    }

    const result = NodeChildProcess.spawnSync("git", args, {
      cwd: REPO_ROOT,
      stdio: "inherit",
    });
    if (result.status !== 0) {
      throw new Error(`git subtree ${action} failed for "${repo.id}" (exit ${result.status}).`);
    }
  }
}

try {
  main();
} catch (error: unknown) {
  process.stderr.write(
    `[sync:repos] fatal: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
}
