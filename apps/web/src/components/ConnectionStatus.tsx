import {
  connectionStatusText,
  connectionStatusTitle,
  presentConnectionState,
  type SupervisorConnectionState,
} from "@app/client-runtime/connection";
import { RefreshCwIcon } from "lucide-react";

import {
  ConnectionStatusDot,
  connectionPhaseDotClassName,
  connectionPhasePingClassName,
} from "~/components/ConnectionStatusDot";
import { Button } from "~/components/ui/button";

export function ConnectionStatus({
  state,
  onRetry,
}: {
  readonly state: SupervisorConnectionState;
  readonly onRetry: () => void;
}) {
  const connection = presentConnectionState(state);
  const canRetry = state.phase === "backoff" || state.phase === "blocked";

  return (
    <div className="flex items-center gap-2 text-muted-foreground text-xs" role="status">
      <ConnectionStatusDot
        dotClassName={connectionPhaseDotClassName(connection.phase)}
        pingClassName={connectionPhasePingClassName(connection.phase)}
        tooltipText={connection.error === null ? null : connectionStatusText(connection)}
      />
      <span>{connectionStatusTitle(connection)}</span>
      {canRetry ? (
        <Button size="icon-sm" variant="ghost" aria-label="Retry now" onClick={onRetry}>
          <RefreshCwIcon />
        </Button>
      ) : null}
    </div>
  );
}
