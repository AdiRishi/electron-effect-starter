import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as DesktopLogger from "../../src/app/DesktopLogger.ts";

const DesktopBackendChildLogRecord = Schema.Struct({
  message: Schema.String,
  level: Schema.Literals(["INFO", "ERROR"]),
  timestamp: Schema.String,
  annotations: Schema.Record(Schema.String, Schema.String),
  spans: Schema.Record(Schema.String, Schema.String),
  fiberId: Schema.String,
});

const decodeDesktopBackendChildLogRecord = Schema.decodeEffect(
  Schema.fromJsonString(DesktopBackendChildLogRecord),
);

const makeLogDirectory = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "desktop-logger-test-" });

  return { directory, logPath: path.join(directory, "server-child.log") };
});

const makeOutputLog = (logPath: string) =>
  Effect.gen(function* () {
    const logFile = yield* DesktopLogger.makeRotatingLogFileWriter({ filePath: logPath });

    return yield* DesktopLogger.makeBackendOutputLog({ isDevelopment: false, logFile });
  });

const readRecords = (logPath: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const lines = (yield* fileSystem.readFileString(logPath)).trimEnd().split("\n");

    return yield* Effect.forEach(lines, (line) => decodeDesktopBackendChildLogRecord(line));
  });

describe("DesktopLogger", () => {
  it.effect("rotates the log past its size limit without losing a write", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { directory } = yield* makeLogDirectory;
      const filePath = path.join(directory, "desktop.log");
      yield* fileSystem.writeFileString(`${filePath}.50`, "obsolete");

      const lines = Array.from(
        { length: 100 },
        (_, index) => `${index.toString().padStart(3, "0")}\n`,
      );

      const writer = yield* DesktopLogger.makeRotatingLogFileWriter({
        filePath,
        maxBytes: 32,
        maxFiles: 20,
      });

      yield* Effect.forEach(lines, (line) => writer.writeText(line), {
        concurrency: "unbounded",
        discard: true,
      });

      const resumed = yield* DesktopLogger.makeRotatingLogFileWriter({
        filePath,
        maxBytes: 32,
        maxFiles: 20,
      });

      yield* resumed.writeText("100\n");

      assert.isFalse(yield* fileSystem.exists(`${filePath}.50`));

      const backups = (yield* fileSystem.readDirectory(directory))
        .filter((name) => name.startsWith("desktop.log."))
        .toSorted((a, b) => Number(b.slice(12)) - Number(a.slice(12)));

      const contents = yield* Effect.forEach([...backups, "desktop.log"], (name) =>
        fileSystem.readFileString(path.join(directory, name)),
      );

      assert.isTrue(contents.every((chunk) => Buffer.byteLength(chunk) <= 32));
      assert.equal(contents.join(""), `${lines.join("")}100\n`);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("buffers server output and persists it only when a failure is reported", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const { logPath } = yield* makeLogDirectory;
      const outputLog = yield* makeOutputLog(logPath);

      yield* Effect.gen(function* () {
        yield* outputLog.beginSession({ details: "pid=123 port=3773 cwd=/repo" });
        yield* outputLog.writeOutputChunk("stdout", new TextEncoder().encode("hello server\n"));
        assert.isFalse(yield* fileSystem.exists(logPath));
        yield* outputLog.persistFailure({ details: "code=1" });
        yield* outputLog.beginSession({ details: "pid=456" });
        yield* outputLog.writeOutputChunk("stderr", new TextEncoder().encode("normal shutdown\n"));
        yield* outputLog.discardSession;
      }).pipe(Effect.annotateLogs({ runId: "test-run" }));

      const [start, output, end, ...rest] = yield* readRecords(logPath);

      assert.deepEqual(rest, []);
      assert.equal(start?.message, "backend child process failure output start");
      assert.equal(start?.level, "ERROR");
      assert.deepEqual(start?.annotations, {
        component: "desktop-backend-child",
        runId: "test-run",
        phase: "START",
        details: "pid=123 port=3773 cwd=/repo",
      });
      assert.equal(output?.message, "backend child process output");
      assert.equal(output?.level, "INFO");
      assert.equal(output?.annotations.stream, "stdout");
      assert.equal(output?.annotations.text, "hello server\n");
      assert.equal(end?.message, "backend child process failure output end");
      assert.equal(end?.annotations.phase, "END");
      assert.equal(end?.annotations.details, "code=1");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps buffering output after a non-terminal failure snapshot", () =>
    Effect.gen(function* () {
      const { logPath } = yield* makeLogDirectory;
      const outputLog = yield* makeOutputLog(logPath);

      yield* outputLog.beginSession({ details: "pid=123" });
      yield* outputLog.writeOutputChunk("stdout", new TextEncoder().encode("before timeout\n"));
      yield* outputLog.persistFailureSnapshot({ details: "readiness timeout" });
      yield* outputLog.writeOutputChunk("stderr", new TextEncoder().encode("after timeout\n"));
      yield* outputLog.persistFailure({ details: "code=1" });

      const records = yield* readRecords(logPath);

      assert.isTrue(records.some((record) => record.annotations.text === "after timeout\n"));
      assert.equal(records.at(-1)?.annotations.details, "code=1");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("retains only the last mebibyte of server output", () =>
    Effect.gen(function* () {
      const { logPath } = yield* makeLogDirectory;
      const outputLog = yield* makeOutputLog(logPath);
      const maxBufferedBytes = 1024 * 1024;
      const discardedPrefixBytes = 128;
      const output = new Uint8Array(maxBufferedBytes + discardedPrefixBytes);
      output.fill("x".charCodeAt(0));
      output.fill("y".charCodeAt(0), 0, discardedPrefixBytes);

      yield* outputLog.beginSession({ details: "pid=123" });
      yield* outputLog.writeOutputChunk("stderr", output);
      yield* outputLog.persistFailure({ details: "code=1" });

      const text = (yield* readRecords(logPath))[1]?.annotations.text ?? "";

      assert.equal(new TextEncoder().encode(text).byteLength, maxBufferedBytes);
      assert.isFalse(text.includes("y"));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
