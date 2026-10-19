#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url)).replace(/\/$/, "");
const phaseName = "18-package-checks-and-historical-debt-disposition";
const phase = locatePhase(root);
const resultsPath = `${phase}/18-QA-RESULTS.json`;
const logPath = `${phase}/18-QA-LOG.txt`;
const reportPath = `${phase}/18-VERIFICATION.md`;
const pnpmBin = "/home/robert/.local/share/pnpm/.tools/pnpm/10.32.1/bin";
const executionEnv = {
  PATH: fs.existsSync(pnpmBin)
    ? `${pnpmBin}:${process.env.PATH}`
    : process.env.PATH,
  FORCE_COLOR: "0",
  NO_COLOR: "1",
};
const excludedMetadata = [
  "All planning files except WINDOWS.md, RELEASE-FOLLOWUPS.md and the finding ledger",
  "PLAN, SUMMARY, REVIEW, STATE/state.json, ROADMAP, REQUIREMENTS, PROJECT and research",
  "18-QA-RESULTS.json, 18-QA-LOG.txt and 18-VERIFICATION.md",
  "HEAD/commit identity (descriptive only), generated build/docs output and untracked files",
];
const gate = (id, argv, env = {}) => ({ id, argv, env });
const gates = [
  gate("typecheck", ["pnpm", "typecheck:tests"]),
  gate("build", ["pnpm", "build"]),
  gate("package-invariants", ["pnpm", "test:package-invariants"]),
  gate("portable-ledger", ["pnpm", "test:windows-ledger:portable"]),
  gate("runtime", ["pnpm", "vitest", "run"]),
  gate("extended", ["pnpm", "conformance:extended"]),
  gate("owner-ledger", ["pnpm", "test:windows-ledger:owner"]),
  gate("lint", ["pnpm", "lint"]),
  gate("docs", ["pnpm", "docs:build"]),
  gate("packed-consumers", ["bash", "scripts/package-smoke/run.sh"], {
    PACKAGE_SMOKE_REQUIRE_BUN: "1",
    PACKAGE_SMOKE_REQUIRE_DENO: "1",
  }),
  gate("diff", ["git", "diff", "--check"]),
];
const versionCommands = [
  gate("Node", ["node", "--version"]),
  gate("npm", ["npm", "--version"]),
  gate("pnpm", ["pnpm", "--version"]),
  gate("Bun", ["bun", "--version"]),
  gate("Deno", ["deno", "--version"]),
  gate("TypeScript", ["pnpm", "exec", "tsc", "--version"]),
  gate("Vitest", ["pnpm", "exec", "vitest", "--version"]),
  gate("TypeDoc", ["pnpm", "exec", "typedoc", "--version"]),
  gate("Prettier", ["pnpm", "exec", "prettier", "--version"]),
  gate("GNU tar", ["tar", "--version"]),
];
const finalizers = [
  gate("evidence-format", [
    "pnpm",
    "exec",
    "prettier",
    "--check",
    "--ignore-path",
    "/dev/null",
    resultsPath,
    reportPath,
  ]),
  gate("evidence-diff", ["git", "diff", "--check"]),
];
function locatePhase(cwd) {
  const candidates = [];
  const addDirectory = (relative) => {
    const absolute = path.join(cwd, relative);
    if (fs.existsSync(absolute) && fs.lstatSync(absolute).isDirectory()) {
      candidates.push(relative);
    }
  };
  addDirectory(`.planning/phases/${phaseName}`);
  const milestones = path.join(cwd, ".planning/milestones");
  if (fs.existsSync(milestones)) {
    for (const entry of fs.readdirSync(milestones, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.endsWith("-phases")) {
        addDirectory(`.planning/milestones/${entry.name}/${phaseName}`);
      }
    }
  }
  assert.equal(
    candidates.length,
    1,
    `Retain exactly one active or archived Phase 18 evidence directory; found ${candidates.length}: ${candidates.sort().join(", ")}`,
  );
  return candidates[0];
}
function git(cwd, args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    shell: false,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const byteLength = (text) => new TextEncoder().encode(text).length;
function included(file) {
  return (
    /^(src|ts-mls|scripts|docs|typedocs|examples|\.vitepress)(\/|$)/.test(
      file,
    ) ||
    [
      ".github/workflows/tests.yml",
      ".github/workflows/build.yml",
      "CHANGELOG.md",
      "README.md",
      "LICENSE",
      "CONTRIBUTING.md",
      ".gitmodules",
      ".npmrc",
      ".prettierignore",
      ".planning/WINDOWS.md",
      ".planning/RELEASE-FOLLOWUPS.md",
    ].includes(file) ||
    /(^|\/)(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?|deno\.jsonc?|deno\.lock)$/.test(
      file,
    ) ||
    /^(tsconfig.*\.json|vitest.*\.[cm]?[jt]s|typedoc.*\.json|vitepress.*\.[cm]?[jt]s|\.prettierrc.*|prettier\.config\.[cm]?js)$/.test(
      file,
    ) ||
    /^\.planning\/.*\/18-FINDING-DISPOSITIONS\.md$/.test(file)
  );
}
function fingerprint(cwd) {
  const files = git(cwd, ["ls-files", "-z"]).split("\0").filter(Boolean);
  if (files.includes("ts-mls")) {
    files.push(
      ...git(path.join(cwd, "ts-mls"), ["ls-files", "-z"])
        .split("\0")
        .filter(Boolean)
        .map((file) => `ts-mls/${file}`),
    );
  }
  const entries = [...new Set(files.filter(included))].sort().map((file) => {
    const absolute = path.join(cwd, file);
    const stat = fs.lstatSync(absolute);
    let mode, bytes;
    if (stat.isDirectory()) {
      mode = "160000";
      bytes = git(absolute, ["rev-parse", "HEAD"]).trim();
    } else if (stat.isSymbolicLink()) {
      mode = "120000";
      bytes = fs.readlinkSync(absolute);
    } else {
      mode = stat.mode & 0o111 ? "100755" : "100644";
      bytes = fs.readFileSync(absolute);
    }
    return { path: file, mode, sha256: hash(bytes) };
  });
  return {
    algorithm: "sha256/path-mode-content-v1",
    digest: hash(JSON.stringify(entries)),
    entries,
    excludedMetadata,
    capturedAt: new Date().toISOString(),
  };
}
function checkFingerprint(saved, cwd) {
  const current = fingerprint(cwd);
  assert.equal(saved.algorithm, current.algorithm);
  assert.deepEqual(saved.excludedMetadata, excludedMetadata);
  assert.deepEqual(
    saved.entries,
    current.entries,
    "Tracked input paths/modes/bytes changed",
  );
  assert.equal(saved.digest, current.digest, "Tracked input digest changed");
}
function frameHeader(record) {
  return `\n=== BEGIN ${JSON.stringify({
    id: record.id,
    argv: record.argv,
    env: record.env,
    cwd: record.cwd,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    durationMs: record.durationMs,
    exitCode: record.exitCode,
    signal: record.signal,
  })} ===\n`;
}
// File descriptors capture unlimited child output without an exec maxBuffer.
// Copy bounded chunks into one append-only log; stdout/stderr remain lossless
// separately and do not claim cross-stream chronological ordering.
function appendFile(destination, source) {
  const fd = fs.openSync(source, "r");
  const chunk = new Uint8Array(64 * 1024);
  try {
    let count;
    while ((count = fs.readSync(fd, chunk, 0, chunk.length, null))) {
      fs.appendFileSync(destination, chunk.subarray(0, count));
    }
  } finally {
    fs.closeSync(fd);
  }
}
async function runCommand(spec, cwd, destination, envBase = executionEnv) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "phase18-command-"));
  const stdoutPath = path.join(temporary, "stdout");
  const stderrPath = path.join(temporary, "stderr");
  const outFd = fs.openSync(stdoutPath, "w");
  const errFd = fs.openSync(stderrPath, "w");
  const record = {
    id: spec.id,
    argv: spec.argv,
    env: { ...envBase, ...spec.env },
    cwd,
    startedAt: new Date().toISOString(),
  };
  const start = Date.parse(record.startedAt);
  try {
    const outcome = await new Promise((resolve) => {
      const child = spawn(spec.argv[0], spec.argv.slice(1), {
        cwd,
        env: { ...process.env, ...record.env },
        shell: false,
        stdio: ["ignore", outFd, errFd],
      });
      child.on("error", (error) => {
        fs.writeSync(errFd, String(error) + "\n");
        resolve({ exitCode: -1, signal: null });
      });
      child.on("close", (exitCode, signal) => resolve({ exitCode, signal }));
    });
    Object.assign(record, outcome, { endedAt: new Date().toISOString() });
    record.durationMs = Date.parse(record.endedAt) - start;
    fs.closeSync(outFd);
    fs.closeSync(errFd);
    record.logStart = fs.existsSync(destination)
      ? fs.statSync(destination).size
      : 0;
    fs.appendFileSync(destination, frameHeader(record));
    for (const [stream, source] of [
      ["stdout", stdoutPath],
      ["stderr", stderrPath],
    ]) {
      const length = fs.statSync(source).size;
      fs.appendFileSync(destination, `--- ${stream} ${length} bytes ---\n`);
      record[stream] = {
        offset: fs.statSync(destination).size,
        bytes: length,
        sha256: hash(fs.readFileSync(source)),
      };
      appendFile(destination, source);
      fs.appendFileSync(destination, `\n--- END ${stream} ---\n`);
    }
    fs.appendFileSync(destination, `=== END ${record.id} ===\n`);
    record.logEnd = fs.statSync(destination).size;
    record.frameSha256 = hash(
      fs.readFileSync(destination).subarray(record.logStart, record.logEnd),
    );
    return record;
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}
function streamText(log, record, stream) {
  const output = record[stream];
  return log
    .subarray(output.offset, output.offset + output.bytes)
    .toString("utf8");
}
function counts(text) {
  const clean = text.replace(/\x1b\[[0-9;]*m/g, "");
  const tests = clean.match(/\bTests\s+(\d+) passed \((\d+)\)/);
  const files = clean.match(/Test Files\s+(\d+) passed \((\d+)\)/);
  const tapTests = clean.match(/^(?:#|ℹ) tests (\d+)$/m);
  const tapPass = clean.match(/^(?:#|ℹ) pass (\d+)$/m);
  const tapFail = clean.match(/^(?:#|ℹ) fail (\d+)$/m);
  if (tests && files)
    return { tests: +tests[2], passed: +tests[1], files: +files[2] };
  if (tapTests && tapPass && tapFail)
    return { tests: +tapTests[1], passed: +tapPass[1], failed: +tapFail[1] };
  return null;
}
function writeJson(cwd, result) {
  const filename = path.join(cwd, resultsPath);
  const temporary = `${filename}.tmp.json`;
  fs.writeFileSync(temporary, JSON.stringify(result, null, 2) + "\n");
  const formatted = spawnSync(
    "pnpm",
    [
      "exec",
      "prettier",
      "--write",
      "--ignore-path",
      "/dev/null",
      temporary,
      "--log-level",
      "silent",
    ],
    {
      cwd,
      env: { ...process.env, ...executionEnv },
      shell: false,
      stdio: "inherit",
    },
  );
  assert.ifError(formatted.error);
  assert.equal(formatted.status, 0, "Atomic evidence JSON formatting failed");
  fs.renameSync(temporary, filename);
}
function verify(result, cwd, log, requireFinalizers = true) {
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.scope, "observed-local-only");
  assert.equal(result.ciExecuted, false);
  checkFingerprint(result.inputs, cwd);
  const expected = [
    ...versionCommands.map((spec) => ({ ...spec, id: `version:${spec.id}` })),
    ...gates,
    ...(requireFinalizers ? finalizers : []),
  ];
  assert.equal(
    result.records.length,
    expected.length,
    "Missing or merged command records",
  );
  assert.equal(result.logBytes, log.length);
  assert.equal(result.logSha256, hash(log));
  let offset = 0;
  let previousEnd = Date.parse(result.inputs.capturedAt);
  for (let i = 0; i < expected.length; i++) {
    const record = result.records[i],
      spec = expected[i];
    assert.equal(record.id, spec.id, "Record order changed");
    assert.deepEqual(record.argv, spec.argv, "Unexpected/release command");
    assert.equal(record.cwd, cwd);
    assert.equal(record.exitCode, 0, `Failed command: ${record.id}`);
    assert.equal(record.signal, null);
    assert.deepEqual(record.env, { ...result.environment, ...spec.env });
    assert.ok(typeof record.env.PATH === "string" && record.env.PATH.length);
    assert.ok(
      Date.parse(record.startedAt) >= previousEnd,
      "Invalid start/order",
    );
    assert.ok(Date.parse(record.endedAt) >= Date.parse(record.startedAt));
    assert.equal(
      record.durationMs,
      Date.parse(record.endedAt) - Date.parse(record.startedAt),
    );
    previousEnd = Date.parse(record.endedAt);
    assert.equal(record.logStart, offset);
    let frame = frameHeader(record);
    for (const stream of ["stdout", "stderr"]) {
      const output = record[stream];
      assert.ok(Number.isSafeInteger(output.bytes) && output.bytes >= 0);
      frame += `--- ${stream} ${output.bytes} bytes ---\n`;
      assert.equal(output.offset, record.logStart + byteLength(frame));
      const bytes = log.subarray(output.offset, output.offset + output.bytes);
      assert.equal(bytes.length, output.bytes);
      assert.equal(hash(bytes), output.sha256, `Truncated/tampered ${stream}`);
      frame += bytes.toString("utf8") + `\n--- END ${stream} ---\n`;
    }
    frame += `=== END ${record.id} ===\n`;
    assert.equal(record.logEnd, record.logStart + byteLength(frame));
    assert.equal(
      hash(log.subarray(record.logStart, record.logEnd)),
      record.frameSha256,
    );
    assert.equal(
      log.subarray(record.logStart, record.logEnd).toString("utf8"),
      frame,
    );
    offset = record.logEnd;
    const stdout = streamText(log, record, "stdout");
    if (record.id.startsWith("version:")) {
      const name = record.id.slice(8);
      assert.ok(stdout.trim().length, `Absent version: ${name}`);
      assert.equal(result.versions[name], stdout.trim());
    } else {
      assert.deepEqual(record.counts, counts(stdout));
    }
  }
  assert.equal(offset, log.length, "Unbounded extra log bytes");
  assert.deepEqual(
    Object.keys(result.versions),
    versionCommands.map(({ id }) => id),
  );
  for (const id of [
    "package-invariants",
    "portable-ledger",
    "runtime",
    "extended",
    "owner-ledger",
  ]) {
    const count = result.records.find((record) => record.id === id).counts;
    assert.ok(
      count && count.tests === count.passed && count.tests > 0,
      `Absent/passing counts: ${id}`,
    );
  }
  assert.ok(
    result.records.find((record) => record.id === "runtime").counts.tests >=
      2184,
    "Runtime count below Phase 17 baseline plus 15 new Phase 18 tests",
  );
  assert.equal(
    result.records.find((record) => record.id === "package-invariants").counts
      .tests,
    106,
  );
  const smoke = streamText(
    log,
    result.records.find((record) => record.id === "packed-consumers"),
    "stdout",
  );
  for (const marker of [
    "zero forbidden/optional dependency directories",
    "nested dependency proof",
    "(10 entries)",
    "running Node runtime smoke",
    "running Bun",
    "running Deno",
    "under nodenext",
    "under bundler",
    "standalone five legacy-type negatives",
    "skipLibCheck=true",
  ])
    assert.ok(smoke.includes(marker), `Missing consumer evidence: ${marker}`);
}
function seal(result, filename) {
  const log = fs.readFileSync(filename);
  result.logBytes = log.length;
  result.logSha256 = hash(log);
}
async function execute() {
  const dirty = git(root, ["status", "--porcelain", "--untracked-files=no"])
    .split("\n")
    .filter((line) => line && included(line.slice(3)));
  assert.deepEqual(
    dirty,
    [],
    "Commit all validation inputs before the final run",
  );
  const destination = path.join(root, logPath);
  fs.writeFileSync(destination, "");
  const result = {
    schemaVersion: 1,
    scope: "observed-local-only",
    ciExecuted: false,
    observedHead: git(root, ["rev-parse", "HEAD"]).trim(),
    environment: executionEnv,
    inputs: fingerprint(root),
    versions: {},
    records: [],
  };
  for (const spec of [
    ...versionCommands.map((item) => ({ ...item, id: `version:${item.id}` })),
    ...gates,
  ]) {
    console.log(`Running ${spec.id}: ${JSON.stringify(spec.argv)}`);
    const record = await runCommand(spec, root, destination);
    const log = fs.readFileSync(destination);
    const stdout = streamText(log, record, "stdout");
    if (spec.id.startsWith("version:"))
      result.versions[spec.id.slice(8)] = stdout.trim();
    else record.counts = counts(stdout);
    result.records.push(record);
    seal(result, destination);
    writeJson(root, result);
    console.log(
      `Completed ${spec.id}: exit ${record.exitCode}, stdout ${record.stdout.bytes}, stderr ${record.stderr.bytes}`,
    );
    assert.equal(
      record.exitCode,
      0,
      `Gate failed; full output persisted: ${spec.id}`,
    );
    checkFingerprint(result.inputs, root);
  }
  verify(result, root, fs.readFileSync(destination), false);
  console.log(
    "All local gates passed; write the closeout, then --finalize-evidence.",
  );
}
async function finalize() {
  const result = JSON.parse(
    fs.readFileSync(path.join(root, resultsPath), "utf8"),
  );
  const destination = path.join(root, logPath);
  verify(result, root, fs.readFileSync(destination), false);
  assert.ok(
    fs.existsSync(path.join(root, reportPath)),
    "Closeout report missing",
  );
  for (const spec of finalizers) {
    const record = await runCommand(spec, root, destination);
    record.counts = counts(
      streamText(fs.readFileSync(destination), record, "stdout"),
    );
    result.records.push(record);
    seal(result, destination);
    writeJson(root, result);
    assert.equal(record.exitCode, 0, `Evidence finalizer failed: ${spec.id}`);
  }
  verify(result, root, fs.readFileSync(destination));
  console.log("Finalized evidence passed verification.");
}
async function selfTest() {
  const locationFixture = fs.mkdtempSync(
    path.join(os.tmpdir(), "phase18-location-"),
  );
  try {
    assert.throws(() => locatePhase(locationFixture), /Retain exactly one/);
    const active = `.planning/phases/${phaseName}`;
    const archived = `.planning/milestones/v2.2-phases/${phaseName}`;
    fs.mkdirSync(path.join(locationFixture, active), { recursive: true });
    assert.equal(locatePhase(locationFixture), active);
    fs.mkdirSync(path.dirname(path.join(locationFixture, archived)), {
      recursive: true,
    });
    fs.renameSync(
      path.join(locationFixture, active),
      path.join(locationFixture, archived),
    );
    assert.equal(locatePhase(locationFixture), archived);
    const copiedRunner = path.join(
      locationFixture,
      "scripts/run-phase18-final-gates.mjs",
    );
    fs.mkdirSync(path.dirname(copiedRunner), { recursive: true });
    fs.copyFileSync(
      path.join(root, "scripts/run-phase18-final-gates.mjs"),
      copiedRunner,
    );
    const listed = spawnSync(process.execPath, [copiedRunner, "--list"], {
      cwd: locationFixture,
      encoding: "utf8",
      shell: false,
    });
    assert.ifError(listed.error);
    assert.equal(listed.status, 0, listed.stderr);
    assert.deepEqual(JSON.parse(listed.stdout).finalizers[0].argv.slice(-2), [
      `${archived}/18-QA-RESULTS.json`,
      `${archived}/18-VERIFICATION.md`,
    ]);
    assert.deepEqual(
      fs.readdirSync(path.join(locationFixture, archived)),
      [],
      "--list must not create evidence",
    );
    fs.mkdirSync(path.join(locationFixture, active), { recursive: true });
    assert.throws(() => locatePhase(locationFixture), /found 2/);
    fs.rmdirSync(path.join(locationFixture, active));
    const duplicate = `.planning/milestones/v2.3-phases/${phaseName}`;
    fs.mkdirSync(path.join(locationFixture, duplicate), { recursive: true });
    assert.throws(() => locatePhase(locationFixture), /found 2/);
    console.log(
      "Phase locator passed: active, archived, missing, duplicate, and read-only archived CLI paths.",
    );
  } finally {
    fs.rmSync(locationFixture, { recursive: true, force: true });
  }
  assert.deepEqual(counts("ℹ tests 106\nℹ pass 106\nℹ fail 0"), {
    tests: 106,
    passed: 106,
    failed: 0,
  });
  assert.deepEqual(counts("# tests 1\n# pass 1\n# fail 0"), {
    tests: 1,
    passed: 1,
    failed: 0,
  });
  assert.deepEqual(
    counts("Test Files 131 passed (131)\nTests 2184 passed (2184)"),
    { tests: 2184, passed: 2184, files: 131 },
  );
  assert.equal(counts(""), null);
  if (fs.existsSync(path.join(root, resultsPath))) {
    // A read-only parser/frame preflight on prior logs. Deliberately substitute
    // current inputs in memory only; this does NOT validate stale run evidence.
    const saved = JSON.parse(
      fs.readFileSync(path.join(root, resultsPath), "utf8"),
    );
    const log = fs.readFileSync(path.join(root, logPath));
    if (saved.records.length === versionCommands.length + gates.length) {
      saved.inputs = {
        ...fingerprint(root),
        capturedAt: saved.inputs.capturedAt,
      };
      for (const record of saved.records.filter(
        (item) => !item.id.startsWith("version:"),
      )) {
        record.counts = counts(streamText(log, record, "stdout"));
      }
      verify(saved, root, log, false);
      console.log(
        "Prior-output parser/frame preflight passed; stale evidence was not validated or rewritten.",
      );
    }
  }
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "phase18-self-test-"));
  try {
    git(cwd, ["init", "--quiet"]);
    for (const [file, text] of [
      ["src/example.ts", "export const value = 1;\n"],
      [".planning/STATE.md", "state"],
      [".planning/phases/example/18-06-SUMMARY.md", "summary"],
      [`${phase}/18-QA-RESULTS.json`, "{}"],
      [`${phase}/18-QA-LOG.txt`, "log"],
      [`${phase}/18-VERIFICATION.md`, "report"],
    ]) {
      fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
      fs.writeFileSync(path.join(cwd, file), text);
      git(cwd, ["add", "--", file]);
    }
    const saved = fingerprint(cwd);
    for (const file of [
      ".planning/STATE.md",
      ".planning/phases/example/18-06-SUMMARY.md",
      resultsPath,
      logPath,
      reportPath,
    ]) {
      fs.appendFileSync(path.join(cwd, file), "metadata edit");
      checkFingerprint(saved, cwd);
    }
    const source = path.join(cwd, "src/example.ts");
    fs.appendFileSync(source, "export const changed = 2;\n");
    assert.throws(() => checkFingerprint(saved, cwd));
    fs.writeFileSync(source, "export const value = 1;\n");
    fs.chmodSync(source, 0o755);
    assert.throws(() => checkFingerprint(saved, cwd));
    fs.chmodSync(source, 0o644);
    fs.writeFileSync(path.join(cwd, "src/added.ts"), "export {};\n");
    git(cwd, ["add", "src/added.ts"]);
    assert.throws(() => checkFingerprint(saved, cwd));
    git(cwd, ["rm", "--cached", "src/added.ts"]);
    fs.unlinkSync(source);
    assert.throws(() => checkFingerprint(saved, cwd));
    fs.writeFileSync(source, "export const value = 1;\n");
    checkFingerprint(saved, cwd);
    const destination = path.join(cwd, "commands.log");
    const specifications = [
      gate("empty-1", [process.execPath, "-e", ""]),
      gate("empty-2", [process.execPath, "-e", ""]),
      gate("large", [
        process.execPath,
        "-e",
        "process.stdout.write('x'.repeat(2*1024*1024));process.stderr.write('stderr')",
      ]),
      gate("failure", [
        process.execPath,
        "-e",
        "console.error('failure output');process.exit(7)",
      ]),
    ];
    const records = [];
    for (const spec of specifications)
      records.push(await runCommand(spec, cwd, destination));
    assert.equal(records.length, 4);
    assert.equal(records[0].stdout.bytes, 0);
    assert.equal(records[1].stdout.bytes, 0);
    assert.notEqual(records[0].id, records[1].id);
    assert.equal(records[2].stdout.bytes, 2 * 1024 * 1024);
    assert.equal(records[3].exitCode, 7);
    assert.ok(
      streamText(fs.readFileSync(destination), records[3], "stderr").includes(
        "failure output",
      ),
    );
    // Use the production verifier with real synthetic command frames: fabricate
    // only gate output fixtures, never repository evidence or a claimed gate run.
    const evidenceLog = path.join(cwd, "evidence.log");
    const result = {
      schemaVersion: 1,
      scope: "observed-local-only",
      ciExecuted: false,
      observedHead: "descriptive",
      environment: executionEnv,
      inputs: fingerprint(cwd),
      versions: {},
      records: [],
    };
    const all = [
      ...versionCommands.map((spec) => ({ ...spec, id: `version:${spec.id}` })),
      ...gates,
      ...finalizers,
    ];
    for (const spec of all) {
      let output = "";
      if (spec.id.startsWith("version:")) output = "fixture-version";
      if (spec.id === "runtime")
        output = "Test Files 132 passed (132)\nTests 2184 passed (2184)";
      if (spec.id === "extended")
        output = "Test Files 1 passed (1)\nTests 4 passed (4)";
      if (
        ["package-invariants", "portable-ledger", "owner-ledger"].includes(
          spec.id,
        )
      ) {
        const count = spec.id === "package-invariants" ? 106 : 1;
        output = `# tests ${count}\n# pass ${count}\n# fail 0`;
      }
      if (spec.id === "packed-consumers")
        output =
          "zero forbidden/optional dependency directories nested dependency proof (10 entries) running Node runtime smoke running Bun running Deno under nodenext under bundler standalone five legacy-type negatives skipLibCheck=true";
      const record = await runCommand(
        gate(spec.id, [
          process.execPath,
          "-e",
          `process.stdout.write(${JSON.stringify(output)})`,
        ]),
        cwd,
        evidenceLog,
        {},
      );
      record.argv = spec.argv;
      record.env = { ...executionEnv, ...spec.env };
      // Rebuild the fixture frame with the prescribed arguments.
      const bytes = new TextEncoder().encode(output);
      record.logStart = spec === all[0] ? 0 : result.records.at(-1).logEnd;
      let frame =
        frameHeader(record) + `--- stdout ${bytes.length} bytes ---\n`;
      record.stdout = {
        offset: record.logStart + byteLength(frame),
        bytes: bytes.length,
        sha256: hash(bytes),
      };
      frame += output + "\n--- END stdout ---\n--- stderr 0 bytes ---\n";
      record.stderr = {
        offset: record.logStart + byteLength(frame),
        bytes: 0,
        sha256: hash(""),
      };
      frame += `\n--- END stderr ---\n=== END ${record.id} ===\n`;
      fs.truncateSync(evidenceLog, record.logStart);
      fs.appendFileSync(evidenceLog, frame);
      record.logEnd = record.logStart + byteLength(frame);
      record.frameSha256 = hash(frame);
      if (spec.id.startsWith("version:"))
        result.versions[spec.id.slice(8)] = output;
      else record.counts = counts(output);
      result.records.push(record);
    }
    seal(result, evidenceLog);
    const log = fs.readFileSync(evidenceLog);
    verify(result, cwd, log);
    result.observedHead = "a later metadata-only commit";
    verify(result, cwd, log);
    for (const mutate of [
      (r) => r.records.pop(),
      (r) => r.records.splice(10, 1),
      (r) => ([r.records[10], r.records[11]] = [r.records[11], r.records[10]]),
      (r) => (r.records[10].exitCode = 1),
      (r) => (r.records[10].argv = ["pnpm", "publish"]),
      (r) => delete r.versions.Node,
      (r) =>
        (r.records.find((record) => record.id === "runtime").counts = null),
      (r) => r.records[10].stdout.bytes++,
    ]) {
      const poisoned = structuredClone(result);
      mutate(poisoned);
      assert.throws(() => verify(poisoned, cwd, log));
    }
    assert.throws(() => verify(result, cwd, log.subarray(0, log.length - 1)));
    const tampered = new Uint8Array(log);
    tampered[100] ^= 1;
    assert.throws(() => verify(result, cwd, tampered));
    console.log(
      "Self-test passed: metadata/evidence/HEAD stability; tracked content/mode/path addition/removal sensitivity; adjacent/empty records; >2MiB lossless output; failing output; command/order/count/version/log tamper rejection.",
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}
try {
  const args = process.argv.slice(2);
  assert.ok(args.length <= 1, "Expected one mode");
  switch (args[0]) {
    case "--list":
      console.log(
        JSON.stringify(
          { versions: versionCommands, gates, finalizers },
          null,
          2,
        ),
      );
      break;
    case "--self-test":
      await selfTest();
      break;
    case "--finalize-evidence":
      await finalize();
      break;
    case "--verify-record": {
      verify(
        JSON.parse(fs.readFileSync(path.join(root, resultsPath), "utf8")),
        root,
        fs.readFileSync(path.join(root, logPath)),
      );
      console.log(
        "Verified current ordered local evidence; observed HEAD is descriptive only.",
      );
      break;
    }
    case undefined:
      await execute();
      break;
    default:
      throw new Error(`Unknown mode: ${args[0]}`);
  }
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
