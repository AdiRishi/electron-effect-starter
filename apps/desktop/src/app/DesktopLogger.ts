import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { flow } from "effect/Function";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Ref from "effect/Ref";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as DesktopEnvironment from "./DesktopEnvironment.ts";

const DESKTOP_LOG_FILE_MAX_BYTES = 10 * 1024 * 1024;
const DESKTOP_LOG_FILE_MAX_FILES = 10;
const DESKTOP_LOG_BATCH_WINDOW = "1 second";
const DESKTOP_BACKEND_CHILD_LOG_FIBER_ID = "#backend-child";
const DESKTOP_BACKEND_OUTPUT_BUFFER_MAX_BYTES = 1024 * 1024;
const DESKTOP_BACKEND_OUTPUT_BUFFER_MAX_CHUNKS = 256;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export interface RotatingLogFileWriter {
  readonly writeBytes: (chunk: Uint8Array) => Effect.Effect<void>;
  readonly writeText: (chunk: string) => Effect.Effect<void>;
}

class DesktopLogFileWriterConfigurationError extends Schema.TaggedError<DesktopLogFileWriterConfigurationError>()(
  "DesktopLogFileWriterConfigurationError",
  {
    option: Schema.Literals(["maxBytes", "maxFiles"]),
    value: Schema.Number,
  },
) {
  override get message() {
    return `${this.option} must be >= 1 (received ${this.value})`;
  }
}

const refreshFileSize = (
  fileSystem: FileSystem.FileSystem,
  filePath: string,
): Effect.Effect<number> =>
  fileSystem.stat(filePath).pipe(
    Effect.map((stat) => Number(stat.size)),
    Effect.orElseSucceed(() => 0),
  );

/**
 * Appends to a log file, rotating it to `.1` … `.maxFiles` once it passes `maxBytes`. A failed write
 * is dropped rather than surfaced, so logging can never take the app down.
 */
export const makeRotatingLogFileWriter = Effect.fn("makeRotatingLogFileWriter")(function* (input: {
  readonly filePath: string;
  readonly maxBytes?: number;
  readonly maxFiles?: number;
}): Effect.fn.Return<
  RotatingLogFileWriter,
  DesktopLogFileWriterConfigurationError | PlatformError.PlatformError,
  FileSystem.FileSystem | Path.Path
> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const maxBytes = input.maxBytes ?? DESKTOP_LOG_FILE_MAX_BYTES;
  const maxFiles = input.maxFiles ?? DESKTOP_LOG_FILE_MAX_FILES;
  const directory = path.dirname(input.filePath);
  const baseName = path.basename(input.filePath);

  if (maxBytes < 1) {
    return yield* new DesktopLogFileWriterConfigurationError({
      option: "maxBytes",
      value: maxBytes,
    });
  }

  if (maxFiles < 1) {
    return yield* new DesktopLogFileWriterConfigurationError({
      option: "maxFiles",
      value: maxFiles,
    });
  }

  yield* fileSystem.makeDirectory(directory, { recursive: true });

  const withSuffix = (index: number) => `${input.filePath}.${index}`;
  const currentSize = yield* Ref.make(yield* refreshFileSize(fileSystem, input.filePath));
  const mutex = yield* Semaphore.make(1);

  const pruneOverflowBackups = Effect.gen(function* () {
    const entries = yield* fileSystem.readDirectory(directory).pipe(Effect.orElseSucceed(() => []));

    for (const entry of entries) {
      if (!entry.startsWith(`${baseName}.`)) continue;
      const suffix = Number(entry.slice(baseName.length + 1));

      if (!Number.isInteger(suffix) || suffix <= maxFiles) continue;
      yield* fileSystem.remove(path.join(directory, entry), { force: true }).pipe(Effect.ignore);
    }
  });

  const rotate = Effect.gen(function* () {
    yield* fileSystem.remove(withSuffix(maxFiles), { force: true }).pipe(Effect.ignore);

    for (let index = maxFiles - 1; index >= 1; index -= 1) {
      const source = withSuffix(index);
      const sourceExists = yield* fileSystem.exists(source).pipe(Effect.orElseSucceed(() => false));

      if (sourceExists) yield* fileSystem.rename(source, withSuffix(index + 1));
    }

    const currentExists = yield* fileSystem
      .exists(input.filePath)
      .pipe(Effect.orElseSucceed(() => false));

    if (currentExists) yield* fileSystem.rename(input.filePath, withSuffix(1));
    yield* Ref.set(currentSize, 0);
  }).pipe(
    Effect.catch(() =>
      refreshFileSize(fileSystem, input.filePath).pipe(
        Effect.flatMap((size) => Ref.set(currentSize, size)),
      ),
    ),
  );

  const writeBytes = (chunk: Uint8Array): Effect.Effect<void> => {
    if (chunk.byteLength === 0) return Effect.void;

    return mutex.withPermits(1)(
      Effect.gen(function* () {
        const beforeSize = yield* Ref.get(currentSize);

        if (beforeSize > 0 && beforeSize + chunk.byteLength > maxBytes) yield* rotate;

        yield* fileSystem.writeFile(input.filePath, chunk, { flag: "a" });
        const afterSize = (yield* Ref.get(currentSize)) + chunk.byteLength;
        yield* Ref.set(currentSize, afterSize);

        if (afterSize > maxBytes) yield* rotate;
      }).pipe(
        Effect.catch(() =>
          refreshFileSize(fileSystem, input.filePath).pipe(
            Effect.flatMap((size) => Ref.set(currentSize, size)),
          ),
        ),
      ),
    );
  };

  yield* pruneOverflowBackups;

  return {
    writeBytes,
    writeText: (chunk) => writeBytes(textEncoder.encode(chunk)),
  } satisfies RotatingLogFileWriter;
});

/** Logs to the terminal and to a rotating JSON-lines file, since a packaged app has no terminal. */
export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const path = yield* Path.Path;

    const logFile = yield* makeRotatingLogFileWriter({
      filePath: path.join(environment.logDir, "desktop.log"),
    });

    return Logger.layer(
      [
        Logger.consolePretty(),
        Logger.batched(Logger.formatJson, {
          window: DESKTOP_LOG_BATCH_WINDOW,
          flush: (lines) => logFile.writeText(`${lines.join("\n")}\n`),
        }),
      ],
      { mergeWithExisting: false },
    );
  }),
);

/** Effect's log functions, annotating every line with the part of the shell that wrote it. */
export const forComponent = (component: string) => {
  const annotate = Effect.annotateLogs({ component });

  return {
    logInfo: flow(Effect.logInfo, annotate),
    logWarning: flow(Effect.logWarning, annotate),
    logError: flow(Effect.logError, annotate),
  };
};

/**
 * Keeps the recent output of one server run. Development echoes it to the terminal; a run that fails
 * has its buffered output written to `server-child.log`, and a run that stops cleanly discards it.
 */
export interface DesktopBackendOutputLog {
  readonly beginSession: (input: { readonly details: string }) => Effect.Effect<void>;
  readonly writeOutputChunk: (
    streamName: "stdout" | "stderr",
    chunk: Uint8Array,
  ) => Effect.Effect<void>;
  readonly persistFailureSnapshot: (input: { readonly details: string }) => Effect.Effect<void>;
  readonly persistFailure: (input: { readonly details: string }) => Effect.Effect<void>;
  readonly discardSession: Effect.Effect<void>;
}

const sanitizeLogValue = (value: string): string => value.replace(/\s+/g, " ").trim();

const DesktopBackendChildLogRecord = Schema.Struct({
  message: Schema.String,
  level: Schema.Literals(["INFO", "ERROR"]),
  timestamp: Schema.String,
  annotations: Schema.Record(Schema.String, Schema.String),
  spans: Schema.Record(Schema.String, Schema.String),
  fiberId: Schema.String,
});

const encodeDesktopBackendChildLogRecord = Schema.encodeEffect(
  Schema.fromJsonString(DesktopBackendChildLogRecord),
);

interface BufferedBackendOutputChunk {
  readonly streamName: "stdout" | "stderr";
  readonly chunk: Uint8Array;
  readonly offset: number;
}

interface BackendOutputSession {
  readonly runId: string;
  readonly startDetails: string;
  readonly chunks: ReadonlyArray<BufferedBackendOutputChunk>;
  readonly byteLength: number;
}

function appendBoundedOutputChunk(
  session: BackendOutputSession,
  streamName: "stdout" | "stderr",
  chunk: Uint8Array,
): BackendOutputSession {
  if (chunk.byteLength === 0) return session;

  const retainedChunk =
    chunk.byteLength > DESKTOP_BACKEND_OUTPUT_BUFFER_MAX_BYTES
      ? chunk.slice(chunk.byteLength - DESKTOP_BACKEND_OUTPUT_BUFFER_MAX_BYTES)
      : chunk.slice();

  const chunks = [...session.chunks, { streamName, chunk: retainedChunk, offset: 0 }];
  let byteLength = session.byteLength + retainedChunk.byteLength;
  let overflow = Math.max(0, byteLength - DESKTOP_BACKEND_OUTPUT_BUFFER_MAX_BYTES);
  let firstRetainedIndex = 0;

  while (overflow > 0) {
    const first = chunks[firstRetainedIndex];

    if (!first) break;
    const retainedByteLength = first.chunk.byteLength - first.offset;

    if (retainedByteLength <= overflow) {
      overflow -= retainedByteLength;
      byteLength -= retainedByteLength;
      firstRetainedIndex += 1;
      continue;
    }

    chunks[firstRetainedIndex] = { ...first, offset: first.offset + overflow };
    byteLength -= overflow;
    overflow = 0;
  }

  const excessChunks = Math.max(
    0,
    chunks.length - firstRetainedIndex - DESKTOP_BACKEND_OUTPUT_BUFFER_MAX_CHUNKS,
  );

  for (let index = firstRetainedIndex; index < firstRetainedIndex + excessChunks; index += 1) {
    const excess = chunks[index];
    byteLength -= excess ? excess.chunk.byteLength - excess.offset : 0;
  }

  firstRetainedIndex += excessChunks;

  return { ...session, chunks: chunks.slice(firstRetainedIndex), byteLength };
}

const currentDesktopRunId = Effect.gen(function* () {
  const annotations = yield* References.CurrentLogAnnotations;
  const runId = annotations.runId;

  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Log annotations are untyped values.
  return typeof runId === "string" && runId.length > 0 ? runId : "unknown";
});

const writeDevelopmentConsoleOutput = (
  streamName: "stdout" | "stderr",
  chunk: Uint8Array,
): Effect.Effect<void> =>
  Effect.sync(() => {
    const output = streamName === "stderr" ? process.stderr : process.stdout;
    output.write(chunk);
  }).pipe(Effect.ignore);

const writeBackendChildLogRecord = Effect.fn("DesktopLogger.writeBackendChildLogRecord")(function* (
  logFile: RotatingLogFileWriter,
  input: {
    readonly message: string;
    readonly level: "INFO" | "ERROR";
    readonly annotations: Record<string, string>;
  },
) {
  yield* Effect.gen(function* () {
    const encoded = yield* encodeDesktopBackendChildLogRecord({
      message: input.message,
      level: input.level,
      timestamp: DateTime.formatIso(yield* DateTime.now),
      annotations: input.annotations,
      spans: {},
      fiberId: DESKTOP_BACKEND_CHILD_LOG_FIBER_ID,
    });

    yield* logFile.writeText(`${encoded}\n`);
  }).pipe(Effect.ignore({ log: true }));
});

export const makeBackendOutputLog = Effect.fn("DesktopLogger.makeBackendOutputLog")(
  function* (input: { readonly isDevelopment: boolean; readonly logFile: RotatingLogFileWriter }) {
    const { logFile } = input;
    const sessionRef = yield* Ref.make(Option.none<BackendOutputSession>());

    const writeFailure = Effect.fn("DesktopLogger.backendOutput.writeFailure")(function* (
      session: BackendOutputSession,
      details: string,
    ) {
      yield* writeBackendChildLogRecord(logFile, {
        message: "backend child process failure output start",
        level: "ERROR",
        annotations: {
          component: "desktop-backend-child",
          runId: session.runId,
          phase: "START",
          details: session.startDetails,
        },
      });

      for (const output of session.chunks) {
        yield* writeBackendChildLogRecord(logFile, {
          message: "backend child process output",
          level: output.streamName === "stderr" ? "ERROR" : "INFO",
          annotations: {
            component: "desktop-backend-child",
            runId: session.runId,
            stream: output.streamName,
            text: textDecoder.decode(output.chunk.subarray(output.offset)),
          },
        });
      }

      yield* writeBackendChildLogRecord(logFile, {
        message: "backend child process failure output end",
        level: "ERROR",
        annotations: {
          component: "desktop-backend-child",
          runId: session.runId,
          phase: "END",
          details: sanitizeLogValue(details),
        },
      });
    });

    return {
      beginSession: Effect.fn("DesktopLogger.backendOutput.beginSession")(function* ({ details }) {
        const runId = yield* currentDesktopRunId;

        yield* Ref.set(
          sessionRef,
          Option.some({
            runId,
            startDetails: sanitizeLogValue(details),
            chunks: [],
            byteLength: 0,
          }),
        );
      }),
      // Output streams continuously; a span per chunk would flood the trace.
      writeOutputChunk: Effect.fnUntraced(function* (streamName, chunk) {
        if (input.isDevelopment) yield* writeDevelopmentConsoleOutput(streamName, chunk);

        yield* Ref.update(
          sessionRef,
          Option.map((session) => appendBoundedOutputChunk(session, streamName, chunk)),
        );
      }),
      persistFailureSnapshot: Effect.fn("DesktopLogger.backendOutput.persistFailureSnapshot")(
        function* ({ details }) {
          const session = yield* Ref.get(sessionRef);

          if (Option.isSome(session)) yield* writeFailure(session.value, details);
        },
      ),
      persistFailure: Effect.fn("DesktopLogger.backendOutput.persistFailure")(function* ({
        details,
      }) {
        const session = yield* Ref.modify(sessionRef, (current) => [current, Option.none()]);

        if (Option.isNone(session)) return;
        yield* writeFailure(session.value, details);
      }),
      discardSession: Ref.set(sessionRef, Option.none()),
    } satisfies DesktopBackendOutputLog;
  },
);
