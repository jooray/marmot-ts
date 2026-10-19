import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Comment, CommentTag, Converter, ReflectionKind } from "typedoc";

const root = fileURLToPath(new URL("../", import.meta.url));
const pkg = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
const entrypointLabels = new Map(
  Object.entries(pkg.exports).flatMap(([subpath, target]) => {
    if (typeof target !== "object" || !target.types?.startsWith("./dist/"))
      return [];
    const source = target.types
      .replace(/^\.\/dist\//, "src/")
      .replace(/\.d\.ts$/, ".ts");
    return [
      [
        path.resolve(root, source),
        subpath === "." ? pkg.name : `${pkg.name}${subpath.slice(1)}`,
      ],
    ];
  }),
);

const fileCategoryCache = new Map();

function categoryForFile(file) {
  if (fileCategoryCache.has(file)) return fileCategoryCache.get(file);

  let category = null;
  try {
    const src = readFileSync(file, "utf8");
    const firstBlock = src.match(/\/\*\*([\s\S]*?)\*\//);
    if (firstBlock && /@module\b/.test(firstBlock[1])) {
      const m = firstBlock[1].match(/@category\s+([^\r\n*]+)/);
      if (m) category = m[1].trim();
    }
  } catch {
    // unreadable source — leave uncategorized
  }

  fileCategoryCache.set(file, category);
  return category;
}

export function load(app) {
  app.converter.on(Converter.EVENT_RESOLVE_BEGIN, (context) => {
    for (const reflection of Object.values(context.project.reflections)) {
      const file = reflection.sources?.[0]?.fullFileName;
      if (!file) continue;
      // Display the declared package import path, while retaining the same
      // reflection IDs, references, sources, and inherited categories.
      if (reflection.kindOf(ReflectionKind.Module)) {
        const label = entrypointLabels.get(path.resolve(file));
        if (label) reflection.name = label;
      }
      if (reflection.comment?.getTag("@category")) continue;

      const category = categoryForFile(file);
      if (!category) continue;

      reflection.comment ??= new Comment();
      reflection.comment.blockTags.push(
        new CommentTag("@category", [{ kind: "text", text: category }]),
      );
    }
  });
}
