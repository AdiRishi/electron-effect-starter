// @effect-diagnostics-next-line nodeBuiltinImport:off -- The reader takes a raw descriptor, which only node:fs opens.
import * as NodeFS from "node:fs";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { readBootstrapEnvelope } from "../src/bootstrap.ts";

const openEnvelopeFd = Effect.fn("test.openEnvelopeFd")(function* (contents: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "app-bootstrap-" });
  const file = path.join(directory, "envelope");
  yield* fs.writeFileString(file, contents);
  return yield* Effect.acquireRelease(
    Effect.sync(() => NodeFS.openSync(file, "r")),
    (fd) =>
      Effect.sync(() => {
        try {
          NodeFS.closeSync(fd);
        } catch {}
      }),
  );
});

describe("readBootstrapEnvelope", () => {
  it.layer(NodeServices.layer)((it) => {
    it.effect("decodes the envelope the desktop shell writes", () =>
      Effect.gen(function* () {
        const fd = yield* openEnvelopeFd(
          `${JSON.stringify({
            mode: "desktop",
            port: 4123,
            host: "127.0.0.1",
            baseDir: "/tmp/app",
            desktopBootstrapToken: "secret",
          })}\n`,
        );
        const envelope = yield* readBootstrapEnvelope(fd);
        assert.deepStrictEqual(
          Option.map(envelope, (value) => value.port),
          Option.some(4123),
        );
      }),
    );

    it.effect("fails on an envelope that does not match the contract", () =>
      Effect.gen(function* () {
        const fd = yield* openEnvelopeFd(`${JSON.stringify({ mode: "desktop", port: 0 })}\n`);
        const error = yield* Effect.flip(readBootstrapEnvelope(fd));
        assert.strictEqual(error._tag, "BootstrapEnvelopeDecodeError");
      }),
    );

    it.effect("finds nothing on a descriptor that is not open", () =>
      Effect.gen(function* () {
        assert.isTrue(Option.isNone(yield* readBootstrapEnvelope(987_654)));
      }),
    );
  });
});
