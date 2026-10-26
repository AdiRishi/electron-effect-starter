import {
  DesktopBackendBootstrap,
  SERVER_DESCRIPTOR_PATH,
  SERVER_EXIT_CODE_STATE_DIR_OWNED,
} from "@app/contracts";
import { type HttpReadinessError, waitForHttpReady } from "@app/shared/httpReadiness";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as PlatformError from "effect/PlatformError";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as DesktopLogger from "../app/DesktopLogger.ts";

const INITIAL_RESTART_DELAY = Duration.millis(500);
const MAX_RESTART_DELAY = Duration.seconds(10);
const DEFAULT_READINESS_TIMEOUT = Duration.minutes(1);
const READINESS_INTERVAL = Duration.millis(100);
const READINESS_REQUEST_TIMEOUT = Duration.seconds(1);
const TERMINATE_GRACE = Duration.seconds(5);
const OUTPUT_DRAIN_TIMEOUT = Duration.seconds(5);

export type BackendOutputStream = "stdout" | "stderr";

export interface DesktopBackendStartConfig {
  readonly executablePath: string;
  readonly entryPath: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: Record<string, string | undefined>;
  readonly bootstrap: DesktopBackendBootstrap;
  readonly httpBaseUrl: URL;
}

interface BackendProcessExit {
  readonly code: Option.Option<number>;
  readonly reason: string;
}

export class BackendProcessError extends Schema.TaggedError<BackendProcessError>()(
  "BackendProcessError",
  {
    stage: Schema.Literals(["encode-bootstrap", "spawn", "exit-status"]),
    entryPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `The server process at ${this.entryPath} failed during ${this.stage}.`;
  }
}

export interface DesktopBackendSnapshot {
  readonly desiredRunning: boolean;
  readonly ready: boolean;
  readonly activePid: Option.Option<number>;
  readonly restartAttempt: number;
  readonly restartScheduled: boolean;
}

export interface DesktopBackendInstance {
  readonly start: Effect.Effect<void>;
  readonly stop: (options?: { readonly timeout?: Duration.Duration }) => Effect.Effect<void>;
  readonly currentConfig: Effect.Effect<Option.Option<DesktopBackendStartConfig>>;
  readonly snapshot: Effect.Effect<DesktopBackendSnapshot>;
}

export interface BackendInstanceSpec {
  readonly configResolve: Effect.Effect<DesktopBackendStartConfig, PlatformError.PlatformError>;
  /** Receives the ready run's URL; reading current config could race a later restart. */
  readonly onReady?: (httpBaseUrl: URL) => Effect.Effect<void>;
  readonly onShutdown?: () => Effect.Effect<void>;
  readonly onStateDirOwned?: () => Effect.Effect<void>;
  readonly onOutput?: (stream: BackendOutputStream, chunk: Uint8Array) => Effect.Effect<void>;
  readonly readinessTimeout?: Duration.Duration;
}

interface ActiveBackendRun {
  readonly id: number;
  readonly scope: Scope.Closeable;
  readonly fiber: Option.Option<Fiber.Fiber<void, never>>;
  readonly pid: Option.Option<number>;
  readonly exitObserved: boolean;
  readonly stopRequested: boolean;
}

interface BackendManagerState {
  readonly desiredRunning: boolean;
  readonly ready: boolean;
  readonly config: Option.Option<DesktopBackendStartConfig>;
  readonly active: Option.Option<ActiveBackendRun>;
  readonly restartAttempt: number;
  readonly restartFiber: Option.Option<Fiber.Fiber<void, never>>;
  readonly nextRunId: number;
}

const initialState: BackendManagerState = {
  desiredRunning: false,
  ready: false,
  config: Option.none(),
  active: Option.none(),
  restartAttempt: 0,
  restartFiber: Option.none(),
  nextRunId: 1,
};

const withActiveRun =
  (runId: number, f: (run: ActiveBackendRun) => ActiveBackendRun) =>
  (state: BackendManagerState): BackendManagerState => ({
    ...state,
    active: Option.map(state.active, (run) => (run.id === runId ? f(run) : run)),
  });

export const calculateRestartDelay = (attempt: number): Duration.Duration =>
  Duration.min(Duration.times(INITIAL_RESTART_DELAY, 2 ** attempt), MAX_RESTART_DELAY);

const closeRun = (
  run: ActiveBackendRun,
  parentScope: Scope.Scope,
  options?: { readonly timeout?: Duration.Duration },
): Effect.Effect<boolean> => {
  const waitForFiber = Option.match(run.fiber, {
    onNone: () => Effect.void,
    onSome: (fiber) => Fiber.await(fiber).pipe(Effect.asVoid),
  });
  const close = Scope.close(run.scope, Exit.void).pipe(Effect.andThen(waitForFiber));
  if (!options?.timeout) return close.pipe(Effect.as(true));
  const timeout = options.timeout;
  return Effect.forkIn(close, parentScope).pipe(
    Effect.flatMap((closeFiber) =>
      Fiber.await(closeFiber).pipe(Effect.timeoutOption(timeout), Effect.map(Option.isSome)),
    ),
  );
};

const encodeBootstrapJson = Schema.encodeEffect(Schema.fromJsonString(DesktopBackendBootstrap));

/**
 * Runs one server process until it exits. The bootstrap envelope goes over fd 3 so secrets stay
 * out of argv and the environment; readiness is the descriptor endpoint answering over HTTP.
 */
export const runBackendProcess = Effect.fn("runBackendProcess")(function* (
  config: DesktopBackendStartConfig,
  callbacks: {
    readonly readinessTimeout: Duration.Duration;
    readonly onStarted: (pid: number) => Effect.Effect<void>;
    readonly onExitObserved: Effect.Effect<void>;
    readonly onReady: Effect.Effect<void>;
    readonly onReadinessFailure: (error: HttpReadinessError) => Effect.Effect<void>;
    readonly onOutput: (stream: BackendOutputStream, chunk: Uint8Array) => Effect.Effect<void>;
  },
): Effect.fn.Return<
  BackendProcessExit,
  BackendProcessError,
  ChildProcessSpawner.ChildProcessSpawner | HttpClient.HttpClient | Scope.Scope
> {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const bootstrapJson = yield* encodeBootstrapJson(config.bootstrap).pipe(
    Effect.mapError(
      (cause) =>
        new BackendProcessError({ stage: "encode-bootstrap", entryPath: config.entryPath, cause }),
    ),
  );
  const command = ChildProcess.make(config.executablePath, [...config.args], {
    cwd: config.cwd,
    env: config.env,
    extendEnv: true,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    killSignal: "SIGTERM",
    forceKillAfter: TERMINATE_GRACE,
    additionalFds: {
      fd3: { type: "input", stream: Stream.encodeText(Stream.make(`${bootstrapJson}\n`)) },
    },
  });
  const handle = yield* spawner
    .spawn(command)
    .pipe(
      Effect.mapError(
        (cause) => new BackendProcessError({ stage: "spawn", entryPath: config.entryPath, cause }),
      ),
    );
  yield* callbacks.onStarted(handle.pid);

  // Output that cannot be read or written must never take the server down with it.
  const drain = (streamName: BackendOutputStream, stream: Stream.Stream<Uint8Array, unknown>) =>
    stream.pipe(
      Stream.runForEach((chunk) => callbacks.onOutput(streamName, chunk)),
      Effect.ignore,
      Effect.forkScoped,
    );
  const outputFibers = [
    yield* drain("stdout", handle.stdout),
    yield* drain("stderr", handle.stderr),
  ];

  // A slow cold start can outlast one readiness budget; keep probing while the process lives.
  const probeReadiness = waitForHttpReady({
    baseUrl: config.httpBaseUrl,
    path: SERVER_DESCRIPTOR_PATH,
    timeout: callbacks.readinessTimeout,
    interval: READINESS_INTERVAL,
    probeTimeout: READINESS_REQUEST_TIMEOUT,
  }).pipe(
    Effect.andThen(callbacks.onReady),
    Effect.as(true),
    Effect.catchTags({
      HttpReadinessError: (error) => callbacks.onReadinessFailure(error).pipe(Effect.as(false)),
    }),
  );
  yield* probeReadiness.pipe(Effect.repeat({ while: (ready) => !ready }), Effect.forkScoped);

  const exit = yield* handle.exitCode.pipe(
    Effect.map((exitCode): BackendProcessExit => ({
      code: Option.some(exitCode),
      reason: `code=${exitCode}`,
    })),
    Effect.catch((cause) => {
      // Effect's Node spawner exposes signal exits only through this cause message.
      const signal =
        cause.cause instanceof Error
          ? /^Process interrupted due to receipt of signal: '(SIG[A-Z0-9]+)'$/.exec(
              cause.cause.message,
            )?.[1]
          : undefined;
      return signal !== undefined
        ? Effect.succeed<BackendProcessExit>({ code: Option.none(), reason: `killed by ${signal}` })
        : Effect.fail(
            new BackendProcessError({ stage: "exit-status", entryPath: config.entryPath, cause }),
          );
    }),
    Effect.exit,
  );
  yield* callbacks.onExitObserved;
  yield* Effect.forEach(outputFibers, Fiber.await, {
    concurrency: "unbounded",
    discard: true,
  }).pipe(Effect.timeout(OUTPUT_DRAIN_TIMEOUT), Effect.ignore);
  return yield* exit;
});

/**
 * Supervises the server process: one run at a time, each in its own scope, restarted with backoff
 * when it exits unexpectedly. Exit code 78 means another server owns the state directory, so the
 * supervisor stops instead of restarting into the same refusal.
 */
export const makeBackendInstance = Effect.fn("makeBackendInstance")(function* (
  spec: BackendInstanceSpec,
): Effect.fn.Return<
  DesktopBackendInstance,
  never,
  | FileSystem.FileSystem
  | ChildProcessSpawner.ChildProcessSpawner
  | HttpClient.HttpClient
  | Scope.Scope
> {
  const parentScope = yield* Scope.Scope;
  const fileSystem = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const httpClient = yield* HttpClient.HttpClient;
  const state = yield* Ref.make(initialState);
  const mutex = yield* Semaphore.make(1);
  const { logInfo, logWarning, logError } = DesktopLogger.forComponent("desktop-backend");

  const updateActiveRun = (runId: number, f: (run: ActiveBackendRun) => ActiveBackendRun) =>
    Ref.update(state, withActiveRun(runId, f));

  const snapshot = Ref.get(state).pipe(
    Effect.map((current): DesktopBackendSnapshot => ({
      desiredRunning: current.desiredRunning,
      ready: current.ready,
      activePid: Option.flatMap(current.active, (run) => run.pid),
      restartAttempt: current.restartAttempt,
      restartScheduled: Option.isSome(current.restartFiber),
    })),
  );
  const currentConfig = Ref.get(state).pipe(Effect.map((current) => current.config));

  const cancelRestart = Effect.gen(function* () {
    const restartFiber = yield* Ref.modify(state, (current) => [
      current.restartFiber,
      { ...current, restartFiber: Option.none() },
    ]);
    if (Option.isSome(restartFiber)) yield* Fiber.interrupt(restartFiber.value);
  });

  const scheduleRestart = Effect.fn("DesktopBackend.scheduleRestart")(function* (reason: string) {
    const scheduled = yield* Ref.modify(state, (latest) => {
      if (!latest.desiredRunning || Option.isSome(latest.restartFiber)) {
        return [Option.none<Duration.Duration>(), latest] as const;
      }
      return [
        Option.some(calculateRestartDelay(latest.restartAttempt)),
        { ...latest, restartAttempt: latest.restartAttempt + 1 },
      ] as const;
    });
    if (Option.isNone(scheduled)) return;
    yield* logError("server exited unexpectedly; restart scheduled", {
      reason,
      delayMs: Duration.toMillis(scheduled.value),
    });
    const restartFiber = yield* Effect.forkIn(
      Effect.sleep(scheduled.value).pipe(
        Effect.andThen(
          Ref.modify(state, (latest) => [
            latest.desiredRunning,
            { ...latest, restartFiber: Option.none() },
          ]),
        ),
        Effect.flatMap((shouldRestart) => (shouldRestart ? start : Effect.void)),
        Effect.catchCause((cause) => logError("server restart fiber failed", cause)),
      ),
      parentScope,
    );
    yield* Ref.update(state, (latest) =>
      Option.isNone(latest.restartFiber)
        ? { ...latest, restartFiber: Option.some(restartFiber) }
        : latest,
    );
  });

  const start: Effect.Effect<void> = Effect.suspend(() =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* Ref.get(state);
        if (Option.isSome(current.active)) {
          if (!current.desiredRunning) {
            yield* Ref.update(state, (latest) => ({ ...latest, desiredRunning: true }));
          }
          return;
        }
        if (current.ready) {
          yield* spec.onShutdown?.() ?? Effect.void;
          yield* Ref.update(state, (latest) => ({ ...latest, ready: false }));
        }
        const config = yield* spec.configResolve.pipe(
          Effect.tapError((error) => logError("failed to resolve the server configuration", error)),
          Effect.option,
        );
        if (Option.isNone(config)) {
          if (current.desiredRunning) yield* scheduleRestart("server configuration failed");
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
              fiber: Option.none(),
              pid: Option.none(),
              exitObserved: false,
              stopRequested: false,
            } satisfies ActiveBackendRun),
            nextRunId: latest.nextRunId + 1,
          },
        ]);

        const finalizeRun = Effect.fn("DesktopBackend.finalizeRun")(function* (
          reason: string,
          exitCode?: number,
        ) {
          yield* mutex.withPermits(1)(
            Effect.gen(function* () {
              const ended = yield* Ref.modify(state, (latest) => {
                const run = Option.getOrUndefined(latest.active);
                if (run?.id !== runId) return [Option.none(), latest] as const;
                return [
                  Option.some({ stopRequested: run.stopRequested, wasReady: latest.ready }),
                  { ...latest, active: Option.none<ActiveBackendRun>(), ready: false },
                ] as const;
              });
              if (Option.isNone(ended)) return;
              if (ended.value.wasReady) yield* spec.onShutdown?.() ?? Effect.void;
              if (!(yield* Ref.get(state)).desiredRunning) return;
              if (exitCode === SERVER_EXIT_CODE_STATE_DIR_OWNED && !ended.value.stopRequested) {
                yield* Ref.update(state, (latest) => ({ ...latest, desiredRunning: false }));
                yield* spec.onStateDirOwned?.() ?? Effect.void;
                return;
              }
              yield* scheduleRestart(reason);
            }),
          );
        });

        const program = runBackendProcess(config.value, {
          readinessTimeout: spec.readinessTimeout ?? DEFAULT_READINESS_TIMEOUT,
          onStarted: (pid) =>
            updateActiveRun(runId, (run) => ({ ...run, pid: Option.some(pid) })).pipe(
              Effect.andThen(logInfo("server started", { pid, port: config.value.bootstrap.port })),
            ),
          onExitObserved: updateActiveRun(runId, (run) => ({ ...run, exitObserved: true })),
          onReady: Effect.gen(function* () {
            const isCurrentRun = yield* Ref.modify(state, (latest) =>
              Option.getOrUndefined(latest.active)?.id === runId
                ? ([true, { ...latest, restartAttempt: 0, ready: true }] as const)
                : ([false, latest] as const),
            );
            if (isCurrentRun) yield* spec.onReady?.(config.value.httpBaseUrl) ?? Effect.void;
          }),
          onReadinessFailure: (error) => logWarning("server readiness check failed", error),
          onOutput: spec.onOutput ?? (() => Effect.void),
        }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(HttpClient.HttpClient, httpClient),
          Scope.provide(runScope),
          Effect.matchEffect({
            onFailure: (error) => finalizeRun(error.message),
            onSuccess: (exit) => finalizeRun(exit.reason, Option.getOrUndefined(exit.code)),
          }),
          Effect.ensuring(Scope.close(runScope, Exit.void).pipe(Effect.ignore)),
        );

        const fiber = yield* Effect.forkIn(program, parentScope);
        yield* updateActiveRun(runId, (run) => ({ ...run, fiber: Option.some(fiber) }));
      }),
    ),
  ).pipe(Effect.withSpan("DesktopBackend.start"));

  const stop = Effect.fn("DesktopBackend.stop")(function* (options?: {
    readonly timeout?: Duration.Duration;
  }) {
    const { active, restartFiber, notifyShutdown } = yield* mutex.withPermits(1)(
      Ref.modify(state, (latest) => {
        const active = Option.map(latest.active, (run) =>
          run.exitObserved ? run : { ...run, stopRequested: true },
        );
        return [
          { active, restartFiber: latest.restartFiber, notifyShutdown: latest.ready },
          {
            ...latest,
            desiredRunning: false,
            ready: false,
            active,
            restartFiber: Option.none<Fiber.Fiber<void, never>>(),
          },
        ] as const;
      }),
    );
    if (notifyShutdown) yield* spec.onShutdown?.() ?? Effect.void;
    if (Option.isSome(restartFiber)) yield* Fiber.interrupt(restartFiber.value);
    if (Option.isNone(active)) return;
    const closed = yield* closeRun(active.value, parentScope, options);
    if (!closed) {
      yield* logWarning("server did not stop within the timeout");
      return;
    }
    yield* Ref.update(state, (latest) =>
      Option.getOrUndefined(latest.active)?.id === active.value.id
        ? { ...latest, active: Option.none<ActiveBackendRun>() }
        : latest,
    );
  });

  yield* Effect.addFinalizer(() => stop());

  return { start, stop, currentConfig, snapshot } satisfies DesktopBackendInstance;
});
