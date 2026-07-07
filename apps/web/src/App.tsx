import { useAtomValue } from "@effect/atom-react";
import { useEffect, useState } from "react";

import type { ConnectionPhase } from "@app/client-runtime/connection";
import type { DesktopTheme } from "@app/contracts";

import { notesAtoms } from "./features/notes/atoms.ts";
import { NotesPanel } from "./features/notes/NotesPanel.tsx";
import { useTheme } from "./hooks/useTheme.ts";
import { localApi } from "./localApi.ts";
import { connectionAtoms } from "./state/connection.ts";

const STATUS_LABEL: Record<ConnectionPhase, string> = {
  idle: "idle",
  connecting: "connecting",
  connected: "connected",
  reconnecting: "reconnecting",
};

// Connected wears the accent: the brand color IS the color of a live bus.
const STATUS_DOT: Record<ConnectionPhase, string> = {
  idle: "bg-muted",
  connecting: "bg-amber-400 animate-pulse",
  connected: "bg-accent",
  reconnecting: "bg-amber-400 animate-pulse",
};

const THEMES: readonly DesktopTheme[] = ["light", "dark", "system"];

export function App() {
  const connectionState = useAtomValue(connectionAtoms.state);
  const config = useAtomValue(connectionAtoms.serverConfig);
  const lifecycle = useAtomValue(connectionAtoms.lifecycle);
  const notesView = useAtomValue(notesAtoms.view);

  const { theme, setTheme } = useTheme();
  const connected = connectionState.phase === "connected";
  const isDesktop = localApi().isDesktop;

  const [menuAction, setMenuAction] = useState<string | null>(null);

  // Native menu actions (shell only; inert in a browser). Subscribe once.
  useEffect(() => localApi().onMenuAction(setMenuAction), []);

  return (
    <div className="flex min-h-full flex-col">
      <main className="mx-auto w-full max-w-xl flex-1 px-6 pt-12 pb-16">
        <header className="mb-8 flex items-start justify-between gap-4">
          <div>
            <h1 className="font-mono text-sm font-semibold tracking-tight">
              {config?.appName ?? "Electron Effect Starter"}
            </h1>
            <p className="mt-1 text-[13px] text-muted">
              Notes that sync live between every window on your local server.
            </p>
          </div>
          <div className="flex shrink-0 gap-1 rounded-lg border border-border p-0.5">
            {THEMES.map((option) => (
              <button
                key={option}
                onClick={() => setTheme(option)}
                className={`rounded-md px-2 py-1 font-mono text-[11px] capitalize transition-colors outline-none focus-visible:ring-1 focus-visible:ring-accent ${
                  theme === option
                    ? "bg-accent text-accent-contrast"
                    : "text-muted hover:text-foreground"
                }`}
              >
                {option}
              </button>
            ))}
          </div>
        </header>

        <NotesPanel connected={connected} />
      </main>

      {/* The bus meter: connection, server identity, lifecycle phase, and the
          last event sequence — the transport machinery, speaking monospace. */}
      <footer className="border-t border-border">
        <div className="mx-auto flex w-full max-w-xl flex-wrap items-center gap-x-2 gap-y-1 px-6 py-2.5 font-mono text-[11px] text-muted">
          <span className="flex items-center gap-1.5">
            <span
              className={`inline-block h-2 w-2 rounded-full ${STATUS_DOT[connectionState.phase]}`}
              aria-hidden
            />
            {STATUS_LABEL[connectionState.phase]}
            {connectionState.attempt > 0 && ` (attempt ${connectionState.attempt})`}
          </span>
          {config && <Meter label={`${config.appName} v${config.version}`} />}
          {lifecycle && <Meter label={lifecycle} />}
          <Meter label={`seq ${notesView.sequence}`} />
          {isDesktop && menuAction && <Meter label={`menu ${menuAction}`} />}
          {connectionState.lastError && connectionState.phase !== "connected" && (
            <Meter label={connectionState.lastError} />
          )}
        </div>
      </footer>
    </div>
  );
}

function Meter({ label }: { readonly label: string }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span aria-hidden className="text-border">
        ·
      </span>
      <span className="truncate">{label}</span>
    </span>
  );
}
