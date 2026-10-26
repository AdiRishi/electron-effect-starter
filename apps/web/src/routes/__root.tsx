import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { createRootRoute, Outlet } from "@tanstack/react-router";
import { AsyncResult } from "effect/reactivity";

import { ConnectionStatus } from "~/components/ConnectionStatus";
import { RootRouteErrorView, RootRouteNotFoundView } from "~/components/RootRouteViews";
import { connectionStateAtom, retryConnectionAtom } from "~/connection/atoms";
import { useTheme } from "~/hooks/useTheme";

function RootLayout() {
  const connection = useAtomValue(connectionStateAtom);
  const retry = useAtomSet(retryConnectionAtom);
  useTheme();

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-12 shrink-0 items-center justify-between border-b px-4">
        <span className="font-semibold text-sm">Notes</span>
        {AsyncResult.isSuccess(connection) ? (
          <ConnectionStatus state={connection.value} onRetry={() => retry()} />
        ) : null}
      </header>
      <main className="min-h-0 flex-1 overflow-y-auto">
        <Outlet />
      </main>
    </div>
  );
}

export const Route = createRootRoute({
  component: RootLayout,
  errorComponent: RootRouteErrorView,
  notFoundComponent: RootRouteNotFoundView,
});
