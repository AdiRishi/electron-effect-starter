import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { NoteId, NoteNotFoundError, type NotesStreamEvent } from "@app/contracts";

import * as ServerConfig from "../../src/config.ts";
import * as NotesStore from "../../src/notes/NotesStore.ts";

const decodeNoteId = Schema.decodeUnknownSync(NoteId);

const testConfig = (dataDir: string) =>
  ServerConfig.layer(
    ServerConfig.make({
      appName: "Test App",
      version: "0.0.0-test",
      startedAt: DateTime.makeUnsafe(0),
      host: "127.0.0.1",
      port: 0,
      staticDir: undefined,
      devWebUrl: undefined,
      bootstrapToken: "boot-secret",
      dataDir,
    }),
  );

/** A fresh store over a scoped temp dataDir. */
const makeStore = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const dataDir = yield* fileSystem.makeTempDirectoryScoped();
  const store = yield* NotesStore.make.pipe(
    Effect.provide(testConfig(dataDir)),
    Effect.provide(NodeServices.layer),
  );
  return { store, dataDir };
});

const eventSummary = (event: NotesStreamEvent) =>
  event.type === "snapshot"
    ? ([event.sequence, event.type, event.notes.length] as const)
    : ([event.sequence, event.type] as const);

it.layer(NodeServices.layer)("NotesStore", (it) => {
  describe("mutations", () => {
    it.effect("creates, updates, and removes notes with sequenced events", () =>
      Effect.gen(function* () {
        const { store } = yield* makeStore;

        const created = yield* store.create({ text: "first" });
        assert.strictEqual(created.text, "first");

        const updated = yield* store.update({ id: created.id, text: "edited" });
        assert.strictEqual(updated.text, "edited");
        assert.strictEqual(updated.id, created.id);
        assert.isTrue(DateTime.isGreaterThanOrEqualTo(updated.updatedAt, created.updatedAt));

        yield* store.remove({ id: created.id });

        // The next subscriber's snapshot reflects all three mutations.
        const events = yield* store.changes.pipe(Stream.take(1), Stream.runCollect);
        assert.deepStrictEqual(eventSummary(events[0]!), [3, "snapshot", 0]);
      }).pipe(Effect.scoped),
    );

    it.effect("fails update and remove with NoteNotFoundError for unknown ids", () =>
      Effect.gen(function* () {
        const { store } = yield* makeStore;
        const missing = decodeNoteId("missing");

        const failsWithNotFound = (exit: Exit.Exit<unknown, unknown>) =>
          Exit.isFailure(exit) &&
          exit.cause.reasons.some(
            (reason) => reason._tag === "Fail" && reason.error instanceof NoteNotFoundError,
          );

        const updateExit = yield* store.update({ id: missing, text: "x" }).pipe(Effect.exit);
        assert.isTrue(failsWithNotFound(updateExit));

        const removeExit = yield* store.remove({ id: missing }).pipe(Effect.exit);
        assert.isTrue(failsWithNotFound(removeExit));
      }).pipe(Effect.scoped),
    );
  });

  describe("changes stream", () => {
    it.effect("delivers the snapshot first, then live events in sequence order", () =>
      Effect.gen(function* () {
        const { store } = yield* makeStore;
        yield* store.create({ text: "pre-existing" });

        const collector = yield* store.changes.pipe(
          Stream.take(3),
          Stream.runCollect,
          Effect.forkChild,
        );
        // Let the subscriber attach before the live mutations fire.
        yield* Effect.yieldNow;
        const second = yield* store.create({ text: "live one" });
        yield* store.remove({ id: second.id });

        const events = yield* Fiber.join(collector);
        assert.deepStrictEqual(events.map(eventSummary), [
          [1, "snapshot", 1],
          [2, "noteUpserted"],
          [3, "noteRemoved"],
        ]);
      }).pipe(Effect.scoped),
    );
  });

  describe("persistence", () => {
    it.effect("a new store instance over the same dataDir sees persisted notes", () =>
      Effect.gen(function* () {
        const { store, dataDir } = yield* makeStore;
        yield* store.create({ text: "survives restarts" });

        const reopened = yield* NotesStore.make.pipe(
          Effect.provide(testConfig(dataDir)),
          Effect.provide(NodeServices.layer),
        );
        const events = yield* reopened.changes.pipe(Stream.take(1), Stream.runCollect);
        const snapshot = events[0]!;
        assert.strictEqual(snapshot.type, "snapshot");
        if (snapshot.type === "snapshot") {
          assert.strictEqual(snapshot.notes[0]?.text, "survives restarts");
        }
      }).pipe(Effect.scoped),
    );
  });
});

// Keep the corrupt-file case out of the harness above so the layer types stay
// simple: it only needs FileSystem + a store over a pre-poisoned dataDir.
it.layer(NodeServices.layer)("NotesStore corrupt file", (it) => {
  it.effect("starts empty when notes.json does not parse", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const dataDir = yield* fileSystem.makeTempDirectoryScoped();
      yield* fileSystem.writeFileString(`${dataDir}/notes.json`, "not json {");

      const store = yield* NotesStore.make.pipe(
        Effect.provide(testConfig(dataDir)),
        Effect.provide(NodeServices.layer),
      );
      const events = yield* store.changes.pipe(Stream.take(1), Stream.runCollect);
      assert.deepStrictEqual(eventSummary(events[0]!), [0, "snapshot", 0]);
    }).pipe(Effect.scoped),
  );
});
