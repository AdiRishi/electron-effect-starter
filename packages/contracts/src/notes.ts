import * as Schema from "effect/Schema";

import { NonNegativeInt, NoteId, TrimmedNonEmptyString, TrimmedString } from "./baseSchemas.ts";

export const NOTE_TITLE_MAX_LENGTH = 200;
export const NOTE_BODY_MAX_LENGTH = 20_000;

const NoteTitle = TrimmedNonEmptyString.check(Schema.isMaxLength(NOTE_TITLE_MAX_LENGTH));
const NoteBody = TrimmedString.check(Schema.isMaxLength(NOTE_BODY_MAX_LENGTH));

export const Note = Schema.Struct({
  id: NoteId,
  title: NoteTitle,
  body: NoteBody,
  createdAt: Schema.DateTimeUtc,
  updatedAt: Schema.DateTimeUtc,
});

export type Note = typeof Note.Type;

export const NoteCreateInput = Schema.Struct({
  title: NoteTitle,
  body: NoteBody,
});

export type NoteCreateInput = typeof NoteCreateInput.Type;

export const NoteUpdateInput = Schema.Struct({
  id: NoteId,
  title: NoteTitle,
  body: NoteBody,
});

export type NoteUpdateInput = typeof NoteUpdateInput.Type;

export const NoteDeleteInput = Schema.Struct({
  id: NoteId,
});

export type NoteDeleteInput = typeof NoteDeleteInput.Type;

export class NoteNotFoundError extends Schema.TaggedError<NoteNotFoundError>()(
  "NoteNotFoundError",
  { id: NoteId },
) {
  override get message(): string {
    return `Note ${this.id} does not exist.`;
  }
}

export class NotesStorageError extends Schema.TaggedError<NotesStorageError>()(
  "NotesStorageError",
  { operation: Schema.Literals(["list", "create", "update", "delete"]) },
) {
  override get message(): string {
    return `Notes storage failed to ${this.operation}.`;
  }
}

export const NotesStreamSnapshotEvent = Schema.Struct({
  type: Schema.Literal("snapshot"),
  revision: NonNegativeInt,
  notes: Schema.Array(Note),
});

export const NotesStreamUpsertedEvent = Schema.Struct({
  type: Schema.Literal("upserted"),
  revision: NonNegativeInt,
  note: Note,
});

export const NotesStreamRemovedEvent = Schema.Struct({
  type: Schema.Literal("removed"),
  revision: NonNegativeInt,
  id: NoteId,
});

export const NotesStreamEvent = Schema.Union([
  NotesStreamSnapshotEvent,
  NotesStreamUpsertedEvent,
  NotesStreamRemovedEvent,
]);

export type NotesStreamEvent = typeof NotesStreamEvent.Type;
