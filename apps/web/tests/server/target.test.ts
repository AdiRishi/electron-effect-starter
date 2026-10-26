import { describe, expect, it } from "vitest";

import { resolveServerTarget } from "~/server/target";

const PAGE_ORIGIN = "http://localhost:5733";

describe("resolveServerTarget", () => {
  it("prefers the server the desktop shell supervises", () => {
    expect(
      resolveServerTarget({
        desktop: { httpBaseUrl: "http://127.0.0.1:4000/", wsBaseUrl: "ws://127.0.0.1:4000/" },
        configuredHttpUrl: "https://configured.example/",
        configuredWsUrl: "",
        origin: PAGE_ORIGIN,
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
        origin: PAGE_ORIGIN,
      }),
    ).toEqual({
      httpBaseUrl: "https://configured.example/",
      wsBaseUrl: "wss://configured.example/",
      source: "configured",
    });
  });

  it("keeps an uppercase wss scheme secure when deriving the http url", () => {
    expect(
      resolveServerTarget({
        desktop: null,
        configuredHttpUrl: "",
        configuredWsUrl: "WSS://remote.example.com",
        origin: PAGE_ORIGIN,
      }),
    ).toEqual({
      httpBaseUrl: "https://remote.example.com/",
      wsBaseUrl: "wss://remote.example.com/",
      source: "configured",
    });
  });

  it("keeps an uppercase https scheme secure when deriving the websocket url", () => {
    expect(
      resolveServerTarget({
        desktop: null,
        configuredHttpUrl: "HTTPS://remote.example.com",
        configuredWsUrl: "",
        origin: PAGE_ORIGIN,
      }),
    ).toEqual({
      httpBaseUrl: "https://remote.example.com/",
      wsBaseUrl: "wss://remote.example.com/",
      source: "configured",
    });
  });

  it("resolves a configured path against the page origin", () => {
    expect(
      resolveServerTarget({
        desktop: null,
        configuredHttpUrl: "/backend/",
        configuredWsUrl: "",
        origin: PAGE_ORIGIN,
      }),
    ).toEqual({
      httpBaseUrl: "http://localhost:5733/backend/",
      wsBaseUrl: "ws://localhost:5733/backend/",
      source: "configured",
    });
  });

  it("falls back to the page's own origin", () => {
    expect(
      resolveServerTarget({
        desktop: null,
        configuredHttpUrl: "",
        configuredWsUrl: "",
        origin: PAGE_ORIGIN,
      }),
    ).toEqual({
      httpBaseUrl: "http://localhost:5733/",
      wsBaseUrl: "ws://localhost:5733/",
      source: "origin",
    });
  });

  it("refuses a page origin that cannot reach a server", () => {
    expect(() =>
      resolveServerTarget({
        desktop: null,
        configuredHttpUrl: "",
        configuredWsUrl: "",
        origin: "electron-effect-starter://app",
      }),
    ).toThrow("The origin server target uses unsupported protocol electron-effect-starter:.");
  });
});
