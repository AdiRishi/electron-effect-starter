/**
 * Notes store — the sample domain service.
 *
 * State lives in a `SynchronizedRef` (a monotonic sequence + the notes list),
 * changes are persisted atomically to `dataDir/notes.json`, and every mutation
 * publishes a sequenced event so `changes` can serve the snapshot-then-live
 * push-bus contract declared in `@app/contracts` notes.ts. Delete this
 * directory (and the `notes.*` registrations in ws.ts/server.ts) to remove the
 * sample domain.
 *
 * @module notes/NotesStore
 */
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";

import {
  Note,
  NoteId,
  NoteNotFoundError,
  type NoteCreateInput,
  type NoteDeleteInput,
  type NoteRemovedEvent,
  type NotesSnapshotEvent,
  type NotesStreamEvent,
  type NoteUpdateInput,
  type NoteUpsertedEvent,
} from "@app/contracts";
import { writeFileStringAtomically } from "@app/shared/atomicWrite";

import * as ServerConfig from "../config.ts";

const NOTES_FILE = "notes.json";

// On-disk shape: the notes list under a named key, JSON-encoded (ISO dates).
const NotesDocument = Schema.Struct({
  notes: Schema.Array(Note),
});
const NotesDocumentJson = Schema.fromJsonString(Schema.toCodecJson(NotesDocument));
const decodeNotesDocument = Schema.decodeUnknownEffect(NotesDocumentJson);
const encodeNotesDocument = Schema.encodeUnknownEffect(NotesDocumentJson);
const decodeNoteId = Schema.decodeEffect(NoteId);

interface NotesState {
  readonly sequence: number;
  readonly notes: ReadonlyArray<Note>;
}

export class NotesStore extends Context.Service<
  NotesStore,
  {
    readonly create: (input: NoteCreateInput) => Effect.Effect<Note>;
    readonly update: (input: NoteUpdateInput) => Effect.Effect<Note, NoteNotFoundError>;
    readonly remove: (input: NoteDeleteInput) => Effect.Effect<void, NoteNotFoundError>;
    /**
     * One `snapshot` event, then live events filtered to newer sequences.
     * Subscribers fold these into current state; a reconnect just re-folds
     * from the fresh snapshot.
     */
    readonly changes: Stream.Stream<NotesStreamEvent>;
  }
>()("@app/server/notes/NotesStore") {}

function readNotes(
  fileSystem: FileSystem.FileSystem,
  notesPath: string,
): Effect.Effect<ReadonlyArray<Note>> {
  // Missing or corrupt file → start empty, same posture as the desktop
  // settings store: domain state must never block server startup.
  return fileSystem.readFileString(notesPath).pipe(
    Effect.flatMap((raw) => decodeNotesDocument(raw)),
    Effect.map((document) => document.notes),
    Effect.orElseSucceed((): ReadonlyArray<Note> => []),
  );
}

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const crypto = yield* Crypto.Crypto;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const notesPath = path.join(config.dataDir, NOTES_FILE);
  const initialNotes = yield* readNotes(fileSystem, notesPath);
  const state = yield* SynchronizedRef.make<NotesState>({
    sequence: 0,
    notes: initialNotes,
  });
  const pubsub = yield* PubSub.unbounded<NoteUpsertedEvent | NoteRemovedEvent>();

  // Encoding our own values only fails on a schema bug, and a persistence
  // failure (disk full, permissions) is not actionable by the renderer —
  // both surface as defects so the mutation surface stays cleanly typed.
  const persist = (notes: ReadonlyArray<Note>) =>
    encodeNotesDocument({ notes }).pipe(
      Effect.flatMap((contents) =>
        writeFileStringAtomically({ filePath: notesPath, contents: `${contents}\n` }),
      ),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.orDie,
    );

  // Mutations run inside `SynchronizedRef.modifyEffect`, and the publish
  // happens INSIDE that critical section: unlike the lifecycle bus (a single
  // sequential publisher), notes mutations arrive concurrently from RPC
  // handlers, and publishing after the lock is released could deliver events
  // out of sequence order — a subscriber folding two updates to the same note
  // would keep the stale one.
  const commit = <A, E>(
    mutate: (current: NotesState) => Effect.Effect<
      {
        readonly result: A;
        readonly event: NoteUpsertedEvent | NoteRemovedEvent;
        readonly notes: ReadonlyArray<Note>;
      },
      E
    >,
  ): Effect.Effect<A, E> =>
    SynchronizedRef.modifyEffect(state, (current) =>
      mutate(current).pipe(
        Effect.tap(({ notes }) => persist(notes)),
        Effect.tap(({ event }) => PubSub.publish(pubsub, event)),
        Effect.map(
          ({ event, notes, result }) =>
            [result, { sequence: event.sequence, notes } as NotesState] as const,
        ),
      ),
    );

  return NotesStore.of({
    create: (input) =>
      commit((current) =>
        Effect.gen(function* () {
          const id = yield* crypto.randomUUIDv4.pipe(Effect.flatMap(decodeNoteId), Effect.orDie);
          const now = yield* DateTime.now;
          const note: Note = { id, text: input.text, createdAt: now, updatedAt: now };
          const event: NoteUpsertedEvent = {
            sequence: current.sequence + 1,
            type: "noteUpserted",
            note,
          };
          return { result: note, event, notes: [...current.notes, note] };
        }),
      ).pipe(Effect.withSpan("notes.create")),

    update: (input) =>
      commit((current) =>
        Effect.gen(function* () {
          const existing = current.notes.find((note) => note.id === input.id);
          if (existing === undefined) {
            return yield* new NoteNotFoundError({ id: input.id });
          }
          const now = yield* DateTime.now;
          const note: Note = { ...existing, text: input.text, updatedAt: now };
          const event: NoteUpsertedEvent = {
            sequence: current.sequence + 1,
            type: "noteUpserted",
            note,
          };
          return {
            result: note,
            event,
            notes: current.notes.map((entry) => (entry.id === note.id ? note : entry)),
          };
        }),
      ).pipe(Effect.withSpan("notes.update")),

    remove: (input) =>
      commit((current) =>
        Effect.gen(function* () {
          if (!current.notes.some((note) => note.id === input.id)) {
            return yield* new NoteNotFoundError({ id: input.id });
          }
          const event: NoteRemovedEvent = {
            sequence: current.sequence + 1,
            type: "noteRemoved",
            id: input.id,
          };
          return {
            result: undefined,
            event,
            notes: current.notes.filter((note) => note.id !== input.id),
          };
        }),
      ).pipe(Effect.withSpan("notes.remove")),

    get changes() {
      return Stream.unwrap(
        Effect.gen(function* () {
          const current = yield* SynchronizedRef.get(state);
          const snapshot: NotesSnapshotEvent = {
            sequence: current.sequence,
            type: "snapshot",
            notes: current.notes,
          };
          const live = Stream.fromPubSub(pubsub).pipe(
            Stream.filter((event) => event.sequence > snapshot.sequence),
          );
          return Stream.concat(Stream.make(snapshot as NotesStreamEvent), live);
        }),
      );
    },
  });
});

export const layer = Layer.effect(NotesStore, make);
