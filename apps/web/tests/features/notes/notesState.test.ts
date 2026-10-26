import { type Note, NoteId } from "@app/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vitest";

import { applyNotesEvent } from "~/features/notes/notesState";

const note = (id: string, updatedAtMillis: number, title = id): Note => ({
  id: NoteId.make(id),
  title,
  body: "",
  createdAt: DateTime.makeUnsafe(0),
  updatedAt: DateTime.makeUnsafe(updatedAtMillis),
});

describe("applyNotesEvent", () => {
  it("replaces all notes with a snapshot, most recently updated first", () => {
    const state = applyNotesEvent(
      { revision: 9, notes: [note("stale", 1)] },
      { type: "snapshot", revision: 2, notes: [note("older", 10), note("newer", 20)] },
    );

    expect(state.revision).toBe(2);
    expect(state.notes.map((entry) => entry.id)).toEqual(["newer", "older"]);
  });

  it("moves an updated note to the top instead of duplicating it", () => {
    const initial = applyNotesEvent(null, {
      type: "snapshot",
      revision: 1,
      notes: [note("a", 10), note("b", 20)],
    });

    const state = applyNotesEvent(initial, {
      type: "upserted",
      revision: 2,
      note: note("a", 30, "edited"),
    });

    expect(state.notes.map((entry) => [entry.id, entry.title])).toEqual([
      ["a", "edited"],
      ["b", "b"],
    ]);
  });

  it("drops a removed note", () => {
    const initial = applyNotesEvent(null, {
      type: "snapshot",
      revision: 1,
      notes: [note("a", 10), note("b", 20)],
    });

    const state = applyNotesEvent(initial, { type: "removed", revision: 2, id: NoteId.make("b") });
    expect(state.notes.map((entry) => entry.id)).toEqual(["a"]);
  });
});
