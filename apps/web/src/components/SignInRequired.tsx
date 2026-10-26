import { startTransition, useState, type SubmitEvent } from "react";

import { Alert, AlertDescription } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { submitServerAuthCredential } from "~/server/auth";

export function SignInRequired({
  initialErrorMessage,
  onAuthenticated,
}: {
  readonly initialErrorMessage?: string | undefined;
  readonly onAuthenticated: () => void;
}) {
  const [credential, setCredential] = useState("");
  const [errorMessage, setErrorMessage] = useState(initialErrorMessage ?? "");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const submitCredential = async (nextCredential: string) => {
    setIsSubmitting(true);
    setErrorMessage("");

    const submitError = await submitServerAuthCredential(nextCredential).then(
      () => null,
      errorMessageFromUnknown,
    );

    setIsSubmitting(false);

    if (submitError) {
      setErrorMessage(submitError);

      return;
    }

    startTransition(() => {
      onAuthenticated();
    });
  };

  const handleSubmit = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    await submitCredential(credential);
  };

  return (
    <main className="flex h-full items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <h1 className="font-semibold text-base">Sign in to the local server</h1>
        <p className="mt-2 text-muted-foreground text-sm">
          Open the sign-in link the server printed when it started, or paste its token here. Each
          token works once and expires after fifteen minutes; restart the server for a new one.
        </p>

        <form className="mt-6 space-y-4" onSubmit={(event) => void handleSubmit(event)}>
          <div className="space-y-2">
            <label className="font-medium text-sm" htmlFor="pairing-token">
              Pairing token
            </label>
            <Input
              id="pairing-token"
              autoCapitalize="none"
              autoComplete="off"
              autoCorrect="off"
              disabled={isSubmitting}
              nativeInput
              onChange={(event) => setCredential(event.currentTarget.value)}
              placeholder="Paste a one-time token"
              spellCheck={false}
              value={credential}
            />
          </div>

          {errorMessage ? (
            <Alert variant="error">
              <AlertDescription>{errorMessage}</AlertDescription>
            </Alert>
          ) : null}

          <div className="flex flex-wrap gap-2">
            <Button disabled={isSubmitting} size="sm" type="submit">
              {isSubmitting ? "Signing in..." : "Continue"}
            </Button>
            <Button
              disabled={isSubmitting}
              onClick={() => window.location.reload()}
              size="sm"
              variant="outline"
            >
              Reload app
            </Button>
          </div>
        </form>
      </div>
    </main>
  );
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- a promise rejection carries no type.
function errorMessageFromUnknown(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  return "Authentication failed.";
}
