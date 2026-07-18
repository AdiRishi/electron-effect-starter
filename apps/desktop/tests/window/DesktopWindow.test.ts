import { assert, describe, it } from "@effect/vitest";

import { isSameOriginNavigation } from "../../src/window/DesktopWindow.ts";

// The predicate behind the `will-navigate` guard: only same-origin navigations
// may replace the top-level frame; anything else — including URLs that don't
// parse — must be blocked.

describe("isSameOriginNavigation", () => {
  const appUrl = "http://127.0.0.1:13773/";

  it("allows same-origin paths and queries", () => {
    assert.isTrue(isSameOriginNavigation(appUrl, "http://127.0.0.1:13773/settings?tab=updates"));
  });

  it("blocks a different host, port, or scheme", () => {
    assert.isFalse(isSameOriginNavigation(appUrl, "http://localhost:13773/"));
    assert.isFalse(isSameOriginNavigation(appUrl, "http://127.0.0.1:9999/"));
    assert.isFalse(isSameOriginNavigation(appUrl, "https://127.0.0.1:13773/"));
    assert.isFalse(isSameOriginNavigation(appUrl, "https://example.com/"));
  });

  it("blocks unparseable navigation targets", () => {
    assert.isFalse(isSameOriginNavigation(appUrl, "not a url"));
    assert.isFalse(isSameOriginNavigation("also not a url", "http://127.0.0.1:13773/"));
  });
});
