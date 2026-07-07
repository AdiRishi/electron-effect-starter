import * as Schema from "effect/Schema";

import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * The sample domain: synced notes. This file (plus the `notes.*` entries in
 * `rpc.ts`, `apps/server/src/notes/`, and `apps/web/src/features/notes/`) is
 * the showcase app — delete those four places and the starter is domain-free.
 */

export const NoteId = TrimmedNonEmptyString.pipe(Schema.brand("NoteId"));
export type NoteId = typeof NoteId.Type;

export const Note = Schema.Struct({
  id: NoteId,
  text: TrimmedNonEmptyString,
  createdAt: Schema.DateTimeUtc,
  updatedAt: Schema.DateTimeUtc,
});
export type Note = typeof Note.Type;

export class NoteNotFoundError extends Schema.TaggedErrorClass<NoteNotFoundError>()(
  "NoteNotFoundError",
  {
    id: NoteId,
  },
) {
  override get message(): string {
    return `No note exists with id ${this.id}.`;
  }
}

export const NoteCreateInput = Schema.Struct({
  text: TrimmedNonEmptyString,
});
export type NoteCreateInput = typeof NoteCreateInput.Type;

export const NoteUpdateInput = Schema.Struct({
  id: NoteId,
  text: TrimmedNonEmptyString,
});
export type NoteUpdateInput = typeof NoteUpdateInput.Type;

export const NoteDeleteInput = Schema.Struct({
  id: NoteId,
});
export type NoteDeleteInput = typeof NoteDeleteInput.Type;

/**
 * `notes.subscribe` events — the same ordered push-bus contract as the server
 * lifecycle stream: one `snapshot` event first, then live events filtered to
 * `sequence > snapshot.sequence`, so a subscriber (or a reconnecting one)
 * folds them into current state without gaps or duplicates.
 */
export const NotesSnapshotEvent = Schema.Struct({
  sequence: NonNegativeInt,
  type: Schema.Literal("snapshot"),
  notes: Schema.Array(Note),
});
export type NotesSnapshotEvent = typeof NotesSnapshotEvent.Type;

export const NoteUpsertedEvent = Schema.Struct({
  sequence: NonNegativeInt,
  type: Schema.Literal("noteUpserted"),
  note: Note,
});
export type NoteUpsertedEvent = typeof NoteUpsertedEvent.Type;

export const NoteRemovedEvent = Schema.Struct({
  sequence: NonNegativeInt,
  type: Schema.Literal("noteRemoved"),
  id: NoteId,
});
export type NoteRemovedEvent = typeof NoteRemovedEvent.Type;

export const NotesStreamEvent = Schema.Union([
  NotesSnapshotEvent,
  NoteUpsertedEvent,
  NoteRemovedEvent,
]);
export type NotesStreamEvent = typeof NotesStreamEvent.Type;
