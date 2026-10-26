import { assert, describe, it } from "@effect/vitest";

import {
  getPairingTokenFromUrl,
  setPairingTokenOnUrl,
  stripPairingTokenFromUrl,
} from "../src/pairingUrl.ts";

describe("pairing URLs", () => {
  it("reads the token from a pairing url's fragment", () => {
    assert.strictEqual(
      getPairingTokenFromUrl(new URL("https://app.example.com/pair#token=pairing-token")),
      "pairing-token",
    );
  });

  it("accepts pairing urls that still use a query token", () => {
    assert.strictEqual(
      getPairingTokenFromUrl(new URL("https://app.example.com/pair?token=pairing-token")),
      "pairing-token",
    );
  });

  it("finds nothing when the token is missing or blank", () => {
    assert.isNull(getPairingTokenFromUrl(new URL("https://app.example.com/")));
    assert.isNull(getPairingTokenFromUrl(new URL("https://app.example.com/#token=%20")));
  });

  it("strips the token and keeps every other parameter", () => {
    const stripped = stripPairingTokenFromUrl(
      new URL("https://app.example.com/pair?token=a&view=list#token=b&tab=notes"),
    );

    assert.strictEqual(stripped.toString(), "https://app.example.com/pair?view=list#tab=notes");
  });

  it("puts the token in the fragment, never the query", () => {
    const url = setPairingTokenOnUrl(new URL("https://app.example.com/?token=old"), "new token");

    assert.strictEqual(url.toString(), "https://app.example.com/#token=new+token");
    assert.strictEqual(getPairingTokenFromUrl(url), "new token");
  });
});
