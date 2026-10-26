import { describe, expect, it } from "vitest";
import * as Option from "effect/Option";

import { parseSafeExternalUrl } from "../../src/electron/ElectronShell.ts";

describe("parseSafeExternalUrl", () => {
  it.each(["https://example.com/path", "http://localhost:3000", "mailto:someone@example.com"])(
    "lets %s open outside the app",
    (url) => {
      expect(Option.isSome(parseSafeExternalUrl(url))).toBe(true);
    },
  );

  it.each([
    "file:///etc/passwd",
    "javascript:alert(1)",
    "smb://attacker/share",
    "electron-effect-starter://app/",
    "not a url",
  ])("refuses %s", (url) => {
    expect(Option.isNone(parseSafeExternalUrl(url))).toBe(true);
  });
});
