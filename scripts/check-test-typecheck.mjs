import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));
const relative = (file) => path.relative(root, file).split(path.sep).join("/");
const identity = (file) => {
  const absolute = path.resolve(root, file);
  return ts.sys.useCaseSensitiveFileNames ? absolute : absolute.toLowerCase();
};
const read = (file) => readFileSync(path.join(root, file), "utf8");
const fail = (message) => assert.fail(message);

function parseConfig(file) {
  const filename = path.join(root, file);
  const config = ts.readConfigFile(filename, ts.sys.readFile);
  if (config.error)
    fail(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  if (parsed.errors.length)
    fail(
      ts.formatDiagnosticsWithColorAndContext(parsed.errors, diagnosticHost),
    );
  return parsed;
}

const diagnosticHost = {
  getCanonicalFileName: identity,
  getCurrentDirectory: () => root,
  getNewLine: () => "\n",
};

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) return walk(filename);
    return entry.isFile() && entry.name.endsWith(".ts") ? [filename] : [];
  });
}

function coverage(minimum = 1, extended) {
  const config = parseConfig("tsconfig.tests.json");
  const build = parseConfig("tsconfig.build.json");
  assert.equal(config.options.noEmit, true, "Test project must not emit");
  for (const [key, value] of Object.entries(build.options)) {
    if (key !== "noEmit" && key !== "types")
      assert.deepEqual(
        config.options[key],
        value,
        `Inherited option changed: ${key}`,
      );
  }
  assert.deepEqual(
    config.raw.exclude,
    [],
    "Inherited test exclusions must be reset",
  );
  const sources = walk(path.join(root, "src"));
  const runtime = sources.filter((file) => file.endsWith(".test.ts"));
  const support = sources.filter((file) =>
    relative(file).split("/").includes("__tests__"),
  );
  const inventory = new Set([...runtime, ...support].map(identity));
  assert(inventory.size > 0, "Test/support inventory is empty");
  assert(
    runtime.length >= minimum,
    `Only ${runtime.length} runtime tests; expected at least ${minimum}`,
  );
  const configured = new Set(config.fileNames.map(identity));
  const missing = [...inventory].filter((file) => !configured.has(file));
  assert.equal(
    missing.length,
    0,
    `Missing test/support sources: ${missing.map(relative).join(", ")}`,
  );
  assert.deepEqual(
    configured,
    new Set(sources.map(identity)),
    "Project must include every src TypeScript file",
  );
  if (extended)
    assert(
      inventory.has(identity(extended)),
      `Extended spec absent: ${extended}`,
    );
  console.log(
    `Coverage: ${runtime.length} runtime tests, ${support.length} __tests__ sources, ${inventory.size} unique test/support files, ${configured.size} total src files`,
  );
  return config;
}

function diagnostics(config) {
  const program = ts.createProgram(config.fileNames, config.options);
  const all = ts.getPreEmitDiagnostics(program);
  const files = new Set(
    all.flatMap((item) => (item.file ? [identity(item.file.fileName)] : [])),
  );
  console.log(
    `Global diagnostics: ${all.length} in ${files.size} files (${all.length ? "not clean" : "clean"})`,
  );
  return { all, files };
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: 120_000,
    shell: process.platform === "win32",
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
  });
  if (result.error) throw result.error;
  assert(result.status !== null, `${command} terminated by ${result.signal}`);
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

function ownedFiles(files) {
  assert(
    files.length > 0,
    "--files requires at least one explicit source file",
  );
  const normalized = files.map((file) => {
    assert(!/[*?\[\]{}]/.test(file), `Globs are not accepted: ${file}`);
    const name = relative(path.resolve(root, file));
    assert(
      name.startsWith("src/") && name.endsWith(".ts"),
      `Expected a src TypeScript file: ${file}`,
    );
    assert(statSync(path.join(root, name)).isFile(), `Not a file: ${file}`);
    assert.equal(
      run("git", ["ls-files", "--error-unmatch", "--", name]).status,
      0,
      `Not tracked: ${file}`,
    );
    return identity(name);
  });
  assert.equal(
    new Set(normalized).size,
    files.length,
    "Duplicate source paths are not accepted",
  );
  return new Set(normalized);
}

function integration() {
  const { scripts } = JSON.parse(read("package.json"));
  assert.equal(scripts["typecheck:tests"], "tsc -p tsconfig.tests.json");
  for (const [name, command] of Object.entries(scripts)) {
    if (name !== "typecheck:tests")
      assert(
        !/typecheck:tests|tsconfig\.tests\.json/.test(command),
        `Unexpected typecheck hook: ${name}`,
      );
  }
  const workflow = read(".github/workflows/tests.yml");
  const nodeJob = workflow.match(
    /^  test-node:\n([\s\S]*?)(?=^  [\w-]+:|$(?![\s\S]))/m,
  )?.[1];
  assert(nodeJob, "Missing test-node job");
  assert.match(nodeJob, /node-version: \[20\.x, 22\.x, 24\.x\]/);
  assert.match(nodeJob, /node-version: \$\{\{ matrix\.node-version \}\}/);
  assert.match(nodeJob, /- name: [^\n]+\n        run: pnpm typecheck:tests\n/);
  const install = nodeJob.indexOf("run: pnpm install --frozen-lockfile");
  const check = nodeJob.indexOf("run: pnpm typecheck:tests");
  assert(
    install >= 0 && check > install,
    "Node typecheck must follow frozen installation",
  );
  assert.equal(
    workflow.match(/run: pnpm typecheck:tests/g)?.length,
    1,
    "Typecheck belongs only in the Node matrix",
  );
  const guidance = read("CONTRIBUTING.md");
  for (const text of [
    "pnpm 10",
    "Node.js 20",
    "pnpm typecheck:tests",
    "src/**/*.ts",
    "watch",
  ])
    assert(guidance.includes(text), `Contributor guidance missing: ${text}`);
  assert(
    !/Husky|npm or yarn|TypeScript ~5\.8/.test(guidance),
    "Stale contributor setup guidance",
  );
  console.log(
    "Integration: exact explicit command, independent lifecycle, Node 20/22/24 after frozen install, contributor guidance checked",
  );
}

function negativeFixture(file) {
  const fixture = "src/__tests__/helpers/engine-seam-fixtures.ts";
  assert.equal(file, fixture, "Use the approved shared MLS fixture");
  ownedFiles([fixture]);
  const config = coverage();
  assert(
    config.fileNames.some((name) => identity(name) === identity(fixture)),
    "Fixture excluded",
  );
  integration();
  const diffArgs = ["diff", "HEAD", "--exit-code", "--", fixture];
  assert.equal(
    run("git", diffArgs).status,
    0,
    "Fixture must start with no diff",
  );
  const original = new Uint8Array(readFileSync(path.join(root, fixture)));
  const source = new TextDecoder().decode(original);
  const before = "    extraProposals,\n";
  assert.equal(
    source.split(before).length - 1,
    1,
    "Expected exactly one stable MLS fixture field",
  );
  const cleanBefore = run("pnpm", ["typecheck:tests"]);
  assert.equal(
    cleanBefore.status,
    0,
    `Full check must be clean before planting a regression:\n${cleanBefore.output}`,
  );
  let planted;
  try {
    writeFileSync(
      path.join(root, fixture),
      source.replace(
        before,
        '    extraProposals: "phase-17-negative-fixture",\n',
      ),
    );
    planted = run("pnpm", ["typecheck:tests"]);
  } finally {
    writeFileSync(path.join(root, fixture), original);
  }
  const restored = new Uint8Array(readFileSync(path.join(root, fixture)));
  assert.deepEqual(
    restored,
    original,
    "Fixture restoration must be byte-identical",
  );
  const cleanAfter = run("pnpm", ["typecheck:tests"]);
  assert.equal(
    cleanAfter.status,
    0,
    `Clean rerun failed:\n${cleanAfter.output}`,
  );
  assert.equal(run("git", diffArgs).status, 0, "Fixture has a post-run diff");
  assert.notEqual(
    planted.status,
    0,
    "Planted incorrectly typed MLS field must fail",
  );
  const attributed = stripVTControlCharacters(planted.output)
    .split("\n")
    .filter((line) => {
      const normalized = line.replaceAll("\\", "/").trim();
      return (
        (normalized.startsWith(`${fixture}(`) ||
          normalized.startsWith(`${fixture}:`)) &&
        /error TS\d+/.test(normalized)
      );
    });
  assert(
    attributed.length > 0,
    `No fixture-attributed diagnostic:\n${planted.output}`,
  );
  console.log(
    `Negative fixture: exact pnpm typecheck:tests failed (exit ${planted.status})\n${attributed.join("\n")}\nRestoration: identical bytes, clean rerun passed, no fixture diff`,
  );
}

try {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === "--coverage") {
    let minimum = 1;
    let extended;
    for (let i = 0; i < args.length; i += 2) {
      assert(args[i + 1], `Missing value for ${args[i]}`);
      if (args[i] === "--minimum-runtime-tests") {
        assert(
          /^\d+$/.test(args[i + 1]),
          "Minimum test count must be a positive integer",
        );
        minimum = Number(args[i + 1]);
        assert(minimum > 0, "Minimum test count must be positive");
      } else if (args[i] === "--require-extended") extended = args[i + 1];
      else fail(`Unknown coverage option: ${args[i]}`);
    }
    coverage(minimum, extended);
  } else if (mode === "--baseline") {
    assert(
      args.length === 0 || args.length === 2,
      "Usage: --baseline [diagnostics files]",
    );
    const { all, files } = diagnostics(coverage());
    if (args.length) {
      assert(
        args.every((arg) => /^\d+$/.test(arg)),
        "Baseline totals must be nonnegative integers",
      );
      assert.equal(all.length, Number(args[0]), "Diagnostic baseline changed");
      assert.equal(
        files.size,
        Number(args[1]),
        "Diagnostic file baseline changed",
      );
      console.log(
        "Expected baseline confirmed; this is inventory evidence, not a passing typecheck",
      );
    }
  } else if (mode === "--files") {
    const owned = ownedFiles(args);
    const { all } = diagnostics(coverage());
    const scoped = all.filter(
      (item) => !item.file || owned.has(identity(item.file.fileName)),
    );
    if (scoped.length)
      fail(ts.formatDiagnosticsWithColorAndContext(scoped, diagnosticHost));
    console.log(
      `Scoped check: ${owned.size} owned files have zero diagnostics; global remainder is reported above`,
    );
  } else if (mode === "--integration") {
    assert.equal(args.length, 0, "--integration takes no arguments");
    integration();
  } else if (mode === "--prove-negative-fixture") {
    assert.equal(
      args.length,
      1,
      "--prove-negative-fixture requires the shared fixture path",
    );
    negativeFixture(args[0]);
  } else
    fail(
      "Usage: --coverage | --baseline [diagnostics files] | --files <src files> | --integration | --prove-negative-fixture <shared fixture>",
    );
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
