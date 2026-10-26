import { assert, describe, it } from "@effect/vitest";

import { resolveSessionCookieName } from "../../src/auth/utils.ts";

describe("session cookie isolation", () => {
  it("isolates loopback web servers by port and server state", () => {
    const first = resolveSessionCookieName({
      mode: "web",
      port: 5775,
      host: "127.0.0.1",
      instanceKey: "/tmp/app-agent-one",
      development: true,
    });

    const second = resolveSessionCookieName({
      mode: "web",
      port: 5775,
      host: "127.0.0.1",
      instanceKey: "/tmp/app-agent-two",
      development: true,
    });

    assert.match(first, /^app_session_5775_[a-f0-9]{12}$/);
    assert.match(second, /^app_session_5775_[a-f0-9]{12}$/);
    assert.notStrictEqual(first, second);
  });

  it("isolates remote web servers by server state", () => {
    const first = resolveSessionCookieName({
      mode: "web",
      port: 3773,
      host: "192.168.1.50",
      instanceKey: "/srv/app-one",
      development: false,
    });

    const second = resolveSessionCookieName({
      mode: "web",
      port: 5775,
      host: "192.168.1.50",
      instanceKey: "/srv/app-two",
      development: false,
    });

    assert.match(first, /^app_session_[a-f0-9]{12}$/);
    assert.match(second, /^app_session_[a-f0-9]{12}$/);
    assert.notStrictEqual(first, second);
  });

  it("keeps a remote web server cookie stable across port changes", () => {
    const first = resolveSessionCookieName({
      mode: "web",
      port: 8080,
      host: "0.0.0.0",
      instanceKey: "/srv/app",
      development: false,
    });

    const second = resolveSessionCookieName({
      mode: "web",
      port: 9090,
      host: "app.example.com",
      instanceKey: "/srv/app",
      development: false,
    });

    assert.strictEqual(first, second);
  });
});
