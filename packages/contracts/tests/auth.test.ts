import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

import {
  BearerSessionJson,
  BootstrapBearerInput,
  EnvironmentAuthorizationError,
} from "../src/auth.ts";

// The wire codec is the contract: raw `BearerSession` only validates in-memory
// `DateTime.Utc` instances and cannot decode the HTTP response JSON.
const decodeSession = Schema.decodeUnknownSync(BearerSessionJson);
const encodeSession = Schema.encodeSync(BearerSessionJson);
const decodeBootstrapInput = Schema.decodeUnknownSync(BootstrapBearerInput);

describe("BearerSession JSON wire codec", () => {
  it("decodes expires_at into a DateTime and encodes back to the ISO wire form", () => {
    const decoded = decodeSession({
      access_token: "tok-1",
      expires_at: "2026-07-03T00:00:00.000Z",
    });
    assert.isTrue(DateTime.isDateTime(decoded.expires_at));

    assert.deepStrictEqual(encodeSession(decoded), {
      access_token: "tok-1",
      expires_at: "2026-07-03T00:00:00.000Z",
    });
  });

  it("passes a null expires_at (session-lifetime token) through both directions", () => {
    const decoded = decodeSession({ access_token: "tok-1", expires_at: null });
    assert.isNull(decoded.expires_at);
    assert.deepStrictEqual(encodeSession(decoded), { access_token: "tok-1", expires_at: null });
  });

  it("rejects a blank access_token", () => {
    assert.throws(() => decodeSession({ access_token: "   ", expires_at: null }));
  });
});

describe("BootstrapBearerInput", () => {
  it("decodes with clientMetadata absent", () => {
    const decoded = decodeBootstrapInput({ credential: "boot-token" });
    assert.strictEqual(decoded.credential, "boot-token");
    assert.notProperty(decoded, "clientMetadata");
  });

  it("rejects an unknown deviceType", () => {
    assert.throws(() =>
      decodeBootstrapInput({
        credential: "boot-token",
        clientMetadata: { label: "My Mac", deviceType: "mobile" },
      }),
    );
  });
});

describe("EnvironmentAuthorizationError", () => {
  it("carries the reason in its tag and message", () => {
    const error = new EnvironmentAuthorizationError({ reason: "expired" });
    assert.strictEqual(error._tag, "EnvironmentAuthorizationError");
    assert.include(error.message, "expired");
  });
});
