import { useAtomSet, useAtomValue } from "@effect/atom-react";
import * as DateTime from "effect/DateTime";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback, useEffect, useState } from "react";

import type { ConnectionPhase } from "@app/client-runtime/connection";
import type { DesktopTheme } from "@app/contracts";

import { useTheme } from "./hooks/useTheme.ts";
import { localApi } from "./localApi.ts";
import { connectionAtoms } from "./state/connection.ts";

const STATUS_LABEL: Record<ConnectionPhase, string> = {
  idle: "Idle",
  connecting: "Connecting",
  connected: "Connected",
  reconnecting: "Reconnecting",
};

const STATUS_DOT: Record<ConnectionPhase, string> = {
  idle: "bg-muted",
  connecting: "bg-amber-400 animate-pulse",
  connected: "bg-emerald-400",
  reconnecting: "bg-amber-400 animate-pulse",
};

const THEMES: readonly DesktopTheme[] = ["light", "dark", "system"];

export function App() {
  const connectionState = useAtomValue(connectionAtoms.state);
  const config = useAtomValue(connectionAtoms.serverConfig);
  const tick = useAtomValue(connectionAtoms.tick);
  const lifecycle = useAtomValue(connectionAtoms.lifecycle);
  const echoResult = useAtomValue(connectionAtoms.echo);
  const sendEcho = useAtomSet(connectionAtoms.echo);

  const { theme, setTheme } = useTheme();
  const connected = connectionState.phase === "connected";
  const isDesktop = localApi().isDesktop;

  const [menuAction, setMenuAction] = useState<string | null>(null);
  const [echoInput, setEchoInput] = useState("hello");

  // Native menu actions (shell only; inert in a browser). Subscribe once.
  useEffect(() => localApi().onMenuAction(setMenuAction), []);

  const runEcho = useCallback(() => {
    sendEcho({ message: echoInput });
  }, [sendEcho, echoInput]);

  const echoText = AsyncResult.isSuccess(echoResult)
    ? `↩ ${echoResult.value.message}`
    : AsyncResult.isFailure(echoResult)
      ? `error: ${String(echoResult.cause)}`
      : null;

  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <div className="w-full max-w-md rounded-2xl border border-border bg-card p-6 shadow-sm">
        <header className="mb-5 flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold">Electron Effect Starter</h1>
            <p className="text-sm text-muted">
              {connectionState.lastError ? connectionState.lastError : "Effect RPC over WebSocket"}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span
              className={`inline-block h-2.5 w-2.5 rounded-full ${STATUS_DOT[connectionState.phase]}`}
              aria-hidden
            />
            <span className="text-sm text-muted">{STATUS_LABEL[connectionState.phase]}</span>
          </div>
        </header>

        <dl className="space-y-3 text-sm">
          <Row label="App">
            <span className="font-mono">
              {config ? `${config.appName} v${config.version}` : "—"}
            </span>
          </Row>
          <Row label="Started">
            <span className="font-mono">
              {config ? DateTime.toDateUtc(config.startedAt).toLocaleTimeString() : "—"}
            </span>
          </Row>
          <Row label="Lifecycle">
            <span className="font-mono">{lifecycle ?? "—"}</span>
          </Row>
          <Row label="Tick">
            <span className="font-mono tabular-nums">{tick ?? "—"}</span>
          </Row>
          {isDesktop && (
            <Row label="Menu">
              <span className="font-mono">{menuAction ?? "—"}</span>
            </Row>
          )}
        </dl>

        <div className="mt-5 border-t border-border pt-5">
          <label htmlFor="echo-input" className="mb-1.5 block text-xs font-medium text-muted">
            Echo
          </label>
          <div className="flex gap-2">
            <input
              id="echo-input"
              value={echoInput}
              onChange={(e) => setEchoInput(e.target.value)}
              className="flex-1 rounded-lg border border-border bg-transparent px-3 py-1.5 text-sm outline-none focus:border-accent"
              placeholder="Message to echo"
            />
            <button
              onClick={runEcho}
              disabled={!connected || echoResult.waiting}
              className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white transition-opacity disabled:opacity-40"
            >
              Send
            </button>
          </div>
          {echoText !== null && <p className="mt-2 font-mono text-xs text-muted">{echoText}</p>}
        </div>

        <div className="mt-5 flex items-center justify-between border-t border-border pt-5">
          <span className="text-xs font-medium text-muted">Theme</span>
          <div className="flex gap-1 rounded-lg border border-border p-0.5">
            {THEMES.map((option) => (
              <button
                key={option}
                onClick={() => setTheme(option)}
                className={`rounded-md px-2.5 py-1 text-xs capitalize transition-colors ${
                  theme === option ? "bg-accent text-white" : "text-muted hover:text-foreground"
                }`}
              >
                {option}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function Row({ label, children }: { readonly label: string; readonly children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between">
      <dt className="text-muted">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
