import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";
import * as Socket from "effect/unstable/socket/Socket";
import { describe, expect, it, vi } from "vitest";

import {
  ConnectionTransientError,
  connectionSupervisorLayer,
  type PreparedConnection,
} from "@app/client-runtime/connection";
import {
  RpcSessionFactory,
  type RpcSession,
  type WsRpcProtocolClient,
} from "@app/client-runtime/rpc";
import { NoteId, type Note, type NotesStreamEvent } from "@app/contracts";

import { applyNotesEvent, createNotesAtoms, INITIAL_NOTES_VIEW } from "./atoms.ts";

const decodeNoteId = Schema.decodeUnknownSync(NoteId);

const note = (id: string, text: string, epochMillis: number): Note => ({
  id: decodeNoteId(id),
  text,
  createdAt: DateTime.fromDateUnsafe(new Date(epochMillis)),
  updatedAt: DateTime.fromDateUnsafe(new Date(epochMillis)),
});

const NOTE_A = note("a", "first", 1_000);
const NOTE_B = note("b", "second", 2_000);

describe("applyNotesEvent", () => {
  it("replaces state on snapshot and marks snapshot notes revision 0", () => {
    const view = applyNotesEvent(INITIAL_NOTES_VIEW, {
      sequence: 5,
      type: "snapshot",
      notes: [NOTE_A, NOTE_B],
    });
    expect(view.ready).toBe(true);
    expect(view.sequence).toBe(5);
    expect(view.entries.get(NOTE_A.id)).toEqual({ note: NOTE_A, revision: 0 });
  });

  it("upserts with the event sequence as the revision, and removes by id", () => {
    let view = applyNotesEvent(INITIAL_NOTES_VIEW, { sequence: 1, type: "snapshot", notes: [] });
    view = applyNotesEvent(view, { sequence: 2, type: "noteUpserted", note: NOTE_A });
    expect(view.entries.get(NOTE_A.id)).toEqual({ note: NOTE_A, revision: 2 });

    view = applyNotesEvent(view, { sequence: 3, type: "noteRemoved", id: NOTE_A.id });
    expect(view.entries.size).toBe(0);
    expect(view.sequence).toBe(3);
  });

  it("a reconnect snapshot resets revisions so nothing re-flashes", () => {
    let view = applyNotesEvent(INITIAL_NOTES_VIEW, { sequence: 1, type: "snapshot", notes: [] });
    view = applyNotesEvent(view, { sequence: 2, type: "noteUpserted", note: NOTE_A });
    view = applyNotesEvent(view, { sequence: 2, type: "snapshot", notes: [NOTE_A] });
    expect(view.entries.get(NOTE_A.id)?.revision).toBe(0);
  });
});

const CONNECTION: PreparedConnection = {
  label: "test",
  prepareSocketUrl: Effect.succeed("ws://127.0.0.1:0/ws"),
};

/** Scripted supervisor harness — same shape as state/connection.test.ts. */
const makeScriptedHarness = (events: ReadonlyArray<NotesStreamEvent>) => {
  const created: Array<string> = [];

  const fakeClient = {
    "notes.subscribe": () => Stream.fromIterable(events).pipe(Stream.concat(Stream.never)),
    "notes.create": (input: { readonly text: string }) =>
      Effect.sync(() => {
        created.push(input.text);
        return note("created", input.text, 3_000);
      }),
  } as unknown as WsRpcProtocolClient;

  const factory = {
    connect: () =>
      Effect.gen(function* () {
        const closed = yield* Deferred.make<never, ConnectionTransientError>();
        return {
          client: fakeClient,
          connected: Effect.void,
          closed: Deferred.await(closed),
        } satisfies RpcSession;
      }),
  };

  const layer = connectionSupervisorLayer(CONNECTION).pipe(
    Layer.provide(Socket.layerWebSocketConstructorGlobal),
    Layer.provide(Layer.succeed(RpcSessionFactory, factory)),
  );

  return { layer, created };
};

describe("notes atoms", () => {
  it("folds the subscription into a newest-first list", async () => {
    const harness = makeScriptedHarness([
      { sequence: 1, type: "snapshot", notes: [NOTE_A] },
      { sequence: 2, type: "noteUpserted", note: NOTE_B },
    ]);
    const atoms = createNotesAtoms(Atom.runtime(harness.layer));
    const registry = AtomRegistry.make();

    const unmounts = [registry.mount(atoms.view), registry.mount(atoms.notes)];

    await vi.waitFor(() => {
      expect(registry.get(atoms.view).sequence).toBe(2);
      expect(registry.get(atoms.notes).map((entry) => entry.note.text)).toEqual([
        "second",
        "first",
      ]);
      // Snapshot note must not flash; the live upsert must.
      expect(registry.get(atoms.notes).map((entry) => entry.revision)).toEqual([2, 0]);
    });

    for (const unmount of unmounts) unmount();
  });

  it("sends create calls through the live session", async () => {
    const harness = makeScriptedHarness([{ sequence: 1, type: "snapshot", notes: [] }]);
    const atoms = createNotesAtoms(Atom.runtime(harness.layer));
    const registry = AtomRegistry.make();

    const unmounts = [registry.mount(atoms.view), registry.mount(atoms.createNote)];

    await vi.waitFor(() => {
      expect(registry.get(atoms.view).ready).toBe(true);
    });

    registry.set(atoms.createNote, "hello bus");

    await vi.waitFor(() => {
      const result = registry.get(atoms.createNote);
      expect(AsyncResult.isSuccess(result) && result.value.text).toBe("hello bus");
      expect(harness.created).toEqual(["hello bus"]);
    });

    for (const unmount of unmounts) unmount();
  });
});
