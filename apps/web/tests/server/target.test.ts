import { describe, expect, it } from "vitest";

import { resolveServerTarget } from "~/server/target";

describe("resolveServerTarget", () => {
  it("prefers the server the desktop shell supervises", () => {
    expect(
      resolveServerTarget({
        desktop: { httpBaseUrl: "http://127.0.0.1:4000/", wsBaseUrl: "ws://127.0.0.1:4000/" },
        configuredHttpUrl: "https://configured.example/",
        configuredWsUrl: "",
        origin: "http://localhost:5733",
      }),
    ).toEqual({
      httpBaseUrl: "http://127.0.0.1:4000/",
      wsBaseUrl: "ws://127.0.0.1:4000/",
      source: "desktop",
    });
  });

  it("derives the missing half of a configured server URL", () => {
    expect(
      resolveServerTarget({
        desktop: null,
        configuredHttpUrl: "https://configured.example/",
        configuredWsUrl: "",
        origin: "http://localhost:5733",
      }),
    ).toEqual({
      httpBaseUrl: "https://configured.example/",
      wsBaseUrl: "wss://configured.example/",
      source: "configured",
    });
  });

  it("falls back to the page's own origin", () => {
    expect(
      resolveServerTarget({
        desktop: null,
        configuredHttpUrl: "",
        configuredWsUrl: "",
        origin: "http://localhost:5733",
      }),
    ).toEqual({
      httpBaseUrl: "http://localhost:5733",
      wsBaseUrl: "ws://localhost:5733/",
      source: "origin",
    });
  });
});
