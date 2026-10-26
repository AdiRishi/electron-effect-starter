import { createFileRoute } from "@tanstack/react-router";

import { NotesPanel } from "~/features/notes/NotesPanel";

export const Route = createFileRoute("/")({ component: NotesPanel });
