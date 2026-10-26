// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto has no createHmac or timingSafeEqual.
import * as NodeCrypto from "node:crypto";

import * as Base64Url from "effect/encoding/Base64Url";
import * as Result from "effect/Result";

const SESSION_COOKIE_NAME = "app_session";

/** Cookies span ports; use separate names for servers sharing a hostname. */
export function resolveSessionCookieName(input: {
  readonly mode: "web" | "desktop";
  readonly port: number;
  readonly host: string | undefined;
  readonly instanceKey: string;
  readonly development: boolean;
}): string {
  if (input.mode === "desktop") {
    return `${SESSION_COOKIE_NAME}_${input.port}`;
  }

  const instanceHash = NodeCrypto.createHash("sha256")
    .update(input.instanceKey)
    .digest("hex")
    .slice(0, 12);

  // A server reached from other machines keeps its cookie across port changes.
  if (!input.development && isRemoteReachableHost(input.host)) {
    return `${SESSION_COOKIE_NAME}_${instanceHash}`;
  }

  return `${SESSION_COOKIE_NAME}_${input.port}_${instanceHash}`;
}

export function isRemoteReachableHost(host: string | undefined): boolean {
  if (host === "0.0.0.0" || host === "::" || host === "[::]") {
    return true;
  }

  if (!host || host.length === 0) {
    return false;
  }

  return !(
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "[::1]" ||
    host.startsWith("127.")
  );
}

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
