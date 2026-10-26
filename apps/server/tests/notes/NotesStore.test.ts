import { NoteId, type NotesStreamEvent } from "@app/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import * as NotesStore from "../../src/notes/NotesStore.ts";
import * as Sqlite from "../../src/persistence/Sqlite.ts";

const layer = NotesStore.layer.pipe(
  Layer.provide(Sqlite.layerMemory),
  Layer.provide(NodeServices.layer),
);

describe("NotesStore", () => {
  it.layer(layer)((it) => {
    it.effect("starts a subscription with a snapshot and follows it with each change once", () =>
      Effect.gen(function* () {
        const notes = yield* NotesStore.NotesStore;
        const existing = yield* notes.create({ title: "Existing", body: "" });

        const events = yield* Queue.unbounded<NotesStreamEvent>();
        yield* notes.subscribe.pipe(
          Stream.runForEach((event) => Queue.offer(events, event)),
          Effect.forkScoped,
        );
        // The snapshot arrives after the subscription is live, so later changes cannot be missed.
        const snapshot = yield* Queue.take(events);
        const created = yield* notes.create({ title: "Created", body: "first" });
        yield* notes.update({ id: created.id, title: "Created", body: "second" });
        const upserted = yield* Queue.take(events);
        const updated = yield* Queue.take(events);

        assert.strictEqual(snapshot.type, "snapshot");
        assert.deepStrictEqual(
          snapshot.type === "snapshot" ? snapshot.notes.map((note) => note.id) : [],
          [existing.id],
        );
        assert.strictEqual(upserted.type === "upserted" ? upserted.note.body : null, "first");
        assert.strictEqual(updated.type === "upserted" ? updated.note.body : null, "second");
      }),
    );

    it.effect("fails to update or delete a note that does not exist", () =>
      Effect.gen(function* () {
        const notes = yield* NotesStore.NotesStore;
        const id = NoteId.make("missing-note");
        const updateError = yield* Effect.flip(notes.update({ id, title: "Title", body: "" }));
        const removeError = yield* Effect.flip(notes.remove(id));
        assert.strictEqual(updateError._tag, "NoteNotFoundError");
        assert.strictEqual(removeError._tag, "NoteNotFoundError");
      }),
    );
  });
});
