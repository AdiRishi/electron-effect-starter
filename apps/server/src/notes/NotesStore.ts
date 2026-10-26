import {
  Note,
  NoteId,
  NoteNotFoundError,
  NotesStorageError,
  type NoteCreateInput,
  type NotesStreamEvent,
  type NoteUpdateInput,
} from "@app/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

type NoteChange = Exclude<NotesStreamEvent, { readonly type: "snapshot" }>;

const NoteRow = Schema.Struct({
  id: NoteId,
  title: Schema.String,
  body: Schema.String,
  created_at: Schema.DateTimeUtcFromString,
  updated_at: Schema.DateTimeUtcFromString,
});

const toNote = (row: typeof NoteRow.Type): Note => ({
  id: row.id,
  title: row.title,
  body: row.body,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

/**
 * Notes persisted in SQLite, with a change stream every client can follow. Each mutation bumps
 * an in-memory revision while holding the same lock a snapshot takes, so a subscriber that reads
 * the snapshot and then filters live events by revision sees every change exactly once.
 */
export class NotesStore extends Context.Service<
  NotesStore,
  {
    readonly create: (input: NoteCreateInput) => Effect.Effect<Note, NotesStorageError>;
    readonly update: (
      input: NoteUpdateInput,
    ) => Effect.Effect<Note, NoteNotFoundError | NotesStorageError>;
    readonly remove: (id: NoteId) => Effect.Effect<void, NoteNotFoundError | NotesStorageError>;
    readonly subscribe: Stream.Stream<NotesStreamEvent, NotesStorageError>;
  }
>()("@app/server/notes/NotesStore") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const changes = yield* PubSub.unbounded<NoteChange>();
  const revision = yield* Ref.make(0);
  const lock = yield* Semaphore.make(1);

  const findAll = SqlSchema.findAll({
    Request: Schema.Void,
    Result: NoteRow,
    execute: () => sql`SELECT * FROM notes ORDER BY updated_at DESC`,
  });

  const findById = SqlSchema.findOneOption({
    Request: NoteId,
    Result: NoteRow,
    execute: (id) => sql`SELECT * FROM notes WHERE id = ${id}`,
  });

  const insert = SqlSchema.void({
    Request: NoteRow,
    execute: (row) => sql`INSERT INTO notes ${sql.insert(row)}`,
  });

  const updateRow = SqlSchema.void({
    Request: NoteRow,
    execute: (row) =>
      sql`UPDATE notes SET title = ${row.title}, body = ${row.body}, updated_at = ${row.updated_at} WHERE id = ${row.id}`,
  });

  const deleteById = SqlSchema.void({
    Request: NoteId,
    execute: (id) => sql`DELETE FROM notes WHERE id = ${id}`,
  });

  const storageError =
    (operation: NotesStorageError["operation"]) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(Effect.mapError(() => new NotesStorageError({ operation })));

  const publish = (change: (revision: number) => NoteChange) =>
    Ref.updateAndGet(revision, (current) => current + 1).pipe(
      Effect.flatMap((next) => PubSub.publish(changes, change(next))),
    );

  const create = Effect.fn("NotesStore.create")(function* (input: NoteCreateInput) {
    const id = NoteId.make(yield* crypto.randomUUIDv4().pipe(storageError("create")));
    const now = yield* DateTime.now;
    const note: Note = { id, title: input.title, body: input.body, createdAt: now, updatedAt: now };
    yield* insert({
      id,
      title: note.title,
      body: note.body,
      created_at: now,
      updated_at: now,
    }).pipe(storageError("create"));
    yield* publish((next) => ({ type: "upserted", revision: next, note }));

    return note;
  }, lock.withPermit);

  const update = Effect.fn("NotesStore.update")(function* (input: NoteUpdateInput) {
    const existing = yield* findById(input.id).pipe(storageError("update"));

    if (Option.isNone(existing)) return yield* new NoteNotFoundError({ id: input.id });

    const note: Note = {
      ...toNote(existing.value),
      title: input.title,
      body: input.body,
      updatedAt: yield* DateTime.now,
    };

    yield* updateRow({
      id: note.id,
      title: note.title,
      body: note.body,
      created_at: note.createdAt,
      updated_at: note.updatedAt,
    }).pipe(storageError("update"));
    yield* publish((next) => ({ type: "upserted", revision: next, note }));

    return note;
  }, lock.withPermit);

  const remove = Effect.fn("NotesStore.remove")(function* (id: NoteId) {
    const existing = yield* findById(id).pipe(storageError("delete"));

    if (Option.isNone(existing)) return yield* new NoteNotFoundError({ id });
    yield* deleteById(id).pipe(storageError("delete"));
    yield* publish((next) => ({ type: "removed", revision: next, id }));
  }, lock.withPermit);

  const snapshot = Effect.all({
    notes: findAll().pipe(storageError("list")),
    revision: Ref.get(revision),
  }).pipe(lock.withPermit);

  const subscribe: NotesStore["Service"]["subscribe"] = Stream.unwrap(
    Effect.gen(function* () {
      // Subscribe before reading the snapshot so no change lands between the two.
      const live = yield* PubSub.subscribe(changes);
      const current = yield* snapshot;

      const initial: NotesStreamEvent = {
        type: "snapshot",
        revision: current.revision,
        notes: current.notes.map(toNote),
      };

      return Stream.concat(
        Stream.make(initial),
        Stream.fromSubscription(live).pipe(
          Stream.filter((change) => change.revision > current.revision),
        ),
      );
    }),
  );

  return NotesStore.of({ create, update, remove, subscribe });
});

export const layer = Layer.effect(NotesStore, make);
