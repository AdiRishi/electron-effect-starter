import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { assertNone, assertSome } from "@effect/vitest/utils";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vitest";

import { HostProcessPlatform } from "@app/shared/hostProcess";

import {
  BootstrapFdStatError,
  BootstrapInputStreamOpenError,
  readBootstrapEnvelope,
} from "../src/bootstrap.ts";

const openSyncInterceptor = vi.hoisted(() => ({
  failPath: null as string | null,
  errorCode: "ENXIO",
}));
const fstatSyncInterceptor = vi.hoisted(() => ({ failFd: null as number | null }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    openSync: (...args: Parameters<typeof actual.openSync>) => {
      const [filePath, flags] = args;
      if (
        typeof filePath === "string" &&
        filePath === openSyncInterceptor.failPath &&
        flags === "r"
      ) {
        const error = new Error(`open failed with ${openSyncInterceptor.errorCode}`);
        Object.assign(error, { code: openSyncInterceptor.errorCode });
        throw error;
      }
      return (actual.openSync as (...a: typeof args) => number)(...args);
    },
    fstatSync: (...args: Parameters<typeof actual.fstatSync>) => {
      if (args[0] === fstatSyncInterceptor.failFd) {
        const error = new Error("permission denied");
        Object.assign(error, { code: "EACCES" });
        throw error;
      }
      return (actual.fstatSync as (...a: typeof args) => NodeFS.Stats)(...args);
    },
  };
});

/** Open a real file descriptor scoped to the test. */
const openFd = (filePath: string) =>
  Effect.acquireRelease(
    Effect.sync(() => NodeFS.openSync(filePath, "r")),
    (fd) => Effect.sync(() => NodeFS.closeSync(fd)),
  );

const withTempFile = Effect.fnUntraced(function* (contents: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fs.makeTempDirectoryScoped();
  const filePath = path.join(dir, "envelope");
  yield* fs.writeFileString(filePath, contents);
  return yield* openFd(filePath);
});

it.layer(NodeServices.layer)("readBootstrapEnvelope", (it) => {
  it.effect("reads the first JSON line from the file descriptor", () =>
    Effect.gen(function* () {
      const fd = yield* withTempFile(
        '{"desktopBootstrapToken":"boot-secret","port":13773}\ntrailing garbage\n',
      );
      const envelope = yield* readBootstrapEnvelope(fd);

      assert.isTrue(Option.isSome(envelope));
      if (Option.isSome(envelope)) {
        assert.equal(envelope.value.desktopBootstrapToken, "boot-secret");
        assert.equal(envelope.value.port, 13773);
      }
    }).pipe(Effect.scoped),
  );

  it.effect("skips leading blank lines and tolerates an absent port", () =>
    Effect.gen(function* () {
      const fd = yield* withTempFile('\n  \n{"desktopBootstrapToken":"boot-secret"}\n');
      const envelope = yield* readBootstrapEnvelope(fd);

      assert.isTrue(Option.isSome(envelope));
      if (Option.isSome(envelope)) {
        assert.notProperty(envelope.value, "port");
      }
    }).pipe(Effect.scoped),
  );

  it.effect("returns none for an empty file", () =>
    Effect.gen(function* () {
      const fd = yield* withTempFile("");
      assert.isTrue(Option.isNone(yield* readBootstrapEnvelope(fd)));
    }).pipe(Effect.scoped),
  );

  it.effect("returns none when the file descriptor is closed (EBADF)", () =>
    Effect.gen(function* () {
      // Open + close eagerly so the fd number is dead by the time it's read.
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped();
      const filePath = path.join(dir, "envelope");
      yield* fs.writeFileString(filePath, "{}");
      const fd = NodeFS.openSync(filePath, "r");
      NodeFS.closeSync(fd);

      assert.isTrue(Option.isNone(yield* readBootstrapEnvelope(fd)));
    }).pipe(Effect.scoped),
  );

  it.effect("fails with a decode error on malformed JSON", () =>
    Effect.gen(function* () {
      const fd = yield* withTempFile("not json at all\n");
      const error = yield* readBootstrapEnvelope(fd).pipe(Effect.flip);

      assert.equal(error._tag, "BootstrapEnvelopeDecodeError");
    }).pipe(Effect.scoped),
  );

  it.effect("falls back to reading the inherited fd when path duplication fails", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped();
      const filePath = path.join(dir, "envelope");
      yield* fs.writeFileString(filePath, '{"desktopBootstrapToken":"boot-secret"}\n');

      // Open without acquireRelease: the direct-stream fallback uses autoClose: true,
      // so the stream owns the fd lifecycle and closes it asynchronously on end.
      // Attempting to also close it synchronously in a finalizer races with the
      // stream's async close and produces an uncaught EBADF.
      const fd = NodeFS.openSync(filePath, "r");

      openSyncInterceptor.failPath = `/proc/self/fd/${fd}`;
      try {
        const envelope = yield* readBootstrapEnvelope(fd, { timeoutMs: 100 }).pipe(
          Effect.provideService(HostProcessPlatform, "linux"),
        );
        assertSome(envelope, {
          desktopBootstrapToken: "boot-secret",
        });
      } finally {
        openSyncInterceptor.failPath = null;
      }
    }).pipe(Effect.scoped),
  );

  it.effect("preserves fd path, platform, and cause when opening the input stream fails", () =>
    Effect.gen(function* () {
      const fd = yield* withTempFile('{"desktopBootstrapToken":"boot-secret"}\n');
      const fdPath = `/proc/self/fd/${fd}`;

      openSyncInterceptor.failPath = fdPath;
      openSyncInterceptor.errorCode = "EIO";
      try {
        const error = yield* readBootstrapEnvelope(fd, { timeoutMs: 100 }).pipe(
          Effect.provideService(HostProcessPlatform, "linux"),
          Effect.flip,
        );

        assert.instanceOf(error, BootstrapInputStreamOpenError);
        assert.equal(error.fd, fd);
        assert.equal(error.platform, "linux");
        assert.equal(error.fdPath, fdPath);
        assert.equal((error.cause as NodeJS.ErrnoException).code, "EIO");
        assert.equal(
          error.message,
          `Failed to open bootstrap input stream for file descriptor ${fd} via '${fdPath}' on 'linux'.`,
        );
      } finally {
        openSyncInterceptor.failPath = null;
        openSyncInterceptor.errorCode = "ENXIO";
      }
    }).pipe(Effect.scoped),
  );

  it.effect("preserves fd and cause when stat fails for a non-availability reason", () =>
    Effect.gen(function* () {
      const fd = yield* openFd("/dev/null");

      fstatSyncInterceptor.failFd = fd;
      try {
        const error = yield* readBootstrapEnvelope(fd, { timeoutMs: 100 }).pipe(Effect.flip);

        assert.instanceOf(error, BootstrapFdStatError);
        assert.equal(error.fd, fd);
        assert.equal((error.cause as NodeJS.ErrnoException).code, "EACCES");
        assert.equal(error.message, `Failed to stat bootstrap file descriptor ${fd}.`);
      } finally {
        fstatSyncInterceptor.failFd = null;
      }
    }).pipe(Effect.scoped),
  );

  it.effect("returns none when the bootstrap read times out before any value arrives", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "app-bootstrap-" });
      const fifoPath = NodePath.join(tempDir, "bootstrap.pipe");

      yield* Effect.sync(() => NodeChildProcess.execFileSync("mkfifo", [fifoPath]));

      const _writer = yield* Effect.acquireRelease(
        Effect.sync(() =>
          NodeChildProcess.spawn("sh", ["-c", 'exec 3>"$1"; sleep 60', "sh", fifoPath], {
            stdio: ["ignore", "ignore", "ignore"],
          }),
        ),
        (writer) =>
          Effect.sync(() => {
            writer.kill("SIGKILL");
          }),
      );

      const fd = yield* Effect.acquireRelease(
        Effect.sync(() => NodeFS.openSync(fifoPath, "r")),
        (fd) => Effect.sync(() => NodeFS.closeSync(fd)),
      );

      const fiber = yield* readBootstrapEnvelope(fd, { timeoutMs: 100 }).pipe(Effect.forkScoped);

      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.millis(100));

      const payload = yield* Fiber.join(fiber);
      assertNone(payload);
    }).pipe(Effect.scoped),
  );
});
