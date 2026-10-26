import { assert, describe, it } from "@effect/vitest";

import * as DesktopApp from "../../src/app/DesktopApp.ts";

describe("DesktopApp", () => {
  it("lets the renderer write to the clipboard and go fullscreen, and nothing else", () => {
    assert.isTrue(DesktopApp.isRendererPermissionAllowed("clipboard-sanitized-write"));
    assert.isTrue(DesktopApp.isRendererPermissionAllowed("fullscreen"));
    assert.isFalse(DesktopApp.isRendererPermissionAllowed("clipboard-read"));
    assert.isFalse(DesktopApp.isRendererPermissionAllowed("media"));
    assert.isFalse(DesktopApp.isRendererPermissionAllowed("notifications"));
  });
});
