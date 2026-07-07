import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { ServerBootstrapEnvelope } from "@app/contracts";
import { waitForHttpReady } from "@app/shared/httpReadiness";
import { NetService } from "@app/shared/Net";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { makeComponentLogger } from "../app/DesktopObservability.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import * as DesktopBackendConfiguration from "./DesktopBackendConfiguration.ts";
import type { DesktopBackendStartConfig } from "./DesktopBackendConfiguration.ts";

// Supervises the single local server child: picks a free port, spawns the
// process, probes HTTP readiness before revealing the window, restarts with
// exponential backoff on unexpected exit, and stops it with SIGTERM + a grace
// window. A `Semaphore(1)` serializes start/stop so overlapping requests can't
// spawn two children.

const INITIAL_RESTART_DELAY = Duration.millis(500);
const MAX_RESTART_DELAY = Duration.seconds(10);
const READINESS_TIMEOUT = Duration.minutes(1);
const READINESS_INTERVAL = Duration.millis(100);
const READINESS_REQUEST_TIMEOUT = Duration.seconds(1);
const TERMINATE_GRACE = Duration.seconds(2);
const HEALTH_PATH = "/.well-known/app/health";

const encodeBootstrapEnvelopeJson = Schema.encodeEffect(
  Schema.fromJsonString(ServerBootstrapEnvelope),
);

export class DesktopBackendReadinessError extends Schema.TaggedErrorClass<DesktopBackendReadinessError>()(
  "DesktopBackendReadinessError",
  {
    url: Schema.String,
  },
) {
  override get message(): string {
    return `Timed out waiting for backend readiness at ${this.url}.`;
  }
}

export class DesktopBackendBootstrapEncodeError extends Schema.TaggedErrorClass<DesktopBackendBootstrapEncodeError>()(
  "DesktopBackendBootstrapEncodeError",
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Failed to encode the backend bootstrap envelope.";
  }
}

interface DesktopBackendReadyCallbacks {
  readonly onReady: (config: DesktopBackendStartConfig) => Effect.Effect<void>;
  readonly onNotReady: Effect.Effect<void>;
}

/**
 * Where the child's stdout/stderr go. Dev keeps `inherit` so `pnpm dev`
 * streams to the terminal; packaged apps have no console, so output is
 * captured to `logDir/server-child.log` — otherwise a failing production
 * backend leaves no artifact at all. Appended across runs; no rotation (a
 * starter's log volume is a few lines per boot).
 */
type BackendOutputTarget =
  | { readonly _tag: "inherit" }
  | { readonly _tag: "file"; readonly directory: string; readonly filePath: string };

export interface DesktopBackendManagerShape {
  readonly start: Effect.Effect<void>;
  readonly stop: Effect.Effect<void>;
  readonly currentConfig: Effect.Effect<Option.Option<DesktopBackendStartConfig>>;
}

export class DesktopBackendManager extends Context.Service<
  DesktopBackendManager,
  DesktopBackendManagerShape
>()("@app/desktop/backend/DesktopBackendManager") {}

interface ActiveRun {
  readonly id: number;
  readonly scope: Scope.Closeable;
  readonly fiber: Option.Option<Fiber.Fiber<void, never>>;
  readonly pid: Option.Option<number>;
}

interface ManagerState {
  readonly desiredRunning: boolean;
  readonly ready: boolean;
  readonly config: Option.Option<DesktopBackendStartConfig>;
  readonly active: Option.Option<ActiveRun>;
  readonly restartAttempt: number;
  readonly restartFiber: Option.Option<Fiber.Fiber<void, never>>;
  readonly nextRunId: number;
}

const initialState: ManagerState = {
  desiredRunning: false,
  ready: false,
  config: Option.none(),
  active: Option.none(),
  restartAttempt: 0,
  restartFiber: Option.none(),
  nextRunId: 1,
};

const calculateRestartDelay = (attempt: number): Duration.Duration =>
  Duration.min(Duration.times(INITIAL_RESTART_DELAY, 2 ** attempt), MAX_RESTART_DELAY);

type ManagerServices =
  | DesktopBackendConfiguration.DesktopBackendConfiguration
  | DesktopEnvironment.DesktopEnvironment
  | NetService
  | FileSystem.FileSystem
  | ChildProcessSpawner.ChildProcessSpawner
  | HttpClient.HttpClient;

const { logInfo, logWarning, logError } = makeComponentLogger("desktop-backend");

// Resolve the backend port: the configured/default port when free on both
// loopback stacks, otherwise a fresh ephemeral loopback port.
const resolvePort = Effect.fn("desktop.backend.resolvePort")(function* (
  net: NetService["Service"],
  configuredPort: Option.Option<number>,
  defaultPort: number,
) {
  const preferredPort = Option.getOrElse(configuredPort, () => defaultPort);
  return yield* net.findAvailablePort(preferredPort);
});

// Spawn the child + probe readiness (in a forked fiber), then wait for exit.
const runBackendProcess = Effect.fn("desktop.backend.runBackendProcess")(function* (
  config: DesktopBackendStartConfig,
  output: BackendOutputTarget,
  callbacks: {
    readonly onStarted: (pid: number) => Effect.Effect<void>;
    readonly onReady: Effect.Effect<void>;
    readonly onReadinessFailure: (error: DesktopBackendReadinessError) => Effect.Effect<void>;
  },
): Effect.fn.Return<
  void,
  PlatformError.PlatformError | DesktopBackendBootstrapEncodeError,
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | Scope.Scope
> {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const bootstrapJson = yield* encodeBootstrapEnvelopeJson(config.bootstrapEnvelope).pipe(
    Effect.mapError((cause) => new DesktopBackendBootstrapEncodeError({ cause })),
  );
  const stdio = output._tag === "file" ? ("pipe" as const) : ("inherit" as const);
  const command = ChildProcess.make(config.executablePath, [...config.args], {
    cwd: config.cwd,
    env: config.env,
    // The primary passes ELECTRON_RUN_AS_NODE + the token/port in `env`; merge
    // the parent env on top so PATH and friends are still available to the child.
    extendEnv: true,
    stdin: "ignore",
    stdout: stdio,
    stderr: stdio,
    killSignal: "SIGTERM",
    forceKillAfter: TERMINATE_GRACE,
    additionalFds: {
      fd3: {
        type: "input",
        stream: Stream.encodeText(Stream.make(`${bootstrapJson}\n`)),
      },
    },
  });

  const handle = yield* spawner.spawn(command);
  yield* callbacks.onStarted(handle.pid);

  if (output._tag === "file") {
    // Scoped file: closed when this run's scope closes. Log I/O failures must
    // never take the backend down, so the drain is fire-and-forget with logging.
    yield* Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      yield* fileSystem.makeDirectory(output.directory, { recursive: true });
      const file = yield* fileSystem.open(output.filePath, { flag: "a" });
      const header = `--- backend start pid=${handle.pid} port=${config.port}\n`;
      yield* file.writeAll(new TextEncoder().encode(header));
      yield* handle.all.pipe(
        Stream.runForEach((chunk) => file.writeAll(chunk)),
        Effect.ignore({ log: true }),
        Effect.forkScoped,
      );
    }).pipe(Effect.ignore({ log: true }));
  }

  yield* waitForHttpReady({
    baseUrl: config.httpBaseUrl.href,
    path: HEALTH_PATH,
    timeoutMs: Duration.toMillis(READINESS_TIMEOUT),
    intervalMs: Duration.toMillis(READINESS_INTERVAL),
    probeTimeoutMs: Duration.toMillis(READINESS_REQUEST_TIMEOUT),
    makeError: () =>
      new DesktopBackendReadinessError({
        url: new URL(HEALTH_PATH, config.httpBaseUrl).href,
      }),
  }).pipe(
    Effect.matchEffect({
      onFailure: callbacks.onReadinessFailure,
      onSuccess: () => callbacks.onReady,
    }),
    Effect.forkScoped,
  );

  // Block on the child's exit. When it resolves the run scope closes and the
  // finalize path decides whether to restart.
  yield* handle.exitCode;
});

// Builds a backend manager bound to the given readiness callbacks. `layer`
// supplies the window's onReady/onNotReady hooks. Exported for tests, which
// drive it with scripted spawner/net/http services and recording callbacks.
export const makeManager = (
  callbacks: DesktopBackendReadyCallbacks,
): Effect.Effect<DesktopBackendManagerShape, never, ManagerServices | Scope.Scope> =>
  Effect.gen(function* () {
    const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const net = yield* NetService;
    const fileSystem = yield* FileSystem.FileSystem;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const httpClient = yield* HttpClient.HttpClient;
    const parentScope = yield* Scope.Scope;
    const state = yield* Ref.make(initialState);
    const mutex = yield* Semaphore.make(1);

    const outputTarget: BackendOutputTarget = environment.isPackaged
      ? {
          _tag: "file",
          directory: environment.logDir,
          filePath: environment.path.join(environment.logDir, "server-child.log"),
        }
      : { _tag: "inherit" };

    const currentConfig = Ref.get(state).pipe(Effect.map((current) => current.config));

    const cancelRestart = Effect.gen(function* () {
      const restartFiber = yield* Ref.modify(state, (current) => [
        current.restartFiber,
        { ...current, restartFiber: Option.none() },
      ]);
      yield* Option.match(restartFiber, {
        onNone: () => Effect.void,
        onSome: (fiber) => Fiber.interrupt(fiber).pipe(Effect.asVoid),
      });
    });

    const scheduleRestart = Effect.fn("desktop.backend.scheduleRestart")(function* (
      reason: string,
    ) {
      const scheduled = yield* Ref.modify(state, (current) => {
        if (!current.desiredRunning || Option.isSome(current.restartFiber)) {
          return [Option.none<Duration.Duration>(), current] as const;
        }
        const delay = calculateRestartDelay(current.restartAttempt);
        return [
          Option.some(delay),
          { ...current, restartAttempt: current.restartAttempt + 1 },
        ] as const;
      });

      yield* Option.match(scheduled, {
        onNone: () => Effect.void,
        onSome: (delay) =>
          Effect.gen(function* () {
            yield* logWarning("backend exited; restart scheduled", {
              reason,
              delayMs: Duration.toMillis(delay),
            });
            const restartFiber = yield* Effect.forkIn(
              Effect.sleep(delay).pipe(
                Effect.andThen(
                  Ref.modify(state, (current) => [
                    current.desiredRunning,
                    { ...current, restartFiber: Option.none() },
                  ]),
                ),
                Effect.flatMap((shouldRestart) => (shouldRestart ? start : Effect.void)),
                Effect.ignore({ log: true }),
              ),
              parentScope,
            );
            yield* Ref.update(state, (current) =>
              Option.isNone(current.restartFiber)
                ? { ...current, restartFiber: Option.some(restartFiber) }
                : current,
            );
          }),
      });
    });

    const start: Effect.Effect<void> = Effect.suspend(() =>
      mutex.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* Ref.get(state);
          if (Option.isSome(current.active)) {
            return;
          }

          const config = yield* resolvePort(
            net,
            environment.configuredBackendPort,
            environment.defaultBackendPort,
          ).pipe(
            Effect.flatMap((port) => configuration.resolve({ port })),
            Effect.tapError((error) =>
              logError("failed to resolve backend configuration", {
                cause: error.message,
              }),
            ),
            Effect.option,
          );
          if (Option.isNone(config)) {
            return;
          }

          yield* cancelRestart;
          yield* Ref.update(state, (latest) => ({
            ...latest,
            desiredRunning: true,
            ready: false,
            config: Option.some(config.value),
          }));

          const entryExists = yield* fileSystem
            .exists(config.value.entryPath)
            .pipe(Effect.orElseSucceed(() => false));
          if (!entryExists) {
            yield* scheduleRestart(`missing server entry at ${config.value.entryPath}`);
            return;
          }

          const runScope = yield* Scope.make("sequential");
          const runId = yield* Ref.modify(state, (latest) => [
            latest.nextRunId,
            {
              ...latest,
              active: Option.some({
                id: latest.nextRunId,
                scope: runScope,
                fiber: Option.none<Fiber.Fiber<void, never>>(),
                pid: Option.none<number>(),
              } satisfies ActiveRun),
              nextRunId: latest.nextRunId + 1,
            },
          ]);

          const finalizeRun = Effect.fn("desktop.backend.finalizeRun")(function* (reason: string) {
            yield* mutex.withPermits(1)(
              Effect.gen(function* () {
                const isCurrentRun = yield* Ref.modify(state, (latest) => {
                  const run = Option.getOrUndefined(latest.active);
                  if (run?.id !== runId) {
                    return [false, latest] as const;
                  }
                  return [
                    true,
                    {
                      ...latest,
                      active: Option.none<ActiveRun>(),
                      ready: false,
                    },
                  ] as const;
                });
                if (isCurrentRun) {
                  yield* callbacks.onNotReady;
                  const latest = yield* Ref.get(state);
                  if (latest.desiredRunning) {
                    yield* scheduleRestart(reason);
                  }
                }
              }),
            );
          });

          const program = runBackendProcess(config.value, outputTarget, {
            onStarted: (pid) =>
              Effect.gen(function* () {
                yield* Ref.update(state, (latest) => ({
                  ...latest,
                  active: Option.map(latest.active, (run) =>
                    run.id === runId ? { ...run, pid: Option.some(pid) } : run,
                  ),
                }));
                yield* logInfo("backend started", {
                  pid,
                  port: config.value.port,
                });
              }),
            onReady: Effect.gen(function* () {
              const isCurrentRun = yield* Ref.modify(state, (latest) => {
                const run = Option.getOrUndefined(latest.active);
                if (run?.id !== runId) {
                  return [false, latest] as const;
                }
                return [true, { ...latest, restartAttempt: 0, ready: true }] as const;
              });
              if (!isCurrentRun) {
                return;
              }
              yield* logInfo("backend ready", {
                url: config.value.httpBaseUrl.href,
              });
              yield* callbacks.onReady(config.value);
            }),
            onReadinessFailure: (error) =>
              logWarning("backend readiness check failed", {
                error: error.message,
              }),
          }).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            Effect.provideService(FileSystem.FileSystem, fileSystem),
            Effect.provideService(HttpClient.HttpClient, httpClient),
            Scope.provide(runScope),
            Effect.matchEffect({
              onFailure: (error) => finalizeRun(error.message),
              onSuccess: () => finalizeRun("exited"),
            }),
            Effect.ensuring(Scope.close(runScope, Exit.void).pipe(Effect.ignore)),
          );

          const fiber = yield* Effect.forkIn(program, parentScope);
          yield* Ref.update(state, (latest) => ({
            ...latest,
            active: Option.map(latest.active, (run) =>
              run.id === runId ? { ...run, fiber: Option.some(fiber) } : run,
            ),
          }));
        }),
      ),
    ).pipe(Effect.withSpan("desktop.backend.start"));

    const stop = Effect.gen(function* () {
      const { active, restartFiber } = yield* mutex.withPermits(1)(
        Ref.modify(state, (latest) => [
          { active: latest.active, restartFiber: latest.restartFiber },
          {
            ...latest,
            desiredRunning: false,
            ready: false,
            active: Option.none<ActiveRun>(),
            restartFiber: Option.none<Fiber.Fiber<void, never>>(),
          },
        ]),
      );

      yield* Option.match(restartFiber, {
        onNone: () => Effect.void,
        onSome: (fiber) => Fiber.interrupt(fiber).pipe(Effect.asVoid),
      });
      yield* Option.match(active, {
        onNone: () => Effect.void,
        onSome: (run) =>
          // Closing the run scope tears down the ChildProcessSpawner handle,
          // which sends SIGTERM and force-kills after the grace window.
          Scope.close(run.scope, Exit.void)
            .pipe(
              Effect.andThen(
                Option.match(run.fiber, {
                  onNone: () => Effect.void,
                  onSome: (fiber) => Fiber.await(fiber).pipe(Effect.asVoid),
                }),
              ),
            )
            .pipe(Effect.ignore),
      });
    }).pipe(Effect.withSpan("desktop.backend.stop"));

    yield* Effect.addFinalizer(() => stop);

    return {
      start,
      stop,
      currentConfig,
    } satisfies DesktopBackendManagerShape;
  });

// Wires the manager into the window's readiness callbacks. `onReady` reveals the
// main window; `onNotReady` clears the latch so a dock-click while the backend
// is down doesn't strand a window pointing at nothing.
export const layer: Layer.Layer<
  DesktopBackendManager,
  never,
  | DesktopBackendConfiguration.DesktopBackendConfiguration
  | DesktopEnvironment.DesktopEnvironment
  | DesktopWindow.DesktopWindow
  | NetService
  | FileSystem.FileSystem
  | ChildProcessSpawner.ChildProcessSpawner
  | HttpClient.HttpClient
> = Layer.effect(
  DesktopBackendManager,
  Effect.gen(function* () {
    const window = yield* DesktopWindow.DesktopWindow;
    const manager = yield* makeManager({
      // A window-create failure while revealing on backend-ready is unexpected
      // and fatal; surface it as a defect rather than widening the callback's
      // error channel.
      onReady: (config) => window.handleBackendReady(config).pipe(Effect.orDie),
      onNotReady: window.handleBackendNotReady,
    });
    return manager;
  }),
);
