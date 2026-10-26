import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Redactable from "effect/Redactable";
import * as References from "effect/References";

import * as ServerConfig from "./config.ts";

// consolePretty collapses Cause fields via util.inspect; render them with Cause.pretty like standalone arguments.
const consolePretty = (): Logger.Logger<unknown, void> => {
  const pretty = Logger.consolePretty();
  return Logger.make((options) =>
    pretty.log({
      ...options,
      message: Array.isArray(options.message)
        ? options.message.map(prettyCauseFields)
        : prettyCauseFields(options.message),
    }),
  );
};

function prettyCauseFields(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
  // A message with its own redaction hook already decides how it prints.
  if (Redactable.isRedactable(value)) return value;
  // Copy descriptors to preserve symbols without invoking getters.
  const descriptors = Object.getOwnPropertyDescriptors(value);
  let changed = false;
  for (const descriptor of Object.values(descriptors)) {
    if ("value" in descriptor && Cause.isCause(descriptor.value)) {
      descriptor.value = Cause.pretty(descriptor.value);
      changed = true;
    }
  }
  return changed ? Object.create(prototype, descriptors) : value;
}

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    return Layer.mergeAll(
      // Logger.layer replaces the whole set; name every logger here.
      Logger.layer([consolePretty(), Logger.tracerLogger], { mergeWithExisting: false }),
      Layer.succeed(References.MinimumLogLevel, config.logLevel),
    );
  }),
);
