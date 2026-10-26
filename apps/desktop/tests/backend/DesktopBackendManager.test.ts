import { DesktopBackendBootstrap, SERVER_EXIT_CODE_STATE_DIR_OWNED } from "@app/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
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
}): ChildProcessSpawner.ChildProcessHandle {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(123),
    stdout: Stream.empty,
    stderr: Stream.empty,
    all: Stream.empty,
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
}) =>
  DesktopBackendManager.makeBackendInstance({
    configResolve: Effect.succeed(baseConfig),
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
