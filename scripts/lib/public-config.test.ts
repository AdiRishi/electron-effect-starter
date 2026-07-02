import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadRepoEnv, readEnvFile } from "./public-config.ts";

let dir: string;

beforeEach(() => {
  dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "public-config-"));
});

afterEach(() => {
  NodeFS.rmSync(dir, { recursive: true, force: true });
});

const write = (name: string, contents: string) => {
  NodeFS.writeFileSync(NodePath.join(dir, name), contents);
};

describe("readEnvFile", () => {
  it("parses keys, strips quotes, and skips comments and blanks", () => {
    write(
      ".env",
      [
        "# comment",
        "",
        "PLAIN=value",
        'DOUBLE="quoted value"',
        "SINGLE='single quoted'",
        "SPACED =  padded  ",
        "EQUALS=a=b=c",
        "no-equals-line",
      ].join("\n"),
    );

    expect(readEnvFile(NodePath.join(dir, ".env"))).toEqual({
      PLAIN: "value",
      DOUBLE: "quoted value",
      SINGLE: "single quoted",
      SPACED: "padded",
      EQUALS: "a=b=c",
    });
  });

  it("returns an empty record for a missing file", () => {
    expect(readEnvFile(NodePath.join(dir, "missing.env"))).toEqual({});
  });
});

describe("loadRepoEnv", () => {
  it("layers .env.local over .env, with baseEnv winning overall", () => {
    write(".env", "A=from-env\nB=from-env\nC=from-env\n");
    write(".env.local", "B=from-local\nC=from-local\n");

    expect(loadRepoEnv({ repoRoot: dir, baseEnv: { C: "from-shell" } })).toEqual({
      A: "from-env",
      B: "from-local",
      C: "from-shell",
    });
  });
});
