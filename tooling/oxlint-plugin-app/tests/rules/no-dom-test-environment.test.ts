import { describe } from "@effect/vitest";

import { createOxlintRuleHarness } from "../utils.ts";

const rule = createOxlintRuleHarness("app/no-dom-test-environment");

// Vitest scans this file's own text for the pragma, so the fixtures must not spell it out.
const PRAGMA = ["@vitest", "environment"].join("-");

describe("app/no-dom-test-environment", () => {
  rule.valid("allows browser tests", 'import { page } from "vitest/browser";');
  rule.valid("allows similarly named packages", 'import "jsdom-helper";');
  rule.invalid("rejects line pragmas", `// ${PRAGMA} jsdom\nexport {};`);
  rule.invalid("rejects block pragmas for any environment", `/** ${PRAGMA} node */`);
  rule.invalid("rejects jsdom imports", 'import { JSDOM } from "jsdom";');
  rule.invalid("rejects happy-dom imports", 'import "happy-dom";');
  rule.invalid("rejects emulator subpaths", 'import "jsdom/lib/api.js";');
  rule.invalid("rejects dynamic imports", 'const dom = import("happy-dom");');
  rule.invalid("rejects template imports", "const dom = import(`jsdom`);");
  rule.invalid("rejects CommonJS imports", 'const dom = require("jsdom");');
  rule.invalid("rejects TypeScript require imports", 'import dom = require("happy-dom");');
  rule.invalid("rejects re-exports", 'export { JSDOM } from "jsdom";');
});
