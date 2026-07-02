// Configuration for the vendored reference repositories under `.repos/`.
// Each entry pins its subtree to the version of the dependency this workspace
// actually installs, so the vendored source always matches what the code
// compiles against.

export interface ReferenceRepo {
  readonly id: string;
  /** Subtree prefix, relative to the repo root. */
  readonly prefix: string;
  readonly repository: string;
  /** Ref used with `--latest` instead of the pinned version tag. */
  readonly latestRef: string;
  /** Installed package whose version resolves the pinned tag. */
  readonly installedPackage: string;
  /** Tag = `${versionTagPrefix}${installed version}`. */
  readonly versionTagPrefix: string;
}

export const REFERENCE_REPOS: ReadonlyArray<ReferenceRepo> = [
  {
    id: "effect-smol",
    prefix: ".repos/effect-smol",
    repository: "https://github.com/Effect-TS/effect-smol.git",
    latestRef: "main",
    installedPackage: "effect",
    versionTagPrefix: "effect@",
  },
];
