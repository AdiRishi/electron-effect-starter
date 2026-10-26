import { RegistryContext } from "@effect/atom-react";
import { createBrowserHistory, createHashHistory, RouterProvider } from "@tanstack/react-router";
import { AtomRegistry } from "effect/reactivity";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "./index.css";

import { SignInRequired } from "./components/SignInRequired";
import { isElectron } from "./env";
import { getRouter } from "./router";
import { resolveInitialServerAuthGateState, type ServerAuthGateState } from "./server/auth";

const registry = AtomRegistry.make();

async function start() {
  // The desktop renderer authenticates with a bearer token from the shell; a browser needs a cookie.
  const authGate: ServerAuthGateState = isElectron
    ? { status: "authenticated" }
    : await resolveInitialServerAuthGateState();

  const root = createRoot(document.getElementById("root")!);

  if (authGate.status === "requires-auth") {
    root.render(
      <StrictMode>
        <SignInRequired
          initialErrorMessage={authGate.errorMessage}
          // A full load starts the connection with the new session cookie.
          onAuthenticated={() => window.location.reload()}
        />
      </StrictMode>,
    );

    return;
  }

  // The desktop shell serves one document from its own scheme, so routes live in the hash there.
  const router = getRouter(isElectron ? createHashHistory() : createBrowserHistory());
  await router.load();
  root.render(
    <StrictMode>
      <RegistryContext.Provider value={registry}>
        <RouterProvider router={router} />
      </RegistryContext.Provider>
    </StrictMode>,
  );
}

export const startup = start();
