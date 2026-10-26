// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

import * as HostProcess from "./HostProcess.ts";

const WINDOWS_PATH_DELIMITER = ";";
const POSIX_PATH_DELIMITER = ":";

function canExecuteFile(filePath: string): boolean {
  try {
    NodeFS.accessSync(filePath, NodeFS.constants.X_OK);

    return true;
  } catch {
    return false;
  }
}

export interface CommandAvailabilityOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly extendEnv?: boolean;
}

const WINDOWS_SHELL_META_CHARS = /([()\][%!^"`<>&|;, *?])/g;

// Escape dynamic arguments for both cmd.exe and the target's CommandLineToArgvW parsing.
function escapeWindowsShellArg(arg: string): string {
  let escaped = arg.replace(/(\\*)"/g, '$1$1\\"');
  // Double up trailing backslashes so the closing quote is not escaped away.
  escaped = escaped.replace(/(\\*)$/, "$1$1");
  escaped = `"${escaped}"`;

  return escaped.replace(WINDOWS_SHELL_META_CHARS, "^$1");
}

export interface ResolvedSpawnCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly shell: boolean;
}

export type SpawnExecutableResolver = (
  command: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
) => string | undefined;

function resolveSpawnExecutableWithNode(
  command: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const path = platform === "win32" ? NodePath.win32 : NodePath.posix;
  const windowsPathExtensions = platform === "win32" ? resolveWindowsPathExtensions(env) : [];

  const candidates = resolveCommandCandidates(
    command,
    platform,
    windowsPathExtensions,
    path.extname,
  );

  const isExecutable = (candidate: string) => {
    try {
      if (!NodeFS.statSync(candidate).isFile()) return false;

      if (platform === "win32") {
        return windowsPathExtensions.includes(path.extname(candidate).toUpperCase());
      }

      return canExecuteFile(candidate);
    } catch {
      return false;
    }
  };

  if (command.includes("/") || command.includes("\\")) {
    return candidates.find(isExecutable);
  }

  for (const pathEntry of (readEnvPath(env) ?? "").split(pathDelimiterForPlatform(platform))) {
    const normalizedPathEntry = stripWrappingQuotes(pathEntry.trim());

    if (normalizedPathEntry.length === 0) continue;

    for (const candidate of candidates) {
      const candidatePath = path.join(normalizedPathEntry, candidate);

      if (isExecutable(candidatePath)) return candidatePath;
    }
  }

  return undefined;
}

export const SpawnExecutableResolution = Context.Reference<SpawnExecutableResolver>(
  "@app/shared/shell/SpawnExecutableResolution",
  {
    defaultValue: () => resolveSpawnExecutableWithNode,
  },
);

function stripWrappingQuotes(value: string): string {
  return value.replace(/^"+|"+$/g, "");
}

function pathDelimiterForPlatform(platform: NodeJS.Platform): string {
  return platform === "win32" ? WINDOWS_PATH_DELIMITER : POSIX_PATH_DELIMITER;
}

function readEnvPath(env: NodeJS.ProcessEnv): string | undefined {
  return env.PATH ?? env.Path ?? env.path;
}

function resolvePathEnvironmentVariable(env: NodeJS.ProcessEnv): string {
  return readEnvPath(env) ?? "";
}

function resolveWindowsPathExtensions(env: NodeJS.ProcessEnv): ReadonlyArray<string> {
  const rawValue = env.PATHEXT;
  const fallback = [".COM", ".EXE", ".BAT", ".CMD"];

  if (!rawValue) return fallback;

  const parsed: string[] = [];

  for (const entry of rawValue.split(";")) {
    const trimmed = entry.trim();

    if (trimmed.length === 0) continue;
    parsed.push(trimmed.startsWith(".") ? trimmed.toUpperCase() : `.${trimmed.toUpperCase()}`);
  }

  return parsed.length > 0 ? Array.from(new Set(parsed)) : fallback;
}

function resolveCommandCandidates(
  command: string,
  platform: NodeJS.Platform,
  windowsPathExtensions: ReadonlyArray<string>,
  extname: (path: string) => string,
): ReadonlyArray<string> {
  if (platform !== "win32") return [command];
  const extension = extname(command);
  const normalizedExtension = extension.toUpperCase();

  if (extension.length > 0 && windowsPathExtensions.includes(normalizedExtension)) {
    const commandWithoutExtension = command.slice(0, -extension.length);

    return Array.from(
      new Set([
        command,
        `${commandWithoutExtension}${normalizedExtension}`,
        `${commandWithoutExtension}${normalizedExtension.toLowerCase()}`,
      ]),
    );
  }

  const candidates: string[] = [];

  for (const candidateExtension of windowsPathExtensions) {
    candidates.push(`${command}${candidateExtension}`);
    candidates.push(`${command}${candidateExtension.toLowerCase()}`);
  }

  return Array.from(new Set(candidates));
}

// Explicit paths bypass the cache for new installs; cached misses can otherwise hide binaries for 30 seconds.
const COMMAND_RESOLUTION_CACHE_TTL_NANOS = 30_000_000_000n;
const COMMAND_RESOLUTION_CACHE_MAX_ENTRIES = 512;
const COMMAND_RESOLUTION_CACHE_KEY_SEPARATOR = String.fromCharCode(0);

interface CommandResolutionCacheEntry {
  readonly resolvedPath: string | null;
  readonly expiresAtNanos: bigint;
}

export const CommandResolutionCache = Context.Reference<Map<string, CommandResolutionCacheEntry>>(
  "@app/shared/shell/CommandResolutionCache",
  {
    defaultValue: () => new Map(),
  },
);

// An injected resolver or locator may answer differently for the same search, so its
// entries are kept apart from every other resolver's.
let spawnResolverCacheIdCount = 0;
const spawnResolverCacheIds = new WeakMap<SpawnExecutableResolver | XcodeGitLocator, number>();

function spawnResolverCacheId(resolver: SpawnExecutableResolver | XcodeGitLocator): number {
  const known = spawnResolverCacheIds.get(resolver);

  if (known !== undefined) return known;
  const id = spawnResolverCacheIdCount++;
  spawnResolverCacheIds.set(resolver, id);

  return id;
}

function cacheCommandResolution(
  cache: Map<string, CommandResolutionCacheEntry>,
  cacheKey: string,
  resolvedPath: string | null,
  nowNanos: bigint,
): void {
  if (cache.size >= COMMAND_RESOLUTION_CACHE_MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value;

    if (oldestKey !== undefined) {
      cache.delete(oldestKey);
    }
  }

  cache.set(cacheKey, {
    resolvedPath,
    expiresAtNanos: nowNanos + COMMAND_RESOLUTION_CACHE_TTL_NANOS,
  });
}

// Git 2.56 x64 uses ucrt64; ARM64 uses clangarm64; older x64/32-bit builds use mingw64/mingw32.
const GIT_FOR_WINDOWS_BUILDS = ["ucrt64", "clangarm64", "mingw64", "mingw32"] as const;

function isFileSync(filePath: string): boolean {
  try {
    return NodeFS.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/** Bypass the launcher's extra process and kernel-token leak. Retain it when MSYSTEM is set, or git.exe omits hook/helper PATH entries. */
export function preferGitForWindowsBinary(
  executable: string,
  env: NodeJS.ProcessEnv,
  isFile: (filePath: string) => boolean = isFileSync,
): string {
  if (env.MSYSTEM) return executable;
  const path = NodePath.win32;

  if (path.basename(executable).toLowerCase() !== "git.exe") return executable;
  const launcherDirectory = path.dirname(executable);
  const launcherFolder = path.basename(launcherDirectory).toLowerCase();

  if (launcherFolder !== "cmd" && launcherFolder !== "bin") return executable;
  const installRoot = path.dirname(launcherDirectory);

  for (const build of GIT_FOR_WINDOWS_BUILDS) {
    const candidate = path.join(installRoot, build, "bin", "git.exe");

    if (isFile(candidate)) return candidate;
  }

  return executable;
}

// npm cmd-shim format for native executables.
const NPM_EXECUTABLE_SHIM_PREFIX = [
  "@ECHO off",
  "GOTO start",
  ":find_dp0",
  "SET dp0=%~dp0",
  "EXIT /b",
  ":start",
  "SETLOCAL",
  "CALL :find_dp0",
];

const NPM_EXECUTABLE_SHIM_RUN = /^"%dp0%\\([^"%]+\.exe)" +%\*$/;

function readFileSyncOrUndefined(filePath: string): string | undefined {
  try {
    return NodeFS.readFileSync(filePath, "utf8");
  } catch {
    return undefined;
  }
}

/** Resolve shims that only launch native executables so direct spawning keeps them in libuv's kill-on-close job. */
export function npmShimExecutable(
  shimPath: string,
  readFile: (filePath: string) => string | undefined = readFileSyncOrUndefined,
  isFile: (filePath: string) => boolean = isFileSync,
): string | undefined {
  const path = NodePath.win32;

  if (path.extname(shimPath).toLowerCase() !== ".cmd") return undefined;

  // Match exactly because preserved SET whitespace can select a different file.
  const lines = readFile(shimPath)
    ?.split(/\r?\n/)
    .filter((line) => line.length > 0);

  if (lines?.length !== NPM_EXECUTABLE_SHIM_PREFIX.length + 1) return undefined;

  if (NPM_EXECUTABLE_SHIM_PREFIX.some((expected, index) => lines[index] !== expected)) {
    return undefined;
  }

  const target = NPM_EXECUTABLE_SHIM_RUN.exec(lines.at(-1)!)?.[1];

  if (target === undefined) return undefined;
  const executable = path.join(path.dirname(shimPath), target);

  return isFile(executable) ? executable : undefined;
}

export type XcodeGitLocator = (env: NodeJS.ProcessEnv) => string | undefined;

// xcrun honors DEVELOPER_DIR and the `xcode-select` choice, as the shim does.
function locateXcodeGitWithXcrun(env: NodeJS.ProcessEnv): string | undefined {
  try {
    const located = NodeChildProcess.execFileSync("/usr/bin/xcrun", ["--find", "git"], {
      encoding: "utf8",
      env,
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();

    return NodePath.isAbsolute(located) ? located : undefined;
  } catch {
    return undefined;
  }
}

export const XcodeGitLocation = Context.Reference<XcodeGitLocator>(
  "@app/shared/shell/XcodeGitLocation",
  { defaultValue: () => locateXcodeGitWithXcrun },
);

const MACOS_GIT_SHIM = "/usr/bin/git";

/**
 * Skip the xcrun shim's per-spawn lookup only when git resolves to /usr/bin/git.
 * User-selected git on PATH still wins, children keep PATH, and lookup failures use `git`.
 */
const resolveMacosGit = Effect.fnUntraced(function* (
  env: NodeJS.ProcessEnv,
  resolveExecutable: SpawnExecutableResolver,
) {
  const locateXcodeGit = yield* XcodeGitLocation;
  const cache = yield* CommandResolutionCache;

  const cacheKey = [
    "xcode-git",
    String(spawnResolverCacheId(resolveExecutable)),
    String(spawnResolverCacheId(locateXcodeGit)),
    resolvePathEnvironmentVariable(env),
    env.DEVELOPER_DIR ?? "",
  ].join(COMMAND_RESOLUTION_CACHE_KEY_SEPARATOR);

  const nowNanos = yield* Clock.currentTimeNanos;
  const cached = cache.get(cacheKey);

  // An Xcode update or removal deletes the binary; look again instead of failing the spawn.
  if (
    cached !== undefined &&
    cached.expiresAtNanos > nowNanos &&
    (cached.resolvedPath === null ||
      resolveExecutable(cached.resolvedPath, "darwin", env) !== undefined)
  ) {
    return cached.resolvedPath ?? "git";
  }

  const located =
    resolveExecutable("git", "darwin", env) === MACOS_GIT_SHIM ? locateXcodeGit(env) : undefined;

  const realGit =
    located !== undefined && resolveExecutable(located, "darwin", env) !== undefined
      ? located
      : null;

  cacheCommandResolution(cache, cacheKey, realGit, nowNanos);

  return realGit ?? "git";
});

export interface SpawnCommandOptions extends CommandAvailabilityOptions {
  /** Bypass npm cmd-shims; see npmShimExecutable for process-lifetime semantics. */
  readonly bypassNpmShim?: boolean;
}

export const resolveSpawnCommand = Effect.fnUntraced(function* (
  command: string,
  args: ReadonlyArray<string>,
  options: SpawnCommandOptions = {},
): Effect.fn.Return<ResolvedSpawnCommand> {
  const platform = yield* HostProcess.Platform;
  const isMacosGit = platform === "darwin" && command === "git";

  if (platform !== "win32" && !isMacosGit) {
    return { command, args: [...args], shell: false };
  }

  const hostEnvironment = yield* HostProcess.Environment;

  const env =
    options.env === undefined
      ? hostEnvironment
      : options.extendEnv
        ? { ...hostEnvironment, ...options.env }
        : options.env;

  const resolveExecutable = yield* SpawnExecutableResolution;

  if (isMacosGit) {
    return {
      command: yield* resolveMacosGit(env, resolveExecutable),
      args: [...args],
      shell: false,
    };
  }

  // The scan is synchronous and runs before every child process, so it shares
  // the PATH scan cache above. Explicit paths stay uncached for the same reason,
  // and so do misses: a failed spawn is how providers report "not installed",
  // and that has to clear the moment the binary appears.
  const explicitPath = command.includes("/") || command.includes("\\");
  const cache = yield* CommandResolutionCache;

  const cacheKey = [
    "spawn",
    String(spawnResolverCacheId(resolveExecutable)),
    platform,
    resolvePathEnvironmentVariable(env),
    resolveWindowsPathExtensions(env).join(";"),
    env.MSYSTEM ? "msystem" : "",
    command,
  ].join(COMMAND_RESOLUTION_CACHE_KEY_SEPARATOR);

  const nowNanos = yield* Clock.currentTimeNanos;
  const cached = explicitPath ? undefined : cache.get(cacheKey);
  let resolvedExecutable: string | null;

  if (cached !== undefined && cached.expiresAtNanos > nowNanos) {
    resolvedExecutable = cached.resolvedPath;
  } else {
    const found = resolveExecutable(command, platform, env);
    resolvedExecutable = found === undefined ? null : preferGitForWindowsBinary(found, env);

    if (!explicitPath && resolvedExecutable !== null) {
      cacheCommandResolution(cache, cacheKey, resolvedExecutable, nowNanos);
    }
  }

  const resolvedCommand = resolvedExecutable ?? command;
  const extension = NodePath.win32.extname(resolvedCommand).toLowerCase();

  if (extension !== ".cmd" && extension !== ".bat") {
    return { command: resolvedCommand, args: [...args], shell: false };
  }

  const shimExecutable = options.bypassNpmShim ? npmShimExecutable(resolvedCommand) : undefined;

  if (shimExecutable !== undefined) {
    return { command: shimExecutable, args: [...args], shell: false };
  }

  // Build the escaped command line without separate args to avoid Node DEP0190 with shell:true.
  return {
    command: [resolvedCommand, ...args].map(escapeWindowsShellArg).join(" "),
    args: [],
    shell: true,
  };
});
