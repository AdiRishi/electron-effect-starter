import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import type { ConnectionSupervisor } from "@app/client-runtime/connection";
import { request as rpcRequest, subscribe as rpcSubscribe } from "@app/client-runtime/rpc";
import type { Note, NoteId, NotesStreamEvent } from "@app/contracts";

import { connectionRuntime } from "../../state/connection.ts";

/**
 * A note plus the sequence of the live event that last touched it. `revision`
 * is 0 for notes that arrived via snapshot (initial load or reconnect resync),
 * so the UI can flash only changes that round-tripped through the server —
 * not every row on every mount.
 */
export interface NoteView {
  readonly note: Note;
  readonly revision: number;
}

export interface NotesView {
  /** False until the first snapshot event lands. */
  readonly ready: boolean;
  /** Sequence of the last applied event (the footer's bus meter). */
  readonly sequence: number;
  readonly entries: ReadonlyMap<NoteId, NoteView>;
}

export const INITIAL_NOTES_VIEW: NotesView = {
  ready: false,
  sequence: 0,
  entries: new Map(),
};

/** Fold one push-bus event into the current view (pure, pinned by tests). */
export function applyNotesEvent(view: NotesView, event: NotesStreamEvent): NotesView {
  switch (event.type) {
    case "snapshot":
      return {
        ready: true,
        sequence: event.sequence,
        entries: new Map(event.notes.map((note) => [note.id, { note, revision: 0 }])),
      };
    case "noteUpserted": {
      const entries = new Map(view.entries);
      entries.set(event.note.id, { note: event.note, revision: event.sequence });
      return { ...view, sequence: event.sequence, entries };
    }
    case "noteRemoved": {
      const entries = new Map(view.entries);
      entries.delete(event.id);
      return { ...view, sequence: event.sequence, entries };
    }
  }
}

/**
 * Build the notes atoms against an `AtomRuntime` that provides the supervisor.
 * A factory (rather than module-level atoms) so tests can instantiate the same
 * atoms over a scripted runtime — the same pattern as `state/connection.ts`.
 */
export function createNotesAtoms<R, E>(runtime: Atom.AtomRuntime<ConnectionSupervisor | R, E>) {
  // The subscription re-attaches across reconnects by itself; every fresh
  // session emits a new snapshot event, which resets the fold.
  const viewResultAtom = runtime.atom(
    rpcSubscribe("notes.subscribe", {}).pipe(Stream.scan(INITIAL_NOTES_VIEW, applyNotesEvent)),
  );

  const viewAtom = Atom.make(
    (get): NotesView =>
      Option.getOrElse(AsyncResult.value(get(viewResultAtom)), () => INITIAL_NOTES_VIEW),
  ).pipe(Atom.withLabel("notes-view"));

  /** Newest first, so a note added in another window appears at the top. */
  const notesAtom = Atom.make(
    (get): ReadonlyArray<NoteView> =>
      [...get(viewAtom).entries.values()].toSorted(
        (left, right) =>
          DateTime.toEpochMillis(right.note.createdAt) -
          DateTime.toEpochMillis(left.note.createdAt),
      ),
  ).pipe(Atom.withLabel("notes"));

  const createNoteAtom = runtime.fn((text: string) => rpcRequest("notes.create", { text }));
  const updateNoteAtom = runtime.fn((input: { readonly id: NoteId; readonly text: string }) =>
    rpcRequest("notes.update", input),
  );
  const deleteNoteAtom = runtime.fn((id: NoteId) => rpcRequest("notes.delete", { id }));

  return {
    view: viewAtom,
    notes: notesAtom,
    createNote: createNoteAtom,
    updateNote: updateNoteAtom,
    deleteNote: deleteNoteAtom,
  } as const;
}

export const notesAtoms = createNotesAtoms(connectionRuntime);
