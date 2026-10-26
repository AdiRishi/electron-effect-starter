import { assert, describe } from "@effect/vitest";

import { createOxlintRuleHarness } from "../utils.ts";

const rule = createOxlintRuleHarness("app/no-outset-state-indicators", {
  filename: "fixture.tsx",
});

describe("app/no-outset-state-indicators", () => {
  rule.valid(
    "allows a focus ring drawn inside the element",
    `const el = <button className="focus-visible:ring-2 focus-visible:ring-inset" />;`,
  );

  rule.valid(
    "finds ring-inset in another argument of the same class composer",
    `const className = cn("focus-visible:ring-2", "focus-visible:ring-inset");`,
  );

  rule.valid(
    "allows a ring that only some state shows on hover",
    `const el = <div className="hover:ring-2" />;`,
  );

  rule.valid(
    "allows a thin outline, which the default offset keeps visible",
    `const el = <a className="focus-visible:outline-2" />;`,
  );

  rule.valid(
    "allows a wide outline pulled inward by at least its width",
    `const el = <a className="focus-visible:outline-3 focus-visible:-outline-offset-3" />;`,
  );

  rule.invalid(
    "reports a focus ring with nothing keeping it inside",
    `const el = <button className="focus-visible:ring-2" />;`,
    (output) => {
      assert.include(output, "focus-visible:ring-2 paints a focus or selection indicator");
    },
  );

  rule.invalid(
    "reports ring-inset under a different variant than the ring",
    `const el = <button className="focus-visible:ring-2 hover:ring-inset" />;`,
  );

  rule.invalid(
    "reports a selected ring in a template literal",
    "const className = `data-selected:selected:ring-1 ${base}`;",
  );

  rule.invalid(
    "reports a positive outline offset",
    `const el = <a className="outline-offset-2" />;`,
  );

  rule.invalid(
    "reports a wide outline that an offset smaller than its width leaves outside",
    `const el = <a className="focus-visible:outline-4 focus-visible:-outline-offset-2" />;`,
  );
});
