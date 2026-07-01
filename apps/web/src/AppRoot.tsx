import { App } from "./App.tsx";

/**
 * Owns renderer-wide composition. A starter has no router or global providers,
 * so this just renders the single demo page — but it's the natural seam to add
 * context providers (theme, error boundary, a router) as the app grows.
 */
export function AppRoot() {
  return <App />;
}
