export function SignInRequired() {
  return (
    <main className="flex h-full items-center justify-center p-6">
      <div className="max-w-sm space-y-2 text-sm">
        <h1 className="font-semibold text-base">Sign in to the local server</h1>
        <p className="text-muted-foreground">
          This browser has no session. Open the sign-in link the server printed when it started.
          Each link works once and expires after fifteen minutes; restart the server for a new one.
        </p>
      </div>
    </main>
  );
}
