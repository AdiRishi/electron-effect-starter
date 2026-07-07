import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { ContextMenuItemSchema, DesktopUpdateState } from "./desktop.ts";

const decodeMenuItem = Schema.decodeUnknownSync(ContextMenuItemSchema);
const decodeUpdateState = Schema.decodeUnknownSync(DesktopUpdateState);

describe("ContextMenuItemSchema", () => {
  it("decodes nested children recursively", () => {
    const decoded = decodeMenuItem({
      id: "root",
      label: "Root",
      children: [{ id: "child", label: "Child", children: [{ id: "leaf", label: "Leaf" }] }],
    });
    assert.strictEqual(decoded.children?.[0]?.children?.[0]?.id, "leaf");
  });

  it("keeps optional flags absent when not provided", () => {
    const decoded = decodeMenuItem({ id: "solo", label: "Solo" });
    assert.notProperty(decoded, "destructive");
    assert.notProperty(decoded, "disabled");
    assert.notProperty(decoded, "children");
  });

  it("rejects malformed nested items", () => {
    assert.throws(() => decodeMenuItem({ id: "root", label: "Root", children: [{ id: 1 }] }));
  });
});

describe("DesktopUpdateState", () => {
  it("rejects an unknown status literal", () => {
    assert.throws(() =>
      decodeUpdateState({
        status: "installing",
        channel: "latest",
        version: null,
        message: null,
      }),
    );
  });
});
