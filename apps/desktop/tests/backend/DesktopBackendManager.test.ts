import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, beforeEach, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { FetchHttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import { NetService, type NetServiceShape } from "@app/shared/Net";

import * as DesktopEnvironment from "../../src/app/DesktopEnvironment.ts";
import * as DesktopBackendConfiguration from "../../src/backend/DesktopBackendConfiguration.ts";
import {
  makeManager,
  type DesktopBackendManagerShape,
} from "../../src/backend/DesktopBackendManager.ts";

const PORT = 34_567;

// A real file on disk so the manager's entry-exists preflight passes.
const SCRATCH = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "desktop-manager-test-"));
const ENTRY_PATH = NodePath.join(SCRATCH, "bin.mjs");
NodeFS.writeFileSync(ENTRY_PATH, "// fake server entry\n");
const LOG_DIR_HOME = NodePath.join(SCRATCH, "home");

// The readiness probe uses the global fetch (FetchHttpClient); answer 200.
beforeEach(() => {
  (globalThis as { fetch: typeof fetch }).fetch = async () => new Response("ok", { status: 200 });
});

const fakeNet: NetServiceShape = {
  canListenOnHost: () => Effect.succeed(true),
  isPortAvailableOnLoopback: () => Effect.succeed(true),
  reserveLoopbackPort: () => Effect.succeed(PORT),
  findAvailablePort: (preferred) => Effect.succeed(preferred),
};

interface SpawnedChild {
  readonly exit: Deferred.Deferred<number>;
  killed: boolean;
}

/** A spawner whose children exit when the test says so (or when killed). */
const makeScriptedSpawner = Effect.gen(function* () {
  const children = yield* Ref.make<ReadonlyArray<SpawnedChild>>([]);
  const spawnCount = Ref.get(children).pipe(Effect.map((all) => all.length));

  const spawner = ChildProcessSpawner.make((_command) =>
    Effect.gen(function* () {
      const exit = yield* Deferred.make<number>();
      const child: SpawnedChild = { exit, killed: false };
      yield* Ref.update(children, (all) => [...all, child]);
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          child.killed = true;
          yield* Deferred.succeed(exit, 0).pipe(Effect.asVoid);
        }),
      );
      return {
        pid: 4242,
        exitCode: Deferred.await(exit),
        isRunning: Deferred.isDone(exit).pipe(Effect.map((done) => !done)),
        kill: () =>
          Effect.suspend(() => {
            child.killed = true;
            return Deferred.succeed(exit, 0 as never).pipe(Effect.asVoid);
          }),
        stdin: undefined,
        stdout: Stream.empty,
        stderr: Stream.empty,
        all: Stream.make(new TextEncoder().encode("hello from server\n")),
      } as unknown as ChildProcessSpawner.ChildProcessHandle;
    }),
  );

  const exitCurrent = (code: number) =>
    Ref.get(children).pipe(
      Effect.flatMap((all) => {
        const current = all[all.length - 1];
        return current === undefined
          ? Effect.die("exitCurrent before any spawn")
          : Deferred.succeed(current.exit, code).pipe(Effect.asVoid);
      }),
    );

  const currentKilled = Ref.get(children).pipe(
    Effect.map((all) => all[all.length - 1]?.killed ?? false),
  );

  return { spawner, spawnCount, exitCurrent, currentKilled };
});

const environmentLayer = (input?: { readonly isPackaged?: boolean; readonly entry?: string }) =>
  Layer.effect(
    DesktopEnvironment.DesktopEnvironment,
    Effect.map(Path.Path, (path) =>
      DesktopEnvironment.makeWith(
        {
          dirname: NodePath.join(SCRATCH, "dist-electron"),
          homeDirectory: LOG_DIR_HOME,
          platform: "darwin",
          appVersion: "0.0.0-test",
          isPackaged: input?.isPackaged ?? false,
          resourcesPath: NodePath.join(SCRATCH, "resources"),
          serverEntryOverride: Option.some(input?.entry ?? ENTRY_PATH),
          configuredBackendPort: Option.some(PORT),
          devServerUrl: Option.none(),
        },
        path,
      ),
    ),
  );

interface Harness {
  readonly manager: DesktopBackendManagerShape;
  readonly spawnCount: Effect.Effect<number>;
  readonly exitCurrent: (code: number) => Effect.Effect<void>;
  readonly currentKilled: Effect.Effect<boolean>;
  readonly awaitReady: Effect.Effect<void>;
  readonly notReadyCount: Effect.Effect<number>;
}

const makeHarness = (input?: Parameters<typeof environmentLayer>[0]) =>
  Effect.gen(function* () {
    const scripted = yield* makeScriptedSpawner;
    const readyLatch = yield* Deferred.make<void>();
    const notReadyHits = yield* Ref.make(0);

    const manager = yield* makeManager({
      onReady: () => Deferred.succeed(readyLatch, undefined).pipe(Effect.asVoid),
      onNotReady: Ref.update(notReadyHits, (n) => n + 1),
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, scripted.spawner),
      Effect.provideService(NetService, fakeNet),
      Effect.provide(
        DesktopBackendConfiguration.layer.pipe(
          Layer.provideMerge(environmentLayer(input)),
          Layer.provideMerge(NodeServices.layer),
          Layer.provideMerge(FetchHttpClient.layer),
        ),
      ),
    );

    return {
      manager,
      spawnCount: scripted.spawnCount,
      exitCurrent: scripted.exitCurrent,
      currentKilled: scripted.currentKilled,
      awaitReady: Deferred.await(readyLatch),
      notReadyCount: Ref.get(notReadyHits),
    } satisfies Harness;
  });

describe("DesktopBackendManager", () => {
  it.effect("spawns the backend and reveals the window on readiness", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();

      yield* harness.manager.start;
      yield* harness.awaitReady;

      assert.equal(yield* harness.spawnCount, 1);
      const config = yield* harness.manager.currentConfig;
      assert.isTrue(Option.isSome(config));
      if (Option.isSome(config)) {
        assert.equal(config.value.port, PORT);
      }
    }).pipe(Effect.scoped),
  );

  it.effect("restarts with backoff after an unexpected exit", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* harness.manager.start;
      yield* harness.awaitReady;

      yield* harness.exitCurrent(1);
      // The exit path clears the window latch, then schedules the restart.
      yield* Effect.gen(function* () {
        while ((yield* harness.notReadyCount) < 1) {
          yield* Effect.yieldNow;
        }
      });

      yield* TestClock.adjust("500 millis");
      yield* Effect.gen(function* () {
        while ((yield* harness.spawnCount) < 2) {
          yield* Effect.yieldNow;
        }
      });
      assert.equal(yield* harness.spawnCount, 2);
    }).pipe(Effect.scoped),
  );

  it.effect("stop kills the child and does not restart", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* harness.manager.start;
      yield* harness.awaitReady;

      yield* harness.manager.stop;
      assert.isTrue(yield* harness.currentKilled);

      yield* TestClock.adjust("5 seconds");
      assert.equal(yield* harness.spawnCount, 1);
    }).pipe(Effect.scoped),
  );

  it.effect("does not spawn when the server entry is missing, and keeps retrying", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ entry: NodePath.join(SCRATCH, "missing.mjs") });
      yield* harness.manager.start;

      yield* TestClock.adjust("500 millis");
      yield* TestClock.adjust("1 second");
      assert.equal(yield* harness.spawnCount, 0);
      // Still wants to run: the config is resolved and waiting on the entry.
      assert.isTrue(Option.isSome(yield* harness.manager.currentConfig));
    }).pipe(Effect.scoped),
  );

  it.effect("captures child output to logDir/server-child.log when packaged", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ isPackaged: true });
      yield* harness.manager.start;
      yield* harness.awaitReady;

      const logPath = NodePath.join(
        LOG_DIR_HOME,
        ".electron-effect-starter",
        "logs",
        "server-child.log",
      );
      yield* Effect.gen(function* () {
        while (
          !NodeFS.existsSync(logPath) ||
          !NodeFS.readFileSync(logPath, "utf8").includes("hello from server")
        ) {
          yield* Effect.yieldNow;
        }
      });

      const contents = NodeFS.readFileSync(logPath, "utf8");
      assert.include(contents, "--- backend start pid=4242");
      assert.include(contents, "hello from server");
    }).pipe(Effect.scoped),
  );
});
