import { describe, expect, it } from "@effect/vitest";

import { isLoopbackHostname, resolveDevRedirectUrl } from "../src/http.ts";

describe("http helpers", () => {
  it("treats localhost and loopback addresses as local", () => {
    expect(isLoopbackHostname("localhost")).toBe(true);
    expect(isLoopbackHostname("127.0.0.1")).toBe(true);
    expect(isLoopbackHostname("::1")).toBe(true);
    expect(isLoopbackHostname("[::1]")).toBe(true);
    expect(isLoopbackHostname(" LOCALHOST ")).toBe(true);
  });

  it("does not treat LAN addresses as local", () => {
    expect(isLoopbackHostname("192.168.1.10")).toBe(false);
    expect(isLoopbackHostname("example.com")).toBe(false);
    expect(isLoopbackHostname("10.0.0.1")).toBe(false);
  });

  it("preserves path, query, and hash when redirecting to the dev server", () => {
    const redirect = resolveDevRedirectUrl(
      new URL("http://127.0.0.1:5173"),
      new URL("http://127.0.0.1:13773/settings?tab=updates#anchor"),
    );
    expect(redirect).toBe("http://127.0.0.1:5173/settings?tab=updates#anchor");
  });
});
