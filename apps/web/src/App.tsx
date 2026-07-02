import type { ConnectionPhase } from "@app/client-runtime/connection";
import type { DesktopTheme, ServerConfig } from "@app/contracts";
import * as DateTime from "effect/DateTime";
import { useCallback, useEffect, useState } from "react";

import { useConnection } from "./hooks/useConnection.ts";
import { useTheme } from "./hooks/useTheme.ts";
import { localApi } from "./localApi.ts";

const STATUS_LABEL: Record<ConnectionPhase, string> = {
  idle: "Idle",
  connecting: "Connecting",
  connected: "Connected",
  reconnecting: "Reconnecting",
};

const STATUS_DOT: Record<ConnectionPhase, string> = {
  idle: "bg-[--color-muted]",
  connecting: "bg-amber-400 animate-pulse",
  connected: "bg-emerald-400",
  reconnecting: "bg-amber-400 animate-pulse",
};

const THEMES: readonly DesktopTheme[] = ["light", "dark", "system"];

export function App() {
  const conn = useConnection();
  const { request, subscribe } = conn;
  const { theme, setTheme } = useTheme();
  const connected = conn.state.phase === "connected";
  const isDesktop = localApi().isDesktop;

  const [config, setConfig] = useState<ServerConfig | null>(null);
  const [tick, setTick] = useState<number | null>(null);
  const [lifecycle, setLifecycle] = useState<string | null>(null);
  const [menuAction, setMenuAction] = useState<string | null>(null);
  const [echoInput, setEchoInput] = useState("hello");
  const [echoResult, setEchoResult] = useState<string | null>(null);
  const [echoing, setEchoing] = useState(false);

  // Initial-sync: fetch the server config once connected.
  useEffect(() => {
    if (!connected) {
      setConfig(null);
      return;
    }
    let alive = true;
    request("server.getConfig", {})
      .then((next) => {
        if (alive) setConfig(next);
      })
      .catch(() => {
        if (alive) setConfig(null);
      });
    return () => {
      alive = false;
    };
  }, [connected, request]);

  // Live streams: subscribe once per mount. The client-runtime subscription
  // watches the session and re-attaches on every reconnect by itself, so we must
  // NOT gate on `connected` — that would tear the stream down and rebuild it on
  // each blip, defeating the transport's built-in re-attach.
  useEffect(() => subscribe("subscribeTicks", {}, (event) => setTick(event.tick)), [subscribe]);
  useEffect(
    () => subscribe("subscribeServerLifecycle", {}, (event) => setLifecycle(event.phase)),
    [subscribe],
  );

  // Native menu actions (shell only; inert in a browser). Subscribe once.
  useEffect(() => localApi().onMenuAction(setMenuAction), []);

  const runEcho = useCallback(() => {
    setEchoing(true);
    request("echo", { message: echoInput })
      .then((result) => setEchoResult(result.message))
      .catch((error: unknown) => setEchoResult(`error: ${String(error)}`))
      .finally(() => setEchoing(false));
  }, [request, echoInput]);

  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <div className="w-full max-w-md rounded-2xl border border-[--color-border] bg-[--color-card] p-6 shadow-sm">
        <header className="mb-5 flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold">Desktop Starter</h1>
            <p className="text-sm text-[--color-muted]">
              {conn.state.lastError ? conn.state.lastError : "Effect RPC over WebSocket"}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span
              className={`inline-block h-2.5 w-2.5 rounded-full ${STATUS_DOT[conn.state.phase]}`}
              aria-hidden
            />
            <span className="text-sm text-[--color-muted]">{STATUS_LABEL[conn.state.phase]}</span>
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

        <div className="mt-5 border-t border-[--color-border] pt-5">
          <label className="mb-1.5 block text-xs font-medium text-[--color-muted]">Echo</label>
          <div className="flex gap-2">
            <input
              value={echoInput}
              onChange={(e) => setEchoInput(e.target.value)}
              className="flex-1 rounded-lg border border-[--color-border] bg-transparent px-3 py-1.5 text-sm outline-none focus:border-[--color-accent]"
              placeholder="Message to echo"
            />
            <button
              onClick={runEcho}
              disabled={!connected || echoing}
              className="rounded-lg bg-[--color-accent] px-3 py-1.5 text-sm font-medium text-white transition-opacity disabled:opacity-40"
            >
              Send
            </button>
          </div>
          {echoResult !== null && (
            <p className="mt-2 font-mono text-xs text-[--color-muted]">↩ {echoResult}</p>
          )}
        </div>

        <div className="mt-5 flex items-center justify-between border-t border-[--color-border] pt-5">
          <span className="text-xs font-medium text-[--color-muted]">Theme</span>
          <div className="flex gap-1 rounded-lg border border-[--color-border] p-0.5">
            {THEMES.map((option) => (
              <button
                key={option}
                onClick={() => setTheme(option)}
                className={`rounded-md px-2.5 py-1 text-xs capitalize transition-colors ${
                  theme === option
                    ? "bg-[--color-accent] text-white"
                    : "text-[--color-muted] hover:text-[--color-foreground]"
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
      <dt className="text-[--color-muted]">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
