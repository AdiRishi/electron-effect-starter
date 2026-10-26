import { Link, type ErrorComponentProps, useLocation, useRouter } from "@tanstack/react-router";
import { CheckIcon, CopyIcon } from "lucide-react";

import { Button } from "~/components/ui/button";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";

const APP_DISPLAY_NAME = "Electron Effect Starter";
const MAX_ERROR_CAUSE_DEPTH = 5;

export function RootRouteNotFoundView() {
  return (
    <main className="flex min-h-0 min-w-0 flex-1 items-center justify-center p-6">
      <div className="flex max-w-sm flex-col items-center gap-4 text-center">
        <h1 className="font-medium text-foreground text-lg">Page not found</h1>
        <p className="text-muted-foreground text-sm">
          This link doesn't point to a page in {APP_DISPLAY_NAME}. Go home to see your notes.
        </p>
        <Button render={<Link to="/" replace />}>Go home</Button>
      </div>
    </main>
  );
}

export function RootRouteErrorView({ error }: ErrorComponentProps) {
  const router = useRouter();
  const message = errorMessage(error);
  // Router pathname rather than window.location: desktop uses hash history, where the window path is always "/".
  const pathname = useLocation({ select: (location) => location.pathname });
  const report = errorReport(error, pathname);

  return (
    <main className="flex h-full items-center justify-center overflow-y-auto p-6">
      <div className="w-full max-w-xl">
        <p className="font-medium text-muted-foreground text-xs">{APP_DISPLAY_NAME}</p>
        <h1 className="mt-1 font-semibold text-foreground text-lg">Something went wrong.</h1>
        <p className="mt-2 text-muted-foreground text-sm">{message}</p>

        <div className="mt-5 flex flex-wrap gap-2">
          <Button size="sm" onClick={() => void router.invalidate()}>
            Try again
          </Button>
          <Button size="sm" variant="outline" onClick={() => window.location.reload()}>
            Reload app
          </Button>
          <CopyErrorButton report={report} />
        </div>

        <div className="mt-5 overflow-hidden rounded-lg border border-border/70 bg-background/55">
          <p className="px-3 py-1.5 font-medium text-muted-foreground text-xs">Error report</p>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap border-border/70 border-t bg-background/80 px-3 py-2 text-foreground/85 text-xs">
            {report}
          </pre>
        </div>
      </div>
    </main>
  );
}

function CopyErrorButton({ report }: { report: string }) {
  const { copyToClipboard, isCopied } = useCopyToClipboard({ target: "error-report" });

  return (
    <Button size="sm" variant="outline" onClick={() => copyToClipboard(report)}>
      {isCopied ? <CheckIcon className="text-success" /> : <CopyIcon />}
      {isCopied ? "Copied" : "Copy error"}
    </Button>
  );
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- a route can throw anything.
function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- a route can throw anything.
  if (typeof error === "string" && error.trim().length > 0) {
    return error;
  }

  return "An unexpected router error occurred.";
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- a route can throw anything.
function errorDetails(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }

  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- a route can throw anything.
  if (typeof error === "string") {
    return error;
  }

  try {
    return JSON.stringify(error, null, 2);
  } catch {
    return "No additional error details are available.";
  }
}

// Use only pathname to keep query tokens off the clipboard.
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- a route can throw anything.
function errorReport(error: unknown, pathname: string): string {
  const lines = [
    `${APP_DISPLAY_NAME} ${import.meta.env.APP_VERSION}`,
    `Path: ${pathname}`,
    `Time: ${new Date().toISOString()}`,
    "",
    errorDetails(error),
  ];

  let cause = error instanceof Error ? error.cause : undefined;

  for (let depth = 0; cause !== undefined && depth < MAX_ERROR_CAUSE_DEPTH; depth += 1) {
    lines.push("", "Caused by:", errorDetails(cause));
    cause = cause instanceof Error ? cause.cause : undefined;
  }

  return lines.join("\n");
}
