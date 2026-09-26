import { Config, Context, Effect, FileSystem, Inspectable, Layer, Logger, Option, type PlatformError, Predicate } from "effect";

// workflow commands end at the first newline, the runner decodes these escapes back.
const escape = (value: string) => value.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");

const formatMessage = (message: unknown) =>
  (Array.isArray(message) ? message : [message])
    .map((part) => (Predicate.isString(part) ? part : Inspectable.toStringUnknown(part)))
    .join(" ");

// prints logs as forgejo workflow commands, so warnings and errors stand out in the job log.
export const logger = Logger.make(({ logLevel, message }) => {
  const line = formatMessage(message);
  switch (logLevel) {
    case "Fatal":
    case "Error":
      return console.log(`::error::${escape(line)}`);
    case "Warn":
      return console.log(`::warning::${escape(line)}`);
    default:
      return console.log(line);
  }
});

export class Outputs extends Context.Service<Outputs, {
  set(name: string, value: string): Effect.Effect<void, PlatformError.PlatformError>;
}>()("upload-release-assets/Outputs") {
  // appends to the file the runner reads step outputs from, outside a runner there is none.
  static readonly layer = Layer.effect(
    Outputs,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const file = yield* Config.option(Config.String("FORGEJO_OUTPUT"));

      const set = Effect.fn("Outputs.set")(function* (name: string, value: string) {
        if (Option.isNone(file)) return;
        yield* fs.writeFileString(file.value, `${name}=${value}\n`, { flag: "a" });
      });

      return Outputs.of({ set });
    }),
  );
}
