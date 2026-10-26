// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto has no createHmac or timingSafeEqual.
import * as NodeCrypto from "node:crypto";

import * as Base64Url from "effect/encoding/Base64Url";
import * as Result from "effect/Result";

export function base64UrlEncode(input: string): string {
  return Base64Url.encode(new TextEncoder().encode(input));
}

export function base64UrlDecodeUtf8(input: string): string {
  return Result.getOrThrow(Base64Url.decodeString(input));
}

export function signPayload(payload: string, secret: Uint8Array): string {
  return NodeCrypto.createHmac("sha256", Buffer.from(secret)).update(payload).digest("base64url");
}

export function timingSafeEqualBase64Url(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "base64url");
  const rightBuffer = Buffer.from(right, "base64url");

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return NodeCrypto.timingSafeEqual(leftBuffer, rightBuffer);
}
