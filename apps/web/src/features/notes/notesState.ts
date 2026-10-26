import type { Note, NotesStreamEvent } from "@app/contracts";

export interface NotesState {
  readonly revision: number;
  readonly notes: ReadonlyArray<Note>;
}

const byMostRecentlyUpdated = (left: Note, right: Note) =>
  right.updatedAt.epochMilliseconds - left.updatedAt.epochMilliseconds;

/** Folds the notes subscription: a snapshot replaces everything, later events patch it. */
export function applyNotesEvent(state: NotesState | null, event: NotesStreamEvent): NotesState {
  switch (event.type) {
    case "snapshot":
      return { revision: event.revision, notes: [...event.notes].toSorted(byMostRecentlyUpdated) };
    case "upserted":
      return {
        revision: event.revision,
        notes: [
          event.note,
          ...(state?.notes ?? []).filter((note) => note.id !== event.note.id),
        ].toSorted(byMostRecentlyUpdated),
      };
    case "removed":
      return {
        revision: event.revision,
        notes: (state?.notes ?? []).filter((note) => note.id !== event.id),
      };
  }
}
