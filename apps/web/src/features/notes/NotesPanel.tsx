import { useAtomSet, useAtomValue } from "@effect/atom-react";
import * as DateTime from "effect/DateTime";
import { AsyncResult } from "effect/unstable/reactivity";
import { useState } from "react";

import { notesAtoms, type NoteView } from "./atoms.ts";

/**
 * The sample app: a synced notes list. Content is set in the sans face; the
 * machinery (timestamps, actions) speaks monospace. Rows carry `.note-flash`
 * keyed by revision, so a change briefly tints when it round-trips through
 * the server — sync made visible when two windows are open.
 */
export function NotesPanel({ connected }: { readonly connected: boolean }) {
  const view = useAtomValue(notesAtoms.view);
  const notes = useAtomValue(notesAtoms.notes);
  const createResult = useAtomValue(notesAtoms.createNote);
  const createNote = useAtomSet(notesAtoms.createNote);

  const [draft, setDraft] = useState("");

  const submitDraft = () => {
    const text = draft.trim();
    if (text.length === 0) return;
    createNote(text);
    setDraft("");
  };

  return (
    <section aria-label="Notes">
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          submitDraft();
        }}
      >
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={connected ? "Write a note…" : "Waiting for the server…"}
          aria-label="New note"
          disabled={!connected}
          className="flex-1 rounded-lg border border-border bg-card px-3 py-2 text-sm outline-none placeholder:text-muted focus-visible:border-accent disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={!connected || draft.trim().length === 0 || createResult.waiting}
          className="rounded-lg bg-accent px-3.5 py-2 text-sm font-medium text-accent-contrast transition-opacity disabled:opacity-40"
        >
          Add note
        </button>
      </form>
      {AsyncResult.isFailure(createResult) && (
        <p className="mt-2 font-mono text-xs text-red-500">
          The note was not saved: {String(createResult.cause)}
        </p>
      )}

      <div className="mt-6">
        {notes.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted">
            {view.ready
              ? "Nothing here yet. Write a note, then open this same app in a browser tab — it syncs live through your local server."
              : "Syncing with the local server…"}
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {notes.map((entry) => (
              <NoteRow key={`${entry.note.id}:${entry.revision}`} entry={entry} />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function NoteRow({ entry }: { readonly entry: NoteView }) {
  const updateNote = useAtomSet(notesAtoms.updateNote);
  const deleteNote = useAtomSet(notesAtoms.deleteNote);
  const [editing, setEditing] = useState(false);

  const { note, revision } = entry;
  const time = DateTime.toDateUtc(note.updatedAt).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
  const edited = DateTime.toEpochMillis(note.updatedAt) !== DateTime.toEpochMillis(note.createdAt);

  const saveEdit = (text: string) => {
    const trimmed = text.trim();
    setEditing(false);
    if (trimmed.length === 0 || trimmed === note.text) return;
    updateNote({ id: note.id, text: trimmed });
  };

  return (
    <li className={`group -mx-2 rounded-md px-2 ${revision > 0 ? "note-flash" : ""}`}>
      {editing ? (
        <NoteEditor initialText={note.text} onSave={saveEdit} onCancel={() => setEditing(false)} />
      ) : (
        <div className="flex items-baseline gap-3 py-3">
          <p className="min-w-0 flex-1 text-sm break-words whitespace-pre-wrap">{note.text}</p>
          <span className="shrink-0 font-mono text-[11px] text-muted">
            {edited ? `edited ${time}` : time}
          </span>
          <span className="flex shrink-0 gap-2 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
            <RowAction label="Edit" onClick={() => setEditing(true)} />
            <RowAction label="Delete" destructive onClick={() => deleteNote(note.id)} />
          </span>
        </div>
      )}
    </li>
  );
}

function NoteEditor({
  initialText,
  onSave,
  onCancel,
}: {
  readonly initialText: string;
  readonly onSave: (text: string) => void;
  readonly onCancel: () => void;
}) {
  const [text, setText] = useState(initialText);
  return (
    <div className="flex items-center gap-2 py-2">
      <input
        autoFocus
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") onSave(text);
          if (event.key === "Escape") onCancel();
        }}
        aria-label="Edit note"
        className="flex-1 rounded-md border border-accent bg-card px-2 py-1.5 text-sm outline-none"
      />
      <RowAction label="Save" onClick={() => onSave(text)} />
      <RowAction label="Cancel" onClick={onCancel} />
    </div>
  );
}

function RowAction({
  label,
  onClick,
  destructive = false,
}: {
  readonly label: string;
  readonly onClick: () => void;
  readonly destructive?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded font-mono text-[11px] outline-none focus-visible:ring-1 focus-visible:ring-accent ${
        destructive ? "text-red-500 hover:text-red-400" : "text-muted hover:text-foreground"
      }`}
    >
      {label}
    </button>
  );
}
