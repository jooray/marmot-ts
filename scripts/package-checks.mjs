import ts from "typescript";

// Only module-reference syntax participates; comments and ordinary literals do not.
export function moduleReferences(fileName, contents) {
  const source = ts.createSourceFile(
    fileName,
    contents,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith(".d.ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS,
  );
  const references = [];
  function visit(node) {
    let literal;
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      literal = node.moduleSpecifier;
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      literal = node.arguments[0];
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument)
    ) {
      literal = node.argument.literal;
    }
    if (literal && ts.isStringLiteralLike(literal)) {
      const start = literal.getStart(source);
      const { line, character } = source.getLineAndCharacterOfPosition(start);
      references.push({
        specifier: literal.text,
        start,
        end: literal.getEnd(),
        line: line + 1,
        column: character + 1,
      });
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return references.sort((a, b) => a.start - b.start);
}

export function packageRoot(specifier) {
  if (specifier.startsWith(".")) return null;
  return specifier
    .split("/")
    .slice(0, specifier.startsWith("@") ? 2 : 1)
    .join("/");
}

export function isForkSpecifier(specifier, forkName = "ts-mls") {
  return specifier === forkName || specifier.startsWith(`${forkName}/`);
}

// npm documents arrays and booleans for both bundle field spellings. Objects
// are also inspected defensively so malformed manifests cannot conceal a key.
export function manifestPackageReferences(manifest, packageName) {
  const dependencyFields = [
    "dependencies",
    "peerDependencies",
    "optionalDependencies",
  ];
  const bundleFields = ["bundleDependencies", "bundledDependencies"];
  function hasKey(section) {
    return (
      section !== null &&
      typeof section === "object" &&
      Object.hasOwn(section, packageName)
    );
  }
  const dependencyHits = dependencyFields.filter((field) =>
    hasKey(manifest[field]),
  );
  const bundleHits = bundleFields.filter((field) => {
    const section = manifest[field];
    if (Array.isArray(section)) return section.includes(packageName);
    if (section === true) return dependencyHits.length > 0;
    return hasKey(section);
  });
  return [...dependencyHits, ...bundleHits];
}

// Replace literal spans from right to left to retain formatting and source offsets.
export function rewriteModuleReferences(fileName, contents, rewrite) {
  let result = contents;
  for (const reference of moduleReferences(fileName, contents).reverse()) {
    const replacement = rewrite(reference.specifier);
    if (replacement !== undefined && replacement !== reference.specifier) {
      result =
        result.slice(0, reference.start) +
        JSON.stringify(replacement) +
        result.slice(reference.end);
    }
  }
  return result;
}
