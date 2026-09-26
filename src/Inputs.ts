import { Config, Context, Effect, Layer, Option, type Redacted, Schema } from "effect";

export class InputError extends Schema.TaggedError<InputError>()("InputError", {
  message: Schema.String,
}) {}

// the runner exposes every input as an INPUT_ environment variable, an empty one counts as missing.
const optional = <A>(name: string, config: (key: string) => Config.Config<A>) =>
  Effect.mapError(
    Config.option(config(`INPUT_${name.replace(/ /g, "_").toUpperCase()}`)),
    (error) => new InputError({ message: `the ${name} input is invalid, ${error.cause.message.split("\n")[0]}.` }),
  );

const required = <A>(name: string, config: (key: string) => Config.Config<A>) =>
  Effect.flatMap(
    optional(name, config),
    Option.match({
      onNone: () => Effect.fail(new InputError({ message: `the ${name} input is required.` })),
      onSome: Effect.succeed,
    }),
  );

const text = (key: string) => Config.String(key).pipe(Config.map((value) => value.trim()));

const lines = (key: string) =>
  text(key).pipe(Config.map((value) => value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)));

const repository = (key: string) =>
  Config.schema(Schema.String.check(Schema.isPattern(/^[^/\s]+\/[^/\s]+$/)), key);

export class Inputs extends Context.Service<Inputs, {
  readonly files: ReadonlyArray<string>;
  readonly tag: string;
  readonly title: string;
  readonly body: string;
  readonly draft: boolean;
  readonly prerelease: boolean;
  readonly overwrite: boolean;
  readonly failOnUnmatched: boolean;
  readonly token: Redacted.Redacted<string>;
  readonly serverUrl: string;
  readonly repository: string;
  // directory the files input is resolved from.
  readonly workspace: string;
}>()("upload-release-assets/Inputs") {
  static readonly layer = Layer.effect(
    Inputs,
    Effect.gen(function* () {
      const files = yield* required("files", lines);
      if (files.length === 0) return yield* new InputError({ message: "the files input is required." });
      const serverUrl = yield* required("server-url", Config.URL);
      return Inputs.of({
        files,
        tag: yield* required("tag", text),
        title: Option.getOrElse(yield* optional("title", text), () => ""),
        body: Option.getOrElse(yield* optional("body", text), () => ""),
        draft: Option.getOrElse(yield* optional("draft", Config.Boolean), () => false),
        prerelease: Option.getOrElse(yield* optional("prerelease", Config.Boolean), () => false),
        overwrite: Option.getOrElse(yield* optional("overwrite", Config.Boolean), () => true),
        failOnUnmatched: Option.getOrElse(yield* optional("fail-on-unmatched", Config.Boolean), () => true),
        token: yield* required("token", Config.Redacted),
        serverUrl: serverUrl.href.replace(/\/+$/, ""),
        repository: yield* required("repository", repository),
        workspace: yield* Config.String("FORGEJO_WORKSPACE").pipe(Config.withDefault(process.cwd())),
      });
    }),
  );
}
