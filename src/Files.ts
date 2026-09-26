import { Effect, FileSystem, Path } from "effect";

export interface File {
  readonly path: string;
  readonly name: string;
}

const wildcard = /[*?]/;

// turns a glob into a regular expression over slash separated relative paths.
// `*` and `?` stay inside one segment, `**` spans any number of segments, and
// wildcards never match names starting with a dot unless the pattern does.
export const globToRegExp = (pattern: string): RegExp => {
  const segments = pattern.split("/");
  const source = segments
    .map((segment, index) => {
      const last = index === segments.length - 1;
      if (segment === "**") {
        return last ? "(?:(?!\\.)[^/]+/)*(?!\\.)[^/]+" : "(?:(?!\\.)[^/]+/)*";
      }
      let part = segment.startsWith(".") ? "" : "(?!\\.)";
      for (const character of segment) {
        if (character === "*") part += "[^/]*";
        else if (character === "?") part += "[^/]";
        else part += character.replace(/[.+^${}()|[\]\\]/g, "\\$&");
      }
      return last ? part : `${part}/`;
    })
    .join("");
  return new RegExp(`^${source}$`);
};

// resolves each line to files. a line is a file, a directory whose direct files
// are all taken, or a glob pattern. files matched by several lines appear once.
export const resolveFiles = Effect.fn("resolveFiles")(function* (patterns: ReadonlyArray<string>, cwd: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  // follows symbolic links, anything unreadable counts as missing.
  const typeOf = (fullPath: string) =>
    fs.stat(fullPath).pipe(
      Effect.map((info) => info.type),
      Effect.orElseSucceed(() => "Unknown" as const),
    );

  const list = (directory: string) => fs.readDirectory(directory).pipe(Effect.orElseSucceed(() => []));

  const filesIn = Effect.fnUntraced(function* (directory: string) {
    const files: Array<string> = [];
    for (const name of yield* list(directory)) {
      const fullPath = path.join(directory, name);
      if (!name.startsWith(".") && (yield* typeOf(fullPath)) === "File") files.push(fullPath);
    }
    return files;
  });

  // a directory reached twice through symbolic links is walked once, so cycles cannot happen.
  const walk: (
    directory: string,
    relative: string,
    depth: number,
    visited: Set<string>,
  ) => Effect.Effect<Array<readonly [string, string]>> = Effect.fnUntraced(function* (directory, relative, depth, visited) {
    const real = yield* fs.realPath(directory).pipe(Effect.orElseSucceed(() => directory));
    if (visited.has(real)) return [];
    visited.add(real);

    const found: Array<readonly [string, string]> = [];
    for (const name of yield* list(directory)) {
      const fullPath = path.join(directory, name);
      const relativePath = relative ? `${relative}/${name}` : name;
      const type = yield* typeOf(fullPath);
      if (type === "Directory" && depth > 1) found.push(...(yield* walk(fullPath, relativePath, depth - 1, visited)));
      else if (type === "File") found.push([fullPath, relativePath]);
    }
    return found;
  });

  const expand = Effect.fnUntraced(function* (pattern: string) {
    if (!wildcard.test(pattern)) {
      const fullPath = path.resolve(cwd, pattern);
      const type = yield* typeOf(fullPath);
      if (type === "File") return [fullPath];
      if (type === "Directory") return yield* filesIn(fullPath);
      return [];
    }

    const segments = pattern.split("/");
    const firstWildcard = segments.findIndex((segment) => wildcard.test(segment));
    const base = path.resolve(cwd, segments.slice(0, firstWildcard).join("/") || ".");
    const rest = segments.slice(firstWildcard);
    const matcher = globToRegExp(rest.join("/"));
    const depth = rest.includes("**") ? Infinity : rest.length;

    const found = yield* walk(base, "", depth, new Set());
    return found.filter(([, relativePath]) => matcher.test(relativePath)).map(([fullPath]) => fullPath);
  });

  const files = new Set<string>();
  const unmatched: Array<string> = [];
  for (const pattern of patterns) {
    const matches = yield* expand(pattern);
    if (matches.length === 0) unmatched.push(pattern);
    for (const match of matches) files.add(match);
  }

  return {
    files: [...files].sort().map((fullPath): File => ({ path: fullPath, name: path.basename(fullPath) })),
    unmatched,
  };
});

// release assets are addressed by name, so two files cannot share a base name.
export const duplicateNames = (files: ReadonlyArray<File>): Array<string> => {
  const seen = new Map<string, number>();
  for (const file of files) seen.set(file.name, (seen.get(file.name) ?? 0) + 1);
  return [...seen].filter(([, count]) => count > 1).map(([name]) => name);
};
