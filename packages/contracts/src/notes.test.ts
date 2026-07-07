import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

import { Note, NoteCreateInput, NoteId, NoteNotFoundError, NotesStreamEvent } from "./notes.ts";

// The RPC layer wraps schemas in `Schema.toCodecJson`, so the JSON forms
// below (ISO date strings) are the wire contract these tests pin.
const decodeNote = Schema.decodeUnknownSync(Schema.toCodecJson(Note));
const encodeNote = Schema.encodeSync(Schema.toCodecJson(Note));
const decodeStreamEvent = Schema.decodeUnknownSync(Schema.toCodecJson(NotesStreamEvent));
const decodeCreateInput = Schema.decodeUnknownSync(NoteCreateInput);

const WIRE_NOTE = {
  id: "note-1",
  text: "hello",
  createdAt: "2026-07-07T00:00:00.000Z",
  updatedAt: "2026-07-07T00:00:00.000Z",
};

describe("Note wire codec", () => {
  it("decodes the JSON wire shape into DateTimes and encodes back to ISO strings", () => {
    const decoded = decodeNote(WIRE_NOTE);
    assert.isTrue(DateTime.isDateTime(decoded.createdAt));
    assert.deepStrictEqual(encodeNote(decoded), WIRE_NOTE);
  });

  it("rejects blank ids and blank text", () => {
    assert.throws(() => decodeNote({ ...WIRE_NOTE, id: "   " }));
    assert.throws(() => decodeNote({ ...WIRE_NOTE, text: "" }));
  });
});

describe("NoteCreateInput", () => {
  it("trims surrounding whitespace and rejects whitespace-only text", () => {
    assert.strictEqual(decodeCreateInput({ text: "  hi  " }).text, "hi");
    assert.throws(() => decodeCreateInput({ text: "   " }));
  });
});

describe("NotesStreamEvent", () => {
  it("discriminates the three event types by tag", () => {
    const snapshot = decodeStreamEvent({ sequence: 2, type: "snapshot", notes: [WIRE_NOTE] });
    assert.strictEqual(snapshot.type, "snapshot");

    const upserted = decodeStreamEvent({ sequence: 3, type: "noteUpserted", note: WIRE_NOTE });
    assert.strictEqual(upserted.type, "noteUpserted");

    const removed = decodeStreamEvent({ sequence: 4, type: "noteRemoved", id: "note-1" });
    assert.strictEqual(removed.type, "noteRemoved");
  });

  it("rejects an unknown event type", () => {
    assert.throws(() => decodeStreamEvent({ sequence: 1, type: "notesCleared" }));
  });
});

describe("NoteNotFoundError", () => {
  it("carries the id in its tag and message", () => {
    const error = new NoteNotFoundError({ id: Schema.decodeUnknownSync(NoteId)("missing") });
    assert.strictEqual(error._tag, "NoteNotFoundError");
    assert.include(error.message, "missing");
  });
});
