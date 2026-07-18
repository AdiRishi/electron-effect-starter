import { Component, type ErrorInfo, type ReactNode } from "react";

import { App } from "./App.tsx";

/**
 * Owns renderer-wide composition. A starter has no router or global providers,
 * so this renders the single demo page inside the app-wide error boundary —
 * and it's the natural seam to add more providers (a router, contexts) as the
 * app grows.
 */
export function AppRoot() {
  return (
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  );
}

interface AppErrorBoundaryState {
  readonly error: Error | null;
}

/**
 * Last-resort recovery UI. Without it, any exception thrown during render
 * unmounts the whole tree to a blank page — in the desktop shell that is a
 * dead window with no way back short of restarting the app. "Try again"
 * re-renders in place (enough when the throw was transient, e.g. one bad
 * event); "Reload" restarts the renderer from scratch.
 */
class AppErrorBoundary extends Component<{ readonly children: ReactNode }, AppErrorBoundaryState> {
  override state: AppErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): AppErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    // The renderer has no logger service; the console is what the desktop
    // shell captures and what devtools shows in the browser.
    console.error("renderer crashed", error, info.componentStack);
  }

  override render() {
    if (this.state.error === null) {
      return this.props.children;
    }
    return (
      <div className="flex min-h-full flex-col items-center justify-center gap-4 px-6 text-center">
        <h1 className="font-mono text-sm font-semibold tracking-tight">Something went wrong</h1>
        <p className="max-w-md text-[13px] text-muted">
          The app hit an unexpected error while rendering. You can try to continue, or reload from
          scratch.
        </p>
        <div className="flex gap-2">
          <button
            type="button"
            className="rounded-lg border border-border px-3 py-1.5 text-[13px] hover:bg-muted/10"
            onClick={() => this.setState({ error: null })}
          >
            Try again
          </button>
          <button
            type="button"
            className="rounded-lg border border-border px-3 py-1.5 text-[13px] hover:bg-muted/10"
            onClick={() => window.location.reload()}
          >
            Reload
          </button>
        </div>
        <details className="max-w-md text-left">
          <summary className="cursor-pointer text-[12px] text-muted">Error details</summary>
          <pre className="mt-2 overflow-x-auto rounded-lg border border-border p-3 text-[11px] whitespace-pre-wrap">
            {this.state.error.stack ?? this.state.error.message}
          </pre>
        </details>
      </div>
    );
  }
}
