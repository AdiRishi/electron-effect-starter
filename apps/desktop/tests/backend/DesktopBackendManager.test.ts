import { DesktopBackendBootstrap, SERVER_EXIT_CODE_STATE_DIR_OWNED } from "@app/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as DesktopLogger from "../../src/app/DesktopLogger.ts";
import * as DesktopBackendManager from "../../src/backend/DesktopBackendManager.ts";

const decodeBootstrap = Schema.decodeEffect(Schema.fromJsonString(DesktopBackendBootstrap));

const baseConfig: DesktopBackendManager.DesktopBackendStartConfig = {
  executablePath: "/electron",
  entryPath: "/server/bin.mjs",
  args: ["/server/bin.mjs", "--bootstrap-fd", "3"],
  cwd: "/server",
  env: { ELECTRON_RUN_AS_NODE: "1" },
  bootstrap: {
    mode: "desktop",
    port: 3773,
    host: "127.0.0.1",
    baseDir: "/tmp/app",
    desktopBootstrapToken: "token",
  },
  httpBaseUrl: new URL("http://127.0.0.1:3773"),
};

// The child process and the HTTP readiness probe are the external seams.
function makeProcess(options: {
  readonly exitCode: Effect.Effect<ChildProcessSpawner.ExitCode, PlatformError.PlatformError>;
  readonly stdout?: Stream.Stream<Uint8Array, PlatformError.PlatformError>;
}): ChildProcessSpawner.ChildProcessHandle {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(123),
    stdout: options.stdout ?? Stream.empty,
    stderr: Stream.empty,
    all: options.stdout ?? Stream.empty,
    exitCode: options.exitCode,
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    stdin: Sink.drain,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });
}

const layerHttpClient = (status: number | "never") =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request: HttpClientRequest.HttpClientRequest) =>
      status === "never"
        ? Effect.never
        : Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status }))),
    ),
  );

const makeInstance = (input: {
  readonly spawn: (
    command: Parameters<Parameters<typeof ChildProcessSpawner.make>[0]>[0],
  ) => Effect.Effect<
    ChildProcessSpawner.ChildProcessHandle,
    PlatformError.PlatformError,
    Scope.Scope
  >;
  readonly httpStatus?: number | "never";
  readonly onReady?: (httpBaseUrl: URL) => Effect.Effect<void>;
  readonly onStateDirOwned?: () => Effect.Effect<void>;
  readonly outputLog?: DesktopLogger.DesktopBackendOutputLog;
}) =>
  DesktopBackendManager.makeBackendInstance({
    configResolve: Effect.succeed(baseConfig),
    ...(input.outputLog ? { outputLog: input.outputLog } : {}),
    ...(input.onReady ? { onReady: input.onReady } : {}),
    ...(input.onStateDirOwned ? { onStateDirOwned: input.onStateDirOwned } : {}),
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        FileSystem.layerNoop({ exists: () => Effect.succeed(true) }),
        Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(input.spawn),
        ),
        layerHttpClient(input.httpStatus ?? 200),
      ),
    ),
  );

describe("DesktopBackendManager", () => {
  it.effect("hands the server its bootstrap envelope on fd 3 and reports it ready", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const bootstrapLines = yield* Queue.unbounded<string>();
        const ready = yield* Deferred.make<URL>();

        const instance = yield* makeInstance({
          spawn: (command) =>
            Effect.gen(function* () {
              const fd3 = ChildProcess.isStandardCommand(command)
                ? command.options.additionalFds?.fd3
                : undefined;

              if (fd3?.type === "input" && fd3.stream) {
                yield* Queue.offer(
                  bootstrapLines,
                  yield* fd3.stream.pipe(Stream.decodeText(), Stream.mkString),
                );
              }

              return makeProcess({ exitCode: Effect.never });
            }),
          onReady: (httpBaseUrl) => Deferred.succeed(ready, httpBaseUrl).pipe(Effect.asVoid),
        });

        yield* instance.start;
        const envelope = yield* decodeBootstrap((yield* Queue.take(bootstrapLines)).trim());
        assert.deepStrictEqual(envelope, baseConfig.bootstrap);
        assert.strictEqual((yield* Deferred.await(ready)).href, "http://127.0.0.1:3773/");
        assert.isTrue((yield* instance.snapshot).ready);
      }),
    ),
  );

  it.effect("restarts a server that exits unexpectedly after a backoff", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const starts = yield* Queue.unbounded<number>();
        let startCount = 0;

        const instance = yield* makeInstance({
          httpStatus: "never",
          spawn: () =>
            Effect.gen(function* () {
              startCount += 1;
              yield* Queue.offer(starts, startCount);

              return makeProcess({
                exitCode:
                  startCount === 1 ? Effect.succeed(ChildProcessSpawner.ExitCode(1)) : Effect.never,
              });
            }),
        });

        yield* instance.start;
        assert.strictEqual(yield* Queue.take(starts), 1);
        // The first restart waits half a second.
        yield* TestClock.adjust(Duration.millis(500));
        assert.strictEqual(yield* Queue.take(starts), 2);
        assert.isTrue((yield* instance.snapshot).desiredRunning);
      }),
    ),
  );

  it.effect("stops restarting once another server owns the state directory", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const refused = yield* Deferred.make<void>();
        let startCount = 0;

        const instance = yield* makeInstance({
          httpStatus: "never",
          spawn: () =>
            Effect.sync(() => {
              startCount += 1;

              return makeProcess({
                exitCode: Effect.succeed(
                  ChildProcessSpawner.ExitCode(SERVER_EXIT_CODE_STATE_DIR_OWNED),
                ),
              });
            }),
          onStateDirOwned: () => Deferred.succeed(refused, undefined).pipe(Effect.asVoid),
        });

        yield* instance.start;
        yield* Deferred.await(refused);
        const snapshot = yield* instance.snapshot;
        assert.isFalse(snapshot.desiredRunning);
        assert.isFalse(snapshot.restartScheduled);
        yield* TestClock.adjust(Duration.minutes(1));
        assert.strictEqual(startCount, 1);
      }),
    ),
  );

  it.effect("closes the running server on stop and does not restart it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const closed = yield* Deferred.make<void>();
        const ready = yield* Deferred.make<void>();
        let startCount = 0;

        const instance = yield* makeInstance({
          spawn: () =>
            Effect.gen(function* () {
              startCount += 1;
              // Closing the run's scope is how the real spawner kills the process.
              yield* Effect.addFinalizer(() => Deferred.succeed(closed, undefined));

              return makeProcess({
                exitCode: Deferred.await(closed).pipe(Effect.as(ChildProcessSpawner.ExitCode(0))),
              });
            }),
          onReady: () => Deferred.succeed(ready, undefined).pipe(Effect.asVoid),
        });

        yield* instance.start;
        yield* Deferred.await(ready);
        yield* instance.stop();
        assert.isTrue(yield* Deferred.isDone(closed));
        const snapshot = yield* instance.snapshot;
        assert.isFalse(snapshot.desiredRunning);
        assert.isTrue(Option.isNone(snapshot.activePid));
        yield* TestClock.adjust(Duration.minutes(1));
        assert.strictEqual(startCount, 1);
      }),
    ),
  );

  it.effect("persists a crashed run's output and discards a stopped run's", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const events: string[] = [];
        const crashed = yield* Deferred.make<void>();
        let startCount = 0;

        const instance = yield* makeInstance({
          httpStatus: "never",
          outputLog: {
            beginSession: ({ details }) => Effect.sync(() => events.push(`begin:${details}`)),
            writeOutputChunk: () => Effect.void,
            persistFailureSnapshot: () => Effect.void,
            persistFailure: ({ details }) =>
              Effect.sync(() => events.push(`persist:${details}`)).pipe(
                Effect.andThen(Deferred.succeed(crashed, undefined)),
                Effect.asVoid,
              ),
            discardSession: Effect.sync(() => {
              events.push("discard");
            }),
          },
          spawn: () =>
            Effect.gen(function* () {
              startCount += 1;
              const closed = yield* Deferred.make<void>();
              yield* Effect.addFinalizer(() => Deferred.succeed(closed, undefined));

              return makeProcess({
                exitCode:
                  startCount === 1
                    ? Effect.succeed(ChildProcessSpawner.ExitCode(1))
                    : Deferred.await(closed).pipe(Effect.as(ChildProcessSpawner.ExitCode(0))),
              });
            }),
        });

        yield* instance.start;
        yield* Deferred.await(crashed);
        yield* TestClock.adjust(Duration.millis(500));
        yield* instance.stop();

        assert.deepStrictEqual(events, [
          "begin:pid=123 port=3773 cwd=/server",
          "persist:pid=123 code=1",
          "begin:pid=123 port=3773 cwd=/server",
          "discard",
        ]);
      }),
    ),
  );

  it.effect("restarts when start is requested during stop teardown", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const starts = yield* Queue.unbounded<number>();
        const teardownStarted = yield* Deferred.make<void>();
        const finishTeardown = yield* Deferred.make<void>();
        let startCount = 0;

        const instance = yield* makeInstance({
          httpStatus: "never",
          spawn: () =>
            Effect.gen(function* () {
              const closed = yield* Deferred.make<void>();
              startCount += 1;
              yield* Queue.offer(starts, startCount);

              yield* Effect.addFinalizer(() =>
                startCount === 1
                  ? Deferred.succeed(teardownStarted, undefined).pipe(
                      Effect.andThen(Deferred.await(finishTeardown)),
                      Effect.andThen(Deferred.succeed(closed, undefined)),
                    )
                  : Deferred.succeed(closed, undefined),
              );

              return makeProcess({
                exitCode: Deferred.await(closed).pipe(Effect.as(ChildProcessSpawner.ExitCode(0))),
              });
            }),
        });

        yield* instance.start;
        assert.strictEqual(yield* Queue.take(starts), 1);

        const stopFiber = yield* instance.stop().pipe(Effect.forkChild);
        yield* Deferred.await(teardownStarted);
        yield* instance.start;
        assert.isTrue((yield* instance.snapshot).desiredRunning);

        yield* Deferred.succeed(finishTeardown, undefined);
        yield* Fiber.join(stopFiber);
        yield* TestClock.adjust(Duration.millis(500));

        assert.strictEqual(yield* Queue.take(starts), 2);
        const restarted = yield* instance.snapshot;
        assert.isTrue(restarted.desiredRunning);
        assert.deepStrictEqual(restarted.activePid, Option.some(123));
      }),
    ),
  );

  it.effect("reports child exit before waiting for trailing output to drain", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const exitObserved = yield* Deferred.make<void>();
        const finishOutputDrain = yield* Deferred.make<void>();

        const runFiber = yield* DesktopBackendManager.runBackendProcess(baseConfig, {
          readinessTimeout: Duration.seconds(1),
          onStarted: () => Effect.void,
          onExitObserved: Deferred.succeed(exitObserved, undefined).pipe(Effect.asVoid),
          onReady: Effect.void,
          onReadinessFailure: () => Effect.void,
          onOutput: () => Effect.void,
        }).pipe(
          Effect.provide(
            Layer.merge(
              Layer.succeed(
                ChildProcessSpawner.ChildProcessSpawner,
                ChildProcessSpawner.make(() =>
                  Effect.succeed(
                    makeProcess({
                      stdout: Stream.fromEffect(
                        Deferred.await(finishOutputDrain).pipe(
                          Effect.as(new TextEncoder().encode("trailing output\n")),
                        ),
                      ),
                      exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
                    }),
                  ),
                ),
              ),
              layerHttpClient("never"),
            ),
          ),
          Effect.forkChild,
        );

        yield* Deferred.await(exitObserved);
        assert.isUndefined(runFiber.pollUnsafe());

        yield* Deferred.succeed(finishOutputDrain, undefined);
        assert.deepStrictEqual((yield* Fiber.join(runFiber)).code, Option.some(1));
      }),
    ),
  );

  it.effect("reports a signal exit without an exit code", () =>
    Effect.gen(function* () {
      const exitCause = PlatformError.systemError({
        // oxlint-disable-next-line anti-slop-effect/no-manual-tagged-construction -- systemError takes the reason tag as input.
        _tag: "Unknown",
        module: "ChildProcess",
        method: "exitCode",
        cause: new Error("Process interrupted due to receipt of signal: 'SIGKILL'"),
      });

      const exit = yield* DesktopBackendManager.runBackendProcess(baseConfig, {
        readinessTimeout: Duration.seconds(1),
        onStarted: () => Effect.void,
        onExitObserved: Effect.void,
        onReady: Effect.void,
        onReadinessFailure: () => Effect.void,
        onOutput: () => Effect.void,
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.merge(
            Layer.succeed(
              ChildProcessSpawner.ChildProcessSpawner,
              ChildProcessSpawner.make(() =>
                Effect.succeed(makeProcess({ exitCode: Effect.fail(exitCause) })),
              ),
            ),
            layerHttpClient("never"),
          ),
        ),
      );

      assert.deepStrictEqual(exit, { code: Option.none(), reason: "killed by SIGKILL" });
    }),
  );
});
