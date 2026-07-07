import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { NonNegativeInt, Port, TrimmedNonEmptyString } from "../src/baseSchemas.ts";

const decodeTrimmed = Schema.decodeUnknownSync(TrimmedNonEmptyString);
const encodeTrimmed = Schema.encodeSync(TrimmedNonEmptyString);
const decodePort = Schema.decodeUnknownSync(Port);
const decodeNonNegativeInt = Schema.decodeUnknownSync(NonNegativeInt);

describe("TrimmedNonEmptyString", () => {
  it("trims surrounding whitespace on decode", () => {
    assert.strictEqual(decodeTrimmed("  hi  "), "hi");
  });

  it("rejects empty and whitespace-only strings", () => {
    assert.throws(() => decodeTrimmed(""));
    assert.throws(() => decodeTrimmed("   "));
  });

  it("encodes trimmed values unchanged", () => {
    assert.strictEqual(encodeTrimmed("ok"), "ok");
  });

  it("rejects untrimmed values on encode instead of silently trimming", () => {
    // `Schema.Trim`'s Type side is refined to already-trimmed strings, so a
    // program value with stray whitespace is a bug — surfaced, not repaired.
    assert.throws(() => encodeTrimmed("  x  "));
  });
});

describe("NonNegativeInt", () => {
  it("accepts zero", () => {
    assert.strictEqual(decodeNonNegativeInt(0), 0);
  });

  it("rejects negatives and non-integers", () => {
    assert.throws(() => decodeNonNegativeInt(-1));
    assert.throws(() => decodeNonNegativeInt(1.5));
  });
});

describe("Port", () => {
  it("accepts the full valid range", () => {
    assert.strictEqual(decodePort(1), 1);
    assert.strictEqual(decodePort(65535), 65535);
  });

  it("rejects out-of-range and fractional ports", () => {
    assert.throws(() => decodePort(0));
    assert.throws(() => decodePort(65536));
    assert.throws(() => decodePort(8080.5));
  });
});
