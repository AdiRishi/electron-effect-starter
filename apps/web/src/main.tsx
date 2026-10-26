import { RegistryContext } from "@effect/atom-react";
import { createBrowserHistory, createHashHistory, RouterProvider } from "@tanstack/react-router";
import * as Effect from "effect/Effect";
import { FetchHttpClient } from "effect/http";
import { AtomRegistry } from "effect/reactivity";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "./index.css";

import { SignInRequired } from "./components/SignInRequired";
import { isElectron } from "./env";
import { getRouter } from "./router";
import { ensureBrowserSession } from "./server/browserAuth";
import { serverTarget } from "./server/current";

const registry = AtomRegistry.make();

// The desktop renderer authenticates with a bearer token from the shell; a browser needs a cookie.
const authenticated = isElectron
  ? true
  : await Effect.runPromise(
      ensureBrowserSession(serverTarget.httpBaseUrl).pipe(Effect.provide(FetchHttpClient.layer)),
    );

const root = createRoot(document.getElementById("root")!);

if (!authenticated) {
  root.render(<SignInRequired />);
} else {
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
