// @effect-diagnostics nodeBuiltinImport:off -- The bootstrap pipe is a raw inherited file descriptor.
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeReadline from "node:readline";
import type * as NodeStream from "node:stream";

import { DesktopBackendBootstrap } from "@app/contracts";
import * as HostProcess from "@app/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

export class BootstrapEnvelopeReadError extends Schema.TaggedError<BootstrapEnvelopeReadError>()(
  "BootstrapEnvelopeReadError",
  {
    fd: Schema.Number,
    stage: Schema.Literals(["stat", "open", "read"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to ${this.stage} the bootstrap file descriptor ${this.fd}.`;
  }
}

export class BootstrapEnvelopeDecodeError extends Schema.TaggedError<BootstrapEnvelopeDecodeError>()(
  "BootstrapEnvelopeDecodeError",
  {
    fd: Schema.Number,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to decode the bootstrap envelope from file descriptor ${this.fd}.`;
  }
}

const decodeBootstrapLine = Schema.decodeResult(Schema.fromJsonString(DesktopBackendBootstrap));

const isUnavailableFdError = Predicate.compose(
  Predicate.hasProperty("code"),
  (error) => error.code === "EBADF" || error.code === "ENOENT",
);

// Inherited pipes cannot always be reopened through /dev/fd or /proc/self/fd.
const isFdPathDuplicationError = Predicate.compose(
  Predicate.hasProperty("code"),
  (error) =>
    error.code === "ENXIO" ||
    error.code === "EINVAL" ||
    error.code === "EPERM" ||
    error.code === "EACCES",
);

function resolveFdPath(fd: number, platform: NodeJS.Platform): string | undefined {
  if (platform === "linux") return `/proc/self/fd/${fd}`;

  if (platform === "win32") return undefined;

  return `/dev/fd/${fd}`;
}

const makeDirectStream = (fd: number): NodeStream.Readable => {
  try {
    return NodeFS.createReadStream("", { fd, encoding: "utf8", autoClose: true });
  } catch {
    const socket = new NodeNet.Socket({ fd, readable: true, writable: false });
    socket.setEncoding("utf8");

    return socket;
  }
};

const isFdReady = (fd: number) =>
  Effect.try({
    try: () => NodeFS.fstatSync(fd),
    catch: (cause) => new BootstrapEnvelopeReadError({ fd, stage: "stat", cause }),
  }).pipe(
    Effect.as(true),
    Effect.catchTags({
      BootstrapEnvelopeReadError: (error) =>
        isUnavailableFdError(error.cause) ? Effect.succeed(false) : Effect.fail(error),
    }),
  );

const openStream = Effect.fn("bootstrap.openStream")(function* (fd: number) {
  const fdPath = resolveFdPath(fd, yield* HostProcess.Platform);

  return yield* Effect.try({
    try: (): NodeStream.Readable => {
      if (fdPath === undefined) return makeDirectStream(fd);
      let streamFd: number | undefined;

      try {
        streamFd = NodeFS.openSync(fdPath, "r");

        return NodeFS.createReadStream("", { fd: streamFd, encoding: "utf8", autoClose: true });
      } catch (error) {
        if (!isFdPathDuplicationError(error)) throw error;

        if (streamFd !== undefined) NodeFS.closeSync(streamFd);

        return makeDirectStream(fd);
      }
    },
    catch: (cause) => new BootstrapEnvelopeReadError({ fd, stage: "open", cause }),
  });
});

/**
 * Reads the one-line JSON envelope the desktop shell writes to an inherited file descriptor. Keeps
 * secrets out of argv and the environment, where other processes on the machine can read them.
 */
export const readBootstrapEnvelope = Effect.fn("readBootstrapEnvelope")(function* (
  fd: number,
  options?: { readonly timeoutMs?: number },
): Effect.fn.Return<
  Option.Option<DesktopBackendBootstrap>,
  BootstrapEnvelopeReadError | BootstrapEnvelopeDecodeError,
  never
> {
  if (!(yield* isFdReady(fd))) return Option.none();
  const stream = yield* openStream(fd);

  return yield* Effect.callback<
    Option.Option<DesktopBackendBootstrap>,
    BootstrapEnvelopeReadError | BootstrapEnvelopeDecodeError
  >((resume) => {
    const input = NodeReadline.createInterface({ input: stream, crlfDelay: Infinity });

    const handleError = (error: Error) => {
      resume(
        isUnavailableFdError(error)
          ? Effect.succeedNone
          : Effect.fail(new BootstrapEnvelopeReadError({ fd, stage: "read", cause: error })),
      );
    };

    const handleLine = (line: string) => {
      const decoded = decodeBootstrapLine(line);
      resume(
        Result.isSuccess(decoded)
          ? Effect.succeedSome(decoded.success)
          : Effect.fail(new BootstrapEnvelopeDecodeError({ fd, cause: decoded.failure })),
      );
    };

    const handleClose = () => resume(Effect.succeedNone);

    stream.once("error", handleError);
    input.once("line", handleLine);
    input.once("close", handleClose);

    return Effect.sync(() => {
      stream.removeListener("error", handleError);
      input.removeListener("line", handleLine);
      input.removeListener("close", handleClose);
      input.close();
      stream.destroy();
    });
  }).pipe(Effect.timeoutOption(options?.timeoutMs ?? 1_000), Effect.map(Option.flatten));
});
