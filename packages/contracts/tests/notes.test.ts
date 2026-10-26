import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { NOTE_TITLE_MAX_LENGTH, NoteCreateInput } from "../src/notes.ts";

const decodeCreateInput = Schema.decodeUnknownEffect(NoteCreateInput);

describe("NoteCreateInput", () => {
  it.effect("trims the title and body a client sends", () =>
    Effect.gen(function* () {
      const input = yield* decodeCreateInput({ title: "  Groceries ", body: "\n milk \n" });
      assert.deepStrictEqual(input, { title: "Groceries", body: "milk" });
    }),
  );

  it.effect("rejects a title that is only whitespace", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(decodeCreateInput({ title: "   ", body: "" }));
      assert.isTrue(Exit.isFailure(exit));
    }),
  );

  it.effect("rejects a title over the length limit", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        decodeCreateInput({ title: "x".repeat(NOTE_TITLE_MAX_LENGTH + 1), body: "" }),
      );

      assert.isTrue(Exit.isFailure(exit));
    }),
  );
});
