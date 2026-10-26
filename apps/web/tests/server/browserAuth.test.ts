import { describe, expect, it } from "vitest";

import { readPairingToken } from "~/server/browserAuth";

describe("readPairingToken", () => {
  it("reads the token the server puts in the sign-in link's fragment", () => {
    expect(readPairingToken("#token=abc_DEF-123")).toBe("abc_DEF-123");
  });

  it("finds nothing in an empty or blank fragment", () => {
    expect(readPairingToken("")).toBeNull();
    expect(readPairingToken("#token=%20")).toBeNull();
  });
});
