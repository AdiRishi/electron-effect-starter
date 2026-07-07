import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { ServerBootstrapEnvelope, TickEvent } from "./server.ts";

const decodeEnvelope = Schema.decodeUnknownSync(ServerBootstrapEnvelope);
const encodeEnvelope = Schema.encodeSync(ServerBootstrapEnvelope);
// TickEvent crosses the WS RPC layer, which wraps schemas in
// `Schema.toCodecJson` — so its JSON form (ISO `at`) is the wire contract.
const decodeTick = Schema.decodeUnknownSync(Schema.toCodecJson(TickEvent));

describe("ServerBootstrapEnvelope", () => {
  it("decodes without a port and keeps the key absent through a roundtrip", () => {
    const decoded = decodeEnvelope({ desktopBootstrapToken: "boot-token" });
    assert.notProperty(decoded, "port");
    assert.notProperty(encodeEnvelope(decoded), "port");
  });

  it("accepts a valid forced port", () => {
    const decoded = decodeEnvelope({ desktopBootstrapToken: "boot-token", port: 13773 });
    assert.strictEqual(decoded.port, 13773);
  });

  it("rejects out-of-range ports and blank tokens", () => {
    assert.throws(() => decodeEnvelope({ desktopBootstrapToken: "boot-token", port: 0 }));
    assert.throws(() => decodeEnvelope({ desktopBootstrapToken: "  " }));
  });
});

describe("TickEvent", () => {
  it("decodes the wire shape", () => {
    const decoded = decodeTick({ tick: 0, at: "2026-07-03T00:00:00.000Z" });
    assert.strictEqual(decoded.tick, 0);
  });

  it("rejects a negative tick", () => {
    assert.throws(() => decodeTick({ tick: -1, at: "2026-07-03T00:00:00.000Z" }));
  });
});
