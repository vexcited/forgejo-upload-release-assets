import { openAsBlob } from "node:fs";

import { Effect, Path, Schema } from "effect";

import { duplicateNames, resolveFiles } from "./Files.ts";
import { ensureRelease, Forgejo } from "./Forgejo.ts";
import { Inputs } from "./Inputs.ts";
import { Outputs } from "./Runner.ts";

export class ActionError extends Schema.TaggedError<ActionError>()("ActionError", {
  message: Schema.String,
}) {}

// a blob backed by the file streams it on upload instead of loading it in memory.
const openFile = (path: string) =>
  Effect.tryPromise({
    try: () => openAsBlob(path),
    catch: () => new ActionError({ message: `could not read ${path}.` }),
  });

export const run = Effect.gen(function* () {
  const inputs = yield* Inputs;
  const forgejo = yield* Forgejo;
  const outputs = yield* Outputs;
  const path = yield* Path.Path;

  const { files, unmatched } = yield* resolveFiles(inputs.files, inputs.workspace);
  if (unmatched.length > 0) {
    const message = `no files match ${unmatched.join(", ")}.`;
    if (inputs.failOnUnmatched) return yield* new ActionError({ message });
    yield* Effect.logWarning(message);
  }
  if (files.length === 0) return yield* new ActionError({ message: "there are no files to upload." });
  const duplicates = duplicateNames(files);
  if (duplicates.length > 0) {
    return yield* new ActionError({
      message: `several files share the name ${duplicates.join(", ")}, rename them first.`,
    });
  }

  const { release, created } = yield* ensureRelease(inputs);
  yield* Effect.log(created ? `created the ${inputs.tag} release.` : `found the ${inputs.tag} release.`);

  const existing = new Map(release.assets.map((asset) => [asset.name, asset]));
  if (!inputs.overwrite) {
    const taken = files.filter((file) => existing.has(file.name)).map((file) => file.name);
    if (taken.length > 0) {
      return yield* new ActionError({
        message: `the release already has ${taken.join(", ")}, set overwrite to true to replace them.`,
      });
    }
  }

  const uploaded: Array<{ readonly name: string; readonly url: string }> = [];
  for (const file of files) {
    const current = existing.get(file.name);
    if (current) {
      yield* forgejo.deleteAsset(release.id, current.id);
      yield* Effect.log(`removed the previous ${file.name}.`);
    }
    const asset = yield* forgejo.uploadAsset(release.id, file.name, yield* openFile(file.path));
    uploaded.push({ name: asset.name, url: asset.browser_download_url });
    yield* Effect.log(`uploaded ${path.relative(inputs.workspace, file.path)} as ${asset.name}.`);
  }

  yield* outputs.set("release-id", String(release.id));
  yield* outputs.set("release-url", release.html_url);
  yield* outputs.set("assets", JSON.stringify(uploaded));
});
