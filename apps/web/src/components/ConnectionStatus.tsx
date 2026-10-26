import type { SupervisorConnectionState } from "@app/client-runtime/connection";
import { RefreshCwIcon } from "lucide-react";

import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";

const PHASE_LABELS: Record<SupervisorConnectionState["phase"], string> = {
  available: "Disconnected",
  offline: "Offline",
  connecting: "Connecting",
  backoff: "Reconnecting",
  connected: "Connected",
  blocked: "Sign-in required",
};

export function ConnectionStatus({
  state,
  onRetry,
}: {
  readonly state: SupervisorConnectionState;
  readonly onRetry: () => void;
}) {
  const canRetry = state.phase === "backoff" || state.phase === "blocked";
  return (
    <div className="flex items-center gap-2 text-muted-foreground text-xs" role="status">
      <span
        aria-hidden
        className={cn(
          "size-2 rounded-full",
          state.phase === "connected"
            ? "bg-success"
            : state.phase === "blocked"
              ? "bg-destructive"
              : "bg-warning",
        )}
      />
      <span title={state.lastFailure?.message}>{PHASE_LABELS[state.phase]}</span>
      {canRetry ? (
        <Button size="icon-sm" variant="ghost" aria-label="Retry now" onClick={onRetry}>
          <RefreshCwIcon />
        </Button>
      ) : null}
    </div>
  );
}
