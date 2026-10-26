import { describe, expect, it } from "vitest";

import { type BootErrorEnvironment, buildErrorReport } from "~/lib/bootError";

const environment: BootErrorEnvironment = {
  version: "0.1.3",
  surface: "web",
  platform: "MacIntel",
  userAgent: "Test",
  time: "2026-10-26T00:00:00.000Z",
};

describe("buildErrorReport", () => {
  it("drops hosts and tokens from URLs in the error", () => {
    const error = new TypeError(
      "Failed to fetch dynamically imported module: http://studio.tail1234.ts.net:3773/assets/a.js?pair=SECRET#token=SECRET",
      {
        cause: new Error(
          "ws://studio.tail1234.ts.net:3773/ws?token=SECRET closed, main-a.js?sig=SECRET",
        ),
      },
    );

    error.stack = `TypeError: ${error.message}\n    at http://studio.tail1234.ts.net:3773/src/main.tsx?t=1:10:5`;
    const report = buildErrorReport(error, environment);

    expect(report).not.toContain("SECRET");
    expect(report).not.toContain("tail1234");
    expect(report).toContain("module: /assets/a.js\n    at /src/main.tsx:10:5");
    expect(report).toContain("Caused by: Error: /ws closed, main-a.js");
    expect(report).toContain("Version: 0.1.3");
  });

  it("keeps the header when a Firefox stack frame starts with the error name", () => {
    const error = new Error("boot failed");
    error.stack = "ErrorBoundary@/assets/main.js:1:2";

    expect(buildErrorReport(error, environment)).toMatch(
      /^Error: boot failed\nErrorBoundary@\/assets\/main.js:1:2\n/,
    );

    const unnamed = new Error();
    unnamed.stack = "ErrorBoundary@/assets/main.js:1:2";

    expect(buildErrorReport(unnamed, environment)).toMatch(/^Error\nErrorBoundary@/);
  });

  it("stops at cause cycles and survives values that are not errors", () => {
    const loop = new Error("outer");
    loop.cause = loop;

    expect(buildErrorReport(loop, environment).match(/outer/g)).toHaveLength(1);
    expect(buildErrorReport("plain text", environment)).toMatch(/^plain text\n/);
    expect(buildErrorReport({ code: 42 }, environment)).toMatch(/^\{"code":42\}\n/);
    expect(buildErrorReport(Object.create(null), environment)).toMatch(/^\{\}\n/);
    expect(buildErrorReport(undefined, environment)).toMatch(/^\(no error message\)\n/);
  });

  it("cuts long errors but keeps the environment", () => {
    const report = buildErrorReport("x".repeat(20_000), environment);

    expect(report).toContain("[truncated]");
    expect(report.length).toBeLessThan(7_000);
    expect(report).toContain("Time: 2026-10-26T00:00:00.000Z");
  });
});
