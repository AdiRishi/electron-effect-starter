import type { Note } from "@app/contracts";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import * as Exit from "effect/Exit";
import { AsyncResult, type Atom } from "effect/reactivity";
import { PencilIcon, Trash2Icon } from "lucide-react";
import { useState, type FormEvent } from "react";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";
import { createNoteAtom, deleteNoteAtom, notesAtom, updateNoteAtom } from "./atoms";

function NoteEditor({
  initial,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  readonly initial: { readonly title: string; readonly body: string };
  readonly submitLabel: string;
  readonly onSubmit: (value: { readonly title: string; readonly body: string }) => Promise<boolean>;
  readonly onCancel?: () => void;
}) {
  const [title, setTitle] = useState(initial.title);
  const [body, setBody] = useState(initial.body);
  const [pending, setPending] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setPending(true);
    const saved = await onSubmit({ title, body });
    setPending(false);
    if (saved && onCancel === undefined) {
      setTitle("");
      setBody("");
    }
  };

  return (
    <form className="space-y-2" onSubmit={submit}>
      <Input
        aria-label="Title"
        placeholder="Title"
        value={title}
        onChange={(event) => setTitle(event.target.value)}
      />
      <Textarea
        aria-label="Body"
        placeholder="Write something…"
        value={body}
        onChange={(event) => setBody(event.target.value)}
      />
      <div className="flex justify-end gap-2">
        {onCancel ? (
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
        <Button type="submit" disabled={pending || title.trim().length === 0}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}

function NoteCard({ note }: { readonly note: Note }) {
  const [editing, setEditing] = useState(false);
  const updateNote = useAtomSet(updateNoteAtom, { mode: "promiseExit" });
  const deleteNote = useAtomSet(deleteNoteAtom, { mode: "promiseExit" });

  if (editing) {
    return (
      <li className="rounded-lg border p-3">
        <NoteEditor
          initial={note}
          submitLabel="Save"
          onCancel={() => setEditing(false)}
          onSubmit={async (value) => {
            const exit = await updateNote({ id: note.id, ...value });
            const saved = Exit.isSuccess(exit);
            if (saved) setEditing(false);
            return saved;
          }}
        />
      </li>
    );
  }

  return (
    <li className="group flex items-start gap-3 rounded-lg border p-3">
      <div className="min-w-0 flex-1">
        <h3 className="truncate font-medium text-sm">{note.title}</h3>
        {note.body.length > 0 ? (
          <p className="mt-1 whitespace-pre-wrap text-muted-foreground text-sm">{note.body}</p>
        ) : null}
      </div>
      <div className="flex gap-1">
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Edit note"
          onClick={() => setEditing(true)}
        >
          <PencilIcon />
        </Button>
        <Button
          size="icon-sm"
          variant="destructive"
          aria-label="Delete note"
          onClick={() => void deleteNote(note.id)}
        >
          <Trash2Icon />
        </Button>
      </div>
    </li>
  );
}

function NotesList({ notes }: { readonly notes: Atom.Type<typeof notesAtom> }) {
  if (AsyncResult.isFailure(notes)) {
    return <p className="text-destructive text-sm">Notes could not be loaded.</p>;
  }
  if (!AsyncResult.isSuccess(notes)) {
    return <p className="text-muted-foreground text-sm">Loading notes…</p>;
  }
  if (notes.value.notes.length === 0) {
    return <p className="text-muted-foreground text-sm">No notes yet.</p>;
  }
  return (
    <ul className="space-y-2">
      {notes.value.notes.map((note) => (
        <NoteCard key={note.id} note={note} />
      ))}
    </ul>
  );
}

export function NotesPanel() {
  const notes = useAtomValue(notesAtom);
  const createNote = useAtomSet(createNoteAtom, { mode: "promiseExit" });

  return (
    <section className="mx-auto w-full max-w-xl space-y-6 p-6">
      <NoteEditor
        initial={{ title: "", body: "" }}
        submitLabel="Add note"
        onSubmit={async (value) => Exit.isSuccess(await createNote(value))}
      />
      <NotesList notes={notes} />
    </section>
  );
}
