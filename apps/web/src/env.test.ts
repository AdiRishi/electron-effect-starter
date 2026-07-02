import { describe, expect, it } from "vitest";

import { toHttpOrigin, toWsOrigin } from "./env.ts";

describe("connection target URL conversion", () => {
  it("maps ws(s) URLs to their http(s) origins", () => {
    expect(toHttpOrigin("ws://127.0.0.1:13773")).toBe("http://127.0.0.1:13773");
    expect(toHttpOrigin("wss://example.com/ws?token=x#y")).toBe("https://example.com");
  });

  it("maps http(s) origins to their ws(s) forms", () => {
    expect(toWsOrigin("http://127.0.0.1:5733")).toBe("ws://127.0.0.1:5733");
    expect(toWsOrigin("https://example.com/app?tab=1")).toBe("wss://example.com");
  });

  it("round-trips an origin through both conversions", () => {
    expect(toWsOrigin(toHttpOrigin("ws://127.0.0.1:13773"))).toBe("ws://127.0.0.1:13773");
  });
});
