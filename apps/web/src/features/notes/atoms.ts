import type { NoteCreateInput, NoteId, NoteUpdateInput } from "@app/contracts";
import { followSession, withClient } from "@app/client-runtime/rpc";
import * as Stream from "effect/Stream";

import { connectionRuntime } from "~/connection/runtime";
import { applyNotesEvent, type NotesState } from "./notesState";

export const notesAtom = connectionRuntime.atom(
  followSession((client) => client["notes.subscribe"]({})).pipe(
    Stream.scan((): NotesState | null => null, applyNotesEvent),
    Stream.filter((state): state is NotesState => state !== null),
  ),
);

export const createNoteAtom = connectionRuntime.fn((input: NoteCreateInput) =>
  withClient((client) => client["notes.create"](input)),
);

export const updateNoteAtom = connectionRuntime.fn((input: NoteUpdateInput) =>
  withClient((client) => client["notes.update"](input)),
);

export const deleteNoteAtom = connectionRuntime.fn((id: NoteId) =>
  withClient((client) => client["notes.delete"]({ id })),
);
