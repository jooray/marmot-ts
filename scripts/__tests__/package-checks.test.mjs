import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { isForkSpecifier, moduleReferences } from "../package-checks.mjs";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const originals = [
  "package.json",
  "ts-mls/package.json",
  "scripts/vendor-ts-mls.mjs",
  "scripts/verify-package-tarball.mjs",
  "scripts/package-checks.mjs",
  "src/mls.ts",
  "ts-mls/src/index.ts",
  "dist/mls.js",
  "dist/mls.d.ts",
];

function write(root, name, contents) {
  const target = path.join(root, name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
}

function withFixture(run) {
  const before = originals.map((name) => {
    const target = path.join(repoRoot, name);
    return [name, fs.existsSync(target) ? fs.readFileSync(target) : null];
  });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "package-checks-test-"));
  try {
    for (const [name, bytes] of before) {
      if (bytes !== null) write(root, name, bytes);
    }
    fs.mkdirSync(path.join(root, "node_modules"), { recursive: true });
    fs.symlinkSync(
      fs.realpathSync(path.join(repoRoot, "node_modules/typescript")),
      path.join(root, "node_modules/typescript"),
      "dir",
    );
    const manifest = JSON.parse(
      fs.readFileSync(path.join(root, "package.json")),
    );
    manifest.dependencies["declared-package"] = "1.0.0";
    manifest.peerDependencies["@scope/declared-peer"] = "1.0.0";
    write(root, "package.json", JSON.stringify(manifest));
    write(
      root,
      "ts-mls/package.json",
      JSON.stringify({ name: "ts-mls", version: "1.0.0", private: true }),
    );
    write(root, "ts-mls/LICENSE", "fixture license\n");
    write(root, "ts-mls/src/index.ts", "export {};\n");
    write(root, "ts-mls/dist/src/index.js", "export {};\n");
    write(root, "ts-mls/dist/src/index.d.ts", "export {};\n");
    write(root, "dist/mls.js", 'export * from "ts-mls";\n');
    write(root, "dist/mls.d.ts", 'export * from "ts-mls";\n');
    run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    for (const [name, bytes] of before) {
      const target = path.join(repoRoot, name);
      assert.deepEqual(
        fs.existsSync(target) ? fs.readFileSync(target) : null,
        bytes,
        `original bytes changed: ${name}`,
      );
    }
  }
}

function vendor(root) {
  const result = spawnSync(process.execPath, ["scripts/vendor-ts-mls.mjs"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(result.error, undefined);
  return { ...result, output: result.stdout + result.stderr };
}

function assertClean(result) {
  assert.equal(result.status, 0, result.output);
}

function assertPoison(result, guard, file, specifier, packageRoot) {
  assert.equal(
    result.status,
    1,
    `expected ${guard} to reject ${specifier}: ${result.output}`,
  );
  assert.ok(result.output.includes(`${guard} failed`), result.output);
  assert.ok(result.output.includes(file), result.output);
  assert.ok(result.output.includes(`"${specifier}"`), result.output);
  if (packageRoot)
    assert.ok(
      result.output.includes(`package "${packageRoot}"`),
      result.output,
    );
}

function verifyTarball(root, manifest, mutatePacked = () => {}) {
  write(root, "packed/package/package.json", JSON.stringify(manifest));
  for (const name of [
    "index.js",
    "mls.d.ts",
    "vendor/ts-mls/index.js",
    "vendor/ts-mls/index.d.ts",
    "vendor/ts-mls/LICENSE",
    "vendor/ts-mls/VERSION",
  ])
    write(root, `packed/package/dist/${name}`, "export {};\n");
  write(
    root,
    "packed/package/dist/mls.js",
    'export * from "./vendor/ts-mls/index.js";\n',
  );
  const tarball = path.join(root, "fixture.tgz");
  mutatePacked(root);
  const packed = spawnSync(
    "tar",
    ["-czf", tarball, "-C", path.join(root, "packed"), "package"],
    { encoding: "utf8" },
  );
  assert.equal(packed.status, 0, packed.stderr);
  const result = spawnSync(
    process.execPath,
    [
      "scripts/verify-package-tarball.mjs",
      "--tarball",
      tarball,
      "--check-fork-unpublished",
    ],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(result.error, undefined);
  return { ...result, output: result.stdout + result.stderr };
}

test("packed manifest guard: bundle array poison is attributed", () => {
  withFixture((root) => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(root, "package.json")),
    );
    manifest.bundleDependencies = ["declared-package"];
    assertClean(verifyTarball(root, manifest));
    manifest.bundleDependencies = ["ts-mls"];
    const result = verifyTarball(root, manifest);
    assert.equal(
      result.status,
      1,
      `expected bundle array rejection: ${result.output}`,
    );
    assert.ok(
      result.output.includes(
        'packed manifest still lists "ts-mls" under bundleDependencies',
      ),
      result.output,
    );
  });
});

test("source import guard: inline side-effect poison reaches Guard B", () => {
  withFixture((root) => {
    write(
      root,
      "ts-mls/dist/src/index.js",
      'export {}; import "declared-package";\n',
    );
    assertClean(vendor(root));
    write(
      root,
      "ts-mls/dist/src/index.js",
      'export {}; import "missing-fixture-dep";\n',
    );
    assertPoison(
      vendor(root),
      "Guard B",
      "dist/vendor/ts-mls/index.js",
      "missing-fixture-dep",
      "missing-fixture-dep",
    );
  });
});

test("source import guard: declaration import type poison reaches Guard B", () => {
  withFixture((root) => {
    write(
      root,
      "ts-mls/dist/src/index.d.ts",
      'export type T = import("declared-package").T;\n',
    );
    assertClean(vendor(root));
    write(
      root,
      "ts-mls/dist/src/index.d.ts",
      'export type T = import("missing").T;\n',
    );
    assertPoison(
      vendor(root),
      "Guard B",
      "dist/vendor/ts-mls/index.d.ts",
      "missing",
      "missing",
    );
  });
});

const importForms = [
  ["default", (name) => `import value from "${name}";`],
  ["named", (name) => `import { value } from '${name}';`],
  ["namespace", (name) => `import * as value from "${name}";`],
  ["export named", (name) => `export { value } from "${name}";`],
  ["export star", (name) => `export * from '${name}';`],
  ["export namespace", (name) => `export * as values from "${name}";`],
  ["side effect", (name) => `import "${name}";`],
  ["inline side effect", (name) => `export {}; import "${name}";`],
  [
    "dynamic",
    (name) => `export const value = import /* comment */ ( '${name}' );`,
  ],
  ["dynamic template", (name) => `export const value = import(\`${name}\`);`],
];
const declarationForms = [
  [
    "import type",
    (name) => `export type T = import /* comment */ ("${name}").T;`,
  ],
  ["typeof import type", (name) => `export type T = typeof import('${name}');`],
];

for (const extension of [".js", ".d.ts"]) {
  const forms =
    extension === ".js"
      ? importForms
      : [
          ...importForms.filter(([name]) => !name.startsWith("dynamic")),
          ...declarationForms,
        ];
  for (const [name, source] of forms) {
    test(`source import guard: ${name} ${extension} clean, poison, rewrite and leftover`, () => {
      withFixture((root) => {
        const vendorInput = `ts-mls/dist/src/index${extension}`;
        const vendorOutput = `dist/vendor/ts-mls/index${extension}`;
        write(
          root,
          vendorInput,
          `${source("declared-package/subpath")}\n${source("@scope/declared-peer/subpath")}\n${source("./relative.js")}\n`,
        );
        assertClean(vendor(root));
        write(root, vendorInput, source("@missing/package/subpath"));
        assertPoison(
          vendor(root),
          "Guard B",
          vendorOutput,
          "@missing/package/subpath",
          "@missing/package",
        );

        write(root, vendorInput, "export {};\n");
        const outer = `dist/nested/entry${extension}`;
        write(root, outer, source("ts-mls"));
        assertClean(vendor(root));
        const rewritten = fs.readFileSync(path.join(root, outer), "utf8");
        assert.deepEqual(
          moduleReferences(outer, rewritten).map((ref) => ref.specifier),
          ["../vendor/ts-mls/index.js"],
        );
        assert.equal(
          moduleReferences(outer, rewritten).some((ref) =>
            isForkSpecifier(ref.specifier),
          ),
          false,
        );
        write(root, outer, source("ts-mls/subpath"));
        assertPoison(vendor(root), "Guard A", outer, "ts-mls/subpath");
      });
    });
  }
}

test("source import guard: inert strings, comments and nonliteral imports stay intact", () => {
  withFixture((root) => {
    const contents = [
      '// import "missing"; export * from "ts-mls/subpath";',
      '/* import("missing") */',
      'export const inert = "ts-mls";',
      `export const text = 'import("missing")';`,
      'const name = "missing"; import(name);',
      "import(`missing/${name}`);",
    ].join("\n");
    write(root, "ts-mls/dist/src/index.js", contents);
    write(root, "dist/outer.js", contents);
    write(
      root,
      "dist/outer.d.ts",
      '// import("missing").T\nexport type T = "ts-mls";\n',
    );
    assertClean(vendor(root));
    assert.equal(
      fs.readFileSync(path.join(root, "dist/outer.js"), "utf8"),
      contents,
    );
  });
});

for (const [name, allowed, forbidden] of [
  [
    "ordinary prefix",
    "declared-package/subpath",
    "declared-package-extra/subpath",
  ],
  ["scope exactness", "@scope/declared-peer/subpath", "@scope/other/subpath"],
  ["dev dependency excluded", "declared-package", "typescript"],
  ["optional dependency excluded", "declared-package", "optional-only"],
]) {
  test(`source import guard: ${name}`, () => {
    withFixture((root) => {
      const manifest = JSON.parse(
        fs.readFileSync(path.join(root, "package.json")),
      );
      manifest.optionalDependencies = { "optional-only": "1.0.0" };
      write(root, "package.json", JSON.stringify(manifest));
      write(root, "ts-mls/dist/src/index.js", `import "${allowed}";`);
      assertClean(vendor(root));
      write(root, "ts-mls/dist/src/index.js", `import "${forbidden}";`);
      assertPoison(
        vendor(root),
        "Guard B",
        "dist/vendor/ts-mls/index.js",
        forbidden,
        forbidden
          .split("/")
          .slice(0, forbidden.startsWith("@") ? 2 : 1)
          .join("/"),
      );
    });
  });
}

test("source import guard: multiple spaced and escaped literals rewrite without touching text", () => {
  withFixture((root) => {
    const source = `// from "ts-mls"\nimport /* gap */ value from "ts\\u002dmls"; import /* gap */ 'ts-mls';\nexport * /* gap */ from 'ts-mls';\nconst inert = "ts-mls";\n`;
    write(root, "dist/multiple.js", source);
    assertClean(vendor(root));
    const staged = fs.readFileSync(path.join(root, "dist/multiple.js"), "utf8");
    assert.deepEqual(
      moduleReferences("multiple.js", staged).map((ref) => ref.specifier),
      Array(3).fill("./vendor/ts-mls/index.js"),
    );
    assert.ok(staged.includes('// from "ts-mls"'));
    assert.ok(staged.includes('const inert = "ts-mls";'));
    assert.ok(staged.includes("/* gap */"));
  });
});

test("source import guard: AST source positions and bare fork classification", () => {
  const source =
    '// import "missing";\nexport type T = import /* gap */ ("ts-mls").T;';
  const [reference] = moduleReferences("positions.d.ts", source);
  assert.equal(reference.specifier, "ts-mls");
  assert.equal(reference.line, 2);
  assert.equal(reference.column, source.split("\n")[1].indexOf('"ts-mls"') + 1);
  assert.equal(source.slice(reference.start, reference.end), '"ts-mls"');
  assert.equal(isForkSpecifier(reference.specifier), true);
  assert.equal(isForkSpecifier("ts-mls/subpath"), true);
  assert.equal(isForkSpecifier("ts-mls-extra"), false);
});

for (const [name, mutate, message] of [
  [
    "pinned HPKE",
    (pkg) => {
      pkg.dependencies["@hpke/core"] = "9.0.0";
    },
    'expected dependencies["@hpke/core"] === "1.9.0"',
  ],
  [
    "peer version",
    (pkg) => {
      pkg.peerDependencies["@hpke/ml-kem"] = "9.0.0";
    },
    'expected peerDependencies["@hpke/ml-kem"] === "0.3.0"',
  ],
  [
    "optional peer metadata",
    (pkg) => {
      pkg.peerDependenciesMeta["@hpke/ml-kem"].optional = false;
    },
    'expected peerDependenciesMeta["@hpke/ml-kem"].optional === true',
  ],
]) {
  test(`packed manifest guard: preserves ${name} restriction`, () => {
    withFixture((root) => {
      const manifest = JSON.parse(
        fs.readFileSync(path.join(root, "package.json")),
      );
      assertClean(verifyTarball(root, manifest));
      mutate(manifest);
      const result = verifyTarball(root, manifest);
      assert.equal(result.status, 1, result.output);
      assert.ok(result.output.includes(message), result.output);
      assert.equal(result.output.match(/  - /g)?.length, 1, result.output);
    });
  });
}

for (const [name, mutate, message] of [
  [
    "vendor maps",
    (root) =>
      write(root, "packed/package/dist/vendor/ts-mls/index.js.map", "{}"),
    "forbidden .map file shipped",
  ],
  [
    "wrong vendor copy root",
    (root) =>
      write(
        root,
        "packed/package/dist/vendor/ts-mls/src/extra.js",
        "export {};",
      ),
    "forbidden path under dist/vendor/ts-mls",
  ],
  [
    "required entry",
    (root) =>
      fs.unlinkSync(
        path.join(root, "packed/package/dist/vendor/ts-mls/LICENSE"),
      ),
    "missing required tarball entry: package/dist/vendor/ts-mls/LICENSE",
  ],
  [
    "vendor entrypoint",
    (root) =>
      write(root, "packed/package/dist/mls.js", 'export * from "ts-mls";'),
    "packed dist/mls.js does not reference ./vendor/ts-mls/index.js",
  ],
]) {
  test(`packed manifest guard: preserves ${name} restriction`, () => {
    withFixture((root) => {
      const manifest = JSON.parse(
        fs.readFileSync(path.join(root, "package.json")),
      );
      assertClean(verifyTarball(root, manifest));
      const result = verifyTarball(root, manifest, mutate);
      assert.equal(result.status, 1, result.output);
      assert.ok(result.output.includes(message), result.output);
      const failures = result.output
        .split("\n")
        .filter((line) => line.startsWith("  - "));
      assert.ok(failures.length > 0);
      assert.ok(
        failures.every((failure) => failure.includes(message)),
        result.output,
      );
    });
  });
}

for (const field of ["bundleDependencies", "bundledDependencies"]) {
  for (const [shape, clean, poison] of [
    ["array", ["declared-package"], ["declared-package", "ts-mls"]],
    ["empty array", [], ["ts-mls"]],
    ["false", false, ["ts-mls"]],
    ["true", true, ["ts-mls"]],
    ["object robustness", { "declared-package": "1.0.0" }, { "ts-mls": false }],
    ["null robustness", null, { "ts-mls": null }],
  ]) {
    test(`packed manifest guard: ${field} ${shape}`, () => {
      withFixture((root) => {
        const manifest = JSON.parse(
          fs.readFileSync(path.join(root, "package.json")),
        );
        manifest[field] = clean;
        assertClean(verifyTarball(root, manifest));
        manifest[field] = poison;
        const result = verifyTarball(root, manifest);
        assert.equal(result.status, 1, result.output);
        assert.ok(
          result.output.includes(
            `packed manifest still lists "ts-mls" under ${field}`,
          ),
          result.output,
        );
        assert.equal(result.output.match(/  - /g)?.length, 1, result.output);
      });
    });
  }
  for (const dependencyField of [
    "dependencies",
    "peerDependencies",
    "optionalDependencies",
  ]) {
    for (const bundleValue of [true, false]) {
      test(`packed manifest guard: ${field} ${bundleValue} with ${dependencyField}`, () => {
        withFixture((root) => {
          const manifest = JSON.parse(
            fs.readFileSync(path.join(root, "package.json")),
          );
          manifest[field] = bundleValue;
          manifest[dependencyField] = {
            ...manifest[dependencyField],
            "declared-package": "1.0.0",
          };
          assertClean(verifyTarball(root, manifest));
          manifest[dependencyField]["ts-mls"] = "1.0.0";
          const result = verifyTarball(root, manifest);
          assert.equal(result.status, 1, result.output);
          assert.ok(
            result.output.includes(
              `packed manifest still lists "ts-mls" under ${dependencyField}`,
            ),
            result.output,
          );
          assert.equal(
            result.output.includes(
              `packed manifest still lists "ts-mls" under ${field}`,
            ),
            bundleValue,
            result.output,
          );
        });
      });
    }
  }
}

for (const field of [
  "dependencies",
  "peerDependencies",
  "optionalDependencies",
]) {
  test(`packed manifest guard: standalone ${field}`, () => {
    withFixture((root) => {
      const manifest = JSON.parse(
        fs.readFileSync(path.join(root, "package.json")),
      );
      manifest[field] = { ...manifest[field], "declared-package": "1.0.0" };
      assertClean(verifyTarball(root, manifest));
      manifest[field]["ts-mls"] = "1.0.0";
      const result = verifyTarball(root, manifest);
      assert.equal(result.status, 1, result.output);
      assert.ok(
        result.output.includes(
          `packed manifest still lists "ts-mls" under ${field}`,
        ),
        result.output,
      );
      assert.equal(result.output.match(/  - /g)?.length, 1, result.output);
    });
  });
}
