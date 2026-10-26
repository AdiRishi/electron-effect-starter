export function showBootError(error: unknown): void {
  const root = document.getElementById("root");

  if (!root) return;
  const container = document.createElement("div");
  container.style.cssText = "padding: 24px; font: 13px/20px system-ui, sans-serif;";
  const heading = document.createElement("h1");
  heading.textContent = "The app failed to start.";
  heading.style.cssText = "margin: 0 0 8px; font-size: 15px;";
  const detail = document.createElement("pre");
  detail.textContent = error instanceof Error ? (error.stack ?? error.message) : String(error);
  detail.style.cssText = "white-space: pre-wrap; opacity: 0.7;";
  container.append(heading, detail);
  root.replaceChildren(container);
}
