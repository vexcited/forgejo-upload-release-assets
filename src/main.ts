import { NodeRuntime, NodePath, NodeFileSystem } from "@effect/platform-node";
import { Cause, Effect, Layer, Logger } from "effect";

import { run } from "./Action.ts";
import { Forgejo } from "./Forgejo.ts";
import { Inputs } from "./Inputs.ts";
import { logger, Outputs } from "./Runner.ts";

const MainLayer = Layer.mergeAll(Forgejo.layer, Outputs.layer).pipe(
  Layer.provideMerge(Inputs.layer),
  Layer.provideMerge(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)),
);

run.pipe(
  Effect.provide(MainLayer),
  Effect.tapError((error) => Effect.logError(error.message)),
  Effect.tapDefect((defect) => Effect.logError(Cause.pretty(Cause.die(defect)))),
  Effect.provide(Logger.layer([logger])),
  NodeRuntime.runMain({ disableErrorReporting: true }),
);
