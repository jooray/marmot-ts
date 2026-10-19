import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const ledgerPath = path.join(repository, ".planning/WINDOWS.md");
const emptyRow =
  "| _(none)_ |  |  |  |  | _No windows recorded._ |  |  |  |  |";
const explanation =
  "Active ledger for new work. Historical findings are summarized in\n" +
  "[release follow-ups](RELEASE-FOLLOWUPS.md). Zero active entries\n" +
  "does not mean those findings were fixed or release readiness was verified.";

function parseLedger(raw) {
  const frontmatter = raw.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(frontmatter, "ledger must have frontmatter");
  const fields = Object.fromEntries(
    frontmatter[1].split("\n").map((line) => {
      const separator = line.indexOf(":");
      assert.ok(separator > 0, "frontmatter field must have a name");
      const value = line.slice(separator + 1).trim();
      return [
        line.slice(0, separator),
        /^\d+$/.test(value)
          ? Number(value)
          : value.startsWith('"')
            ? JSON.parse(value)
            : value,
      ];
    }),
  );
  const fence = raw.match(/^````json\n([\s\S]*?)\n````$/m);
  assert.ok(fence, "ledger must retain its four-backtick JSON fence");
  const entries = JSON.parse(fence[1]);
  assert.ok(Array.isArray(entries), "ledger JSON must be an array");
  const table = raw.match(/^\| id \|[^\n]*\n\|----\|[^\n]*(?:\n\|[^\n]*)*/m);
  assert.ok(table, "ledger must contain its rendered table");
  return {
    fields,
    entries,
    json: fence[1],
    rows: table[0].split("\n").slice(2),
  };
}

function assertCounts(ledger, open, waived, fixed, total) {
  assert.deepEqual(
    [
      ledger.open_count,
      ledger.waived_count,
      ledger.fixed_count,
      ledger.total_count,
    ],
    [open, waived, fixed, total],
  );
}

function assertZeroLedger(raw) {
  const ledger = parseLedger(raw);
  assert.equal(ledger.fields.schema_version, 1);
  assert.equal(ledger.fields.last_updated, "2026-10-07");
  assertCounts(ledger.fields, 0, 0, 0, 0);
  assert.deepEqual(ledger.entries, []);
  assert.equal(ledger.json, "[]");
  assert.deepEqual(ledger.rows, [emptyRow], "canonical empty row is required");
  assert.ok(
    raw.includes(explanation),
    "release follow-up explanation must remain",
  );
}

function invoke(owner, cwd, args) {
  const result = spawnSync(process.execPath, [owner, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null, result.stdout + result.stderr);
  return result;
}

function resolveOwner() {
  const configuredHomes = [
    process.env.GSD_HOME,
    process.env.CODEX_HOME,
    process.env.CLAUDE_CONFIG_DIR,
    process.env.OPENCODE_CONFIG_DIR,
    path.join(os.homedir(), ".codex"),
    path.join(os.homedir(), ".claude"),
  ].filter(Boolean);
  const candidates = process.env.GSD_TOOLS
    ? [path.resolve(process.env.GSD_TOOLS)]
    : configuredHomes.map((home) =>
        path.join(home, "gsd-core/bin/gsd-tools.cjs"),
      );
  const diagnostics = [];
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) {
      diagnostics.push(`${candidate}: missing`);
      continue;
    }
    const result = invoke(candidate, repository, ["runtime-identity", "--raw"]);
    if (result.status !== 0) {
      diagnostics.push(
        `${candidate}: identity failed (${result.stderr.trim()})`,
      );
      continue;
    }
    let identity;
    try {
      identity = JSON.parse(result.stdout);
    } catch {
      diagnostics.push(`${candidate}: invalid runtime identity`);
      continue;
    }
    if (
      identity.packageName === "@opengsd/gsd-core" &&
      identity.version === "1.16.0"
    ) {
      return candidate;
    }
    diagnostics.push(
      `${candidate}: unexpected identity ${result.stdout.trim()}`,
    );
  }
  throw new Error(
    "Unavailable WINDOWS owner: require identity-verified @opengsd/gsd-core " +
      "1.16.0 via GSD_TOOLS or configured GSD home.\n" +
      diagnostics.join("\n"),
  );
}

function successfulJson(result) {
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const value = JSON.parse(result.stdout);
  assert.equal(value.ok, true);
  return value;
}

test("portable ledger invariants", () => {
  assertZeroLedger(fs.readFileSync(ledgerPath, "utf8"));
});

test("owner status-append-status roundtrip", () => {
  const originalBytes = new Uint8Array(fs.readFileSync(ledgerPath));
  const original = new TextDecoder("utf-8", { fatal: true }).decode(
    originalBytes,
  );
  const owner = resolveOwner();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "windows-ledger-test-"));
  try {
    assertZeroLedger(original);
    const fixtures = Object.fromEntries(
      ["malformed", "normalized"].map((name) => {
        const cwd = path.join(root, name);
        fs.mkdirSync(path.join(cwd, ".planning"), { recursive: true });
        fs.writeFileSync(path.join(cwd, ".planning/config.json"), "{}\n");
        fs.writeFileSync(
          path.join(cwd, ".planning/WINDOWS.md"),
          name === "malformed"
            ? original.replace(`${emptyRow}\n`, "")
            : original,
        );
        return [name, cwd];
      }),
    );
    const appendArgs = [
      "windows",
      "append",
      "--kind",
      "deviation",
      "--phase",
      "18",
      "--description",
      "isolated phase18 proof",
    ];
    const malformedBefore = fs.readFileSync(
      path.join(fixtures.malformed, ".planning/WINDOWS.md"),
      "utf8",
    );
    const malformedStatus = successfulJson(
      invoke(owner, fixtures.malformed, ["windows", "status"]),
    );
    assertCounts(malformedStatus.ledger, 0, 0, 0, 0);
    const failure = invoke(owner, fixtures.malformed, appendArgs);
    assert.equal(failure.status, 1, failure.stdout + failure.stderr);
    assert.match(
      failure.stdout + failure.stderr,
      /disagrees with the fenced JSON entries/,
    );
    assert.match(failure.stdout + failure.stderr, /row id\(s\): _\(none\)_/);
    assert.equal(
      fs.readFileSync(
        path.join(fixtures.malformed, ".planning/WINDOWS.md"),
        "utf8",
      ),
      malformedBefore,
      "rejected append must leave the malformed fixture unchanged",
    );

    const before = successfulJson(
      invoke(owner, fixtures.normalized, ["windows", "status"]),
    );
    assertCounts(before.ledger, 0, 0, 0, 0);
    assert.deepEqual(before.ledger.entries, []);
    const appended = successfulJson(
      invoke(owner, fixtures.normalized, appendArgs),
    );
    const reloaded = successfulJson(
      invoke(owner, fixtures.normalized, ["windows", "status"]),
    );
    assertCounts(appended.ledger, 1, 0, 0, 1);
    assertCounts(reloaded.ledger, 1, 0, 0, 1);
    assert.deepEqual(reloaded.ledger, appended.ledger);
    assert.deepEqual(reloaded.ledger.entries, [appended.entry]);
    const entry = appended.entry;
    assert.equal(entry.id, 1);
    assert.equal(entry.phase, "18");
    assert.equal(entry.kind, "deviation");
    assert.equal(entry.description, "isolated phase18 proof");
    assert.equal(entry.status, "open");
    const disk = parseLedger(
      fs.readFileSync(
        path.join(fixtures.normalized, ".planning/WINDOWS.md"),
        "utf8",
      ),
    );
    assertCounts(disk.fields, 1, 0, 0, 1);
    assert.deepEqual(disk.entries, [entry]);
    assert.deepEqual(
      disk.rows.map((row) =>
        row
          .split("|")
          .slice(1, -1)
          .map((cell) => cell.trim()),
      ),
      [
        [
          String(entry.id),
          entry.phase,
          entry.kind,
          entry.file,
          String(entry.line ?? ""),
          entry.description,
          entry.status,
          entry.reason ?? "",
          entry.recorded_at,
          entry.resolved_at ?? "",
        ],
      ],
      "rendered table must agree with the exact appended JSON identity",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    assert.deepEqual(
      new Uint8Array(fs.readFileSync(ledgerPath)),
      originalBytes,
    );
  }
});
