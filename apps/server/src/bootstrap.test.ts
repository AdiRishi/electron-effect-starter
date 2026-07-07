import * as NodeFS from "node:fs";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { readBootstrapEnvelope } from "./bootstrap.ts";

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
});
