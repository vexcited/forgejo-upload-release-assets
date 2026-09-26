import { Context, Effect, flow, Layer, Option, Redacted, Schema } from "effect";
import { FetchHttpClient, HttpClient, type HttpBody, type HttpClientError, HttpClientRequest } from "effect/unstable/http";

import { Inputs } from "./Inputs.ts";

export const Asset = Schema.Struct({
  id: Schema.Int,
  name: Schema.String,
  browser_download_url: Schema.String,
});
export type Asset = typeof Asset.Type;

export const Release = Schema.Struct({
  id: Schema.Int,
  tag_name: Schema.String,
  html_url: Schema.String,
  assets: Schema.Array(Asset),
});
export type Release = typeof Release.Type;

export interface CreateRelease {
  readonly tag: string;
  readonly title: string;
  readonly body: string;
  readonly draft: boolean;
  readonly prerelease: boolean;
}

export class ForgejoError extends Schema.TaggedError<ForgejoError>()("ForgejoError", {
  method: Schema.String,
  route: Schema.String,
  status: Schema.Int,
  detail: Schema.String,
}) {
  override get message() {
    return `${this.method} ${this.route} failed with http ${this.status}${this.detail ? `: ${this.detail}` : "."}`;
  }
}

export type ForgejoFailure = ForgejoError | HttpClientError.HttpClientError | HttpBody.HttpBodyError | Schema.SchemaError;

const ApiMessage = Schema.fromJsonString(Schema.Struct({ message: Schema.String }));

// keeps the api message when the body carries one, and the raw body otherwise.
const describe = (text: string) =>
  Schema.decodeUnknownOption(ApiMessage)(text).pipe(
    Option.map((body) => body.message),
    Option.getOrElse(() => text.trim()),
  ).slice(0, 500);

// a minimal client for the release endpoints of the forgejo api.
export class Forgejo extends Context.Service<Forgejo, {
  getReleaseByTag(tag: string): Effect.Effect<Option.Option<Release>, ForgejoFailure>;
  findRelease(tag: string): Effect.Effect<Option.Option<Release>, ForgejoFailure>;
  createRelease(options: CreateRelease): Effect.Effect<Release, ForgejoFailure>;
  deleteAsset(releaseId: number, assetId: number): Effect.Effect<void, ForgejoFailure>;
  uploadAsset(releaseId: number, name: string, file: Blob): Effect.Effect<Asset, ForgejoFailure>;
}>()("upload-release-assets/Forgejo") {
  static readonly layerNoDeps = Layer.effect(
    Forgejo,
    Effect.gen(function* () {
      const inputs = yield* Inputs;
      const client = (yield* HttpClient.HttpClient).pipe(
        HttpClient.mapRequest(flow(
          HttpClientRequest.prependUrl(`${inputs.serverUrl}/api/v1/repos/${inputs.repository}`),
          HttpClientRequest.acceptJson,
          HttpClientRequest.setHeader("Authorization", `token ${Redacted.value(inputs.token)}`),
        )),
      );

      const send = Effect.fnUntraced(function* (request: HttpClientRequest.HttpClientRequest, expected: number) {
        const response = yield* client.execute(request);
        if (response.status === expected) return response;
        return yield* new ForgejoError({
          method: request.method,
          route: request.url,
          status: response.status,
          detail: describe(yield* response.text),
        });
      });

      const json = <S extends Schema.Top>(schema: S) =>
        Effect.fnUntraced(function* (request: HttpClientRequest.HttpClientRequest, expected: number) {
          const response = yield* send(request, expected);
          return yield* Schema.decodeUnknownEffect(schema)(yield* response.json);
        });

      const release = json(Release);

      const getReleaseByTag = Effect.fn("Forgejo.getReleaseByTag")(function* (tag: string) {
        return yield* release(HttpClientRequest.get(`/releases/tags/${encodeURIComponent(tag)}`), 200).pipe(
          Effect.map(Option.some),
          Effect.catchTag("ForgejoError", (error) => (error.status === 404 ? Effect.succeedNone : Effect.fail(error))),
        );
      });

      // looks through every release, which also finds drafts the tag lookup does not return.
      const findRelease = Effect.fn("Forgejo.findRelease")(function* (tag: string) {
        for (let page = 1; ; page += 1) {
          const releases = yield* json(Schema.Array(Release))(
            HttpClientRequest.get("/releases", { urlParams: { page, limit: 50 } }),
            200,
          );
          if (releases.length === 0) return Option.none<Release>();
          const found = releases.find((candidate) => candidate.tag_name === tag);
          if (found) return Option.some(found);
        }
      });

      const createRelease = Effect.fn("Forgejo.createRelease")(function* (options: CreateRelease) {
        const request = yield* HttpClientRequest.bodyJson(HttpClientRequest.post("/releases"), {
          tag_name: options.tag,
          name: options.title || options.tag,
          body: options.body,
          draft: options.draft,
          prerelease: options.prerelease,
        });
        return yield* release(request, 201);
      });

      const deleteAsset = Effect.fn("Forgejo.deleteAsset")(function* (releaseId: number, assetId: number) {
        yield* send(HttpClientRequest.delete(`/releases/${releaseId}/assets/${assetId}`), 204);
      });

      const uploadAsset = Effect.fn("Forgejo.uploadAsset")(function* (releaseId: number, name: string, file: Blob) {
        const form = new FormData();
        form.append("attachment", file, name);
        return yield* json(Asset)(
          HttpClientRequest.post(`/releases/${releaseId}/assets`, { urlParams: { name } }).pipe(
            HttpClientRequest.bodyFormData(form),
          ),
          201,
        );
      });

      return Forgejo.of({ getReleaseByTag, findRelease, createRelease, deleteAsset, uploadAsset });
    }),
  );

  static readonly layer = this.layerNoDeps.pipe(Layer.provide(FetchHttpClient.layer));
}

// returns the release of a tag, creating it when it does not exist yet.
export const ensureRelease = Effect.fn("ensureRelease")(function* (options: CreateRelease) {
  const forgejo = yield* Forgejo;

  let existing = yield* forgejo.getReleaseByTag(options.tag);
  if (Option.isNone(existing)) existing = yield* forgejo.findRelease(options.tag);
  if (Option.isSome(existing)) return { release: existing.value, created: false };

  return yield* forgejo.createRelease(options).pipe(
    Effect.map((release) => ({ release, created: true })),
    // another job may have created the same release in the meantime.
    Effect.catchTag("ForgejoError", (error) =>
      error.status === 409 || error.status === 422
        ? forgejo.findRelease(options.tag).pipe(
          Effect.flatMap(Option.match({
            onNone: () => Effect.fail(error),
            onSome: (release) => Effect.succeed({ release, created: false }),
          })),
        )
        : Effect.fail(error)),
  );
});
