import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const ledgerName = "18-FINDING-DISPOSITIONS.md";
// This independent source inventory must change only when a source record is added.
const expectedIds = [
  "H11-WR-01",
  "H11-WR-02",
  "H11-WR-03",
  "H11-WR-04",
  "H11-WR-05",
  "H11-IN-01",
  "H11-IN-02",
  "P10-WR-02",
  "P10-WR-06",
  "P8-W-01",
  "P8-WR-01",
  "P8-WR-02",
  "P8-WR-03",
  "P9-D-09-01",
  "P9-D-09-07",
  "P9-D-09-08",
  "V1-MEMORY",
  "V1-REMOVAL-MARKER",
  "V1-TOMBSTONE",
  "PUBLIC-MESSAGE",
  "TEST-TYPING",
  "API-DOCS",
  "FORMAT-RUNTIME",
  "FORMAT-RUNTIME-TEST",
  "FORMAT-WELCOME-TEST",
  "HW-01",
  "HW-02",
  "HW-03",
  "HW-04",
  "HW-05",
  "HW-06",
  "HW-07",
  "HW-08",
  "HW-09",
  "BND-ROUTES-HISTORY",
  "BND-ADOPTION-STORES",
  "BND-FIRST-CONTACT",
  "BND-TIMESTAMP-EXPIRY",
  "BND-BLOB-CREDENTIALS",
  "BND-STORE-PROCESS",
  "EMPTY-NEW-DEFECTS",
];
const hwDescriptions = [
  "Full suite otherwise passed; pre-existing export snapshot drift remains assigned to plan 03.1-08",
  "Corrected stale 11/11 state position to 12/14 after state.advance-plan misclassified the phase as complete",
  "Executable vector path validation distinguishes scenario vectors from inventory-only formal records",
  "Wired lifecycle defaults into real group creation",
  "Updated stale group-construction lifecycle expectation",
  "Added read-only hydrated disband request projection required by the public facade",
  "Updated stale expected component list after lifecycle-v1 became required",
  "Generated Deno lockfile removed after runtime smoke execution",
  "Repaired Phase 5 position after state.advance-plan could not parse the initial Not started state",
];
const statuses = new Set([
  "fixed",
  "verified-existing",
  "accepted-boundary",
  "deferred",
  "observation",
  "no-open-item",
]);
const provenance = {
  H11: "11-exports-snapshot-qa-gate/11-REVIEW.md",
  H10: "10-founding-group-creation-via-welcome/10-REVIEW.md",
  H8: "08-groupcontext-profile-requirement-legality-seam-extension/08-VERIFICATION.md",
  H9: "09-self-update-replacement-leaf-identity-binding/deferred-items.md",
  HV1: "v1.0-phases/03-commit-integrity-convergence-parity/deferred-items.md",
  HQ: "git:be2f307",
  HF: "10-founding-group-creation-via-welcome/deferred-items.md",
  HW: "pre-v0.6.0/BASE-WINDOWS.md",
  HB: "git:0d75fe18:.planning/RELEASE-FOLLOWUPS.md",
};
const protectedLimits = {
  "H11-WR-05": [
    "0x0004",
    "MDK legacy-marker read fallback",
    "approved difference",
    "0x000a",
  ],
  "H11-IN-02": [
    "Typed arrays",
    "legacy domain string",
    "class instances",
    "getters",
    "factories",
    "prototypes",
  ],
  "P10-WR-02": ["process-local", "across restart", "deferred"],
  "P10-WR-06": [
    "Trusted mutable ClientState",
    "transient direct nested edits",
    "both checkpoints",
    "outside the guarantee",
  ],
  "P8-WR-02": [
    "current instance only",
    "first recoverable durable write",
    "requires a lifecycle store",
  ],
  "P9-D-09-01": [
    "current-unreachable",
    "not reproduced",
    "retryable",
    "exact redelivery",
  ],
  "P9-D-09-08": [
    "Exact recorded parent",
    "source epoch",
    "immediate-child epoch",
    "MDK",
    "unproven",
  ],
  "V1-MEMORY": [
    "Workload-relative",
    "not absolute memory caps",
    "Infinity",
    "independent application window",
    "plaintext expiry",
  ],
  "V1-REMOVAL-MARKER": [
    "same local identity",
    "stays removed",
    "MDK supersession",
    "terminal-local-leaf",
  ],
  "V1-TOMBSTONE": [
    "first durable recoverable terminal write",
    "no cross-store transactions",
    "consumed attempts",
    "explicit acknowledgement",
  ],
  "PUBLIC-MESSAGE": [
    "not full branch ranking",
    "Public applications still reject",
  ],
  "BND-ROUTES-HISTORY": [
    "64 lowercase hex",
    "durable/idempotent",
    "ingestion/rewind",
    "session",
  ],
  "BND-ADOPTION-STORES": [
    "No cross-store atomicity",
    "defer single-use secret retirement",
  ],
  "BND-FIRST-CONTACT": [
    "does not prove intended-group first-contact continuity",
  ],
  "BND-TIMESTAMP-EXPIRY": [
    "signed wrap-time",
    "MDK",
    "outer to inner timestamp",
    "plaintext expiry",
    "deferred",
  ],
  "BND-BLOB-CREDENTIALS": [
    "does not delete remote blobs",
    "revoke disclosed upload credentials",
    "endpoint/contact/resource policy",
  ],
  "BND-STORE-PROCESS": [
    "read-after-completion",
    "Independent writers",
    "no CAS/cross-process serializability",
    "process-lifetime",
    "not a durable outbound journal",
    "no physical disk/heap overwrite",
  ],
};

function findLedger(directory) {
  const found = [];
  function visit(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const candidate = path.join(current, entry.name);
      if (entry.isDirectory()) visit(candidate);
      else if (entry.isFile() && entry.name === ledgerName)
        found.push(candidate);
    }
  }
  visit(directory);
  assert.equal(
    found.length,
    1,
    "Retain exactly one finding ledger after archival; missing/ambiguous evidence cannot pass",
  );
  return found[0];
}

function parseRows(markdown) {
  const lines = markdown.split("\n");
  const header =
    "| ID | Source finding | Provenance | Disposition | Named current evidence | Verification command or retained rationale | Remaining limitation |";
  const start = lines.indexOf(header);
  assert.ok(start >= 0, "missing individual inventory table");
  assert.match(lines[start + 1], /^\|(?: --- \|){7}$/);
  const rows = [];
  for (const line of lines.slice(start + 2)) {
    if (!line.startsWith("|")) break;
    const cells = line
      .slice(1, -1)
      .split("|")
      .map((cell) => cell.trim());
    assert.equal(
      cells.length,
      7,
      "one ungrouped seven-field source record per row",
    );
    const anchor = cells[0].match(/^<a id="([a-z0-9-]+)"><\/a>([A-Z0-9-]+)$/);
    assert.ok(anchor, "stable individual link anchor required");
    assert.equal(
      anchor[1],
      anchor[2].toLowerCase(),
      "anchor must identify this exact finding",
    );
    cells[0] = anchor[2];
    rows.push(cells);
  }
  return rows;
}

function validateLedger(markdown) {
  const rows = parseRows(markdown);
  assert.deepEqual(
    rows.map(([id]) => id),
    expectedIds,
    "individual inventory must be complete, unique and in source/ID order",
  );
  for (const [alias, suffix] of Object.entries(provenance)) {
    const line = markdown
      .split("\n")
      .find((candidate) => candidate.startsWith("- **" + alias + ":**"));
    assert.ok(
      line?.includes(suffix),
      alias + " original source provenance lost",
    );
    if (!["HQ", "HB"].includes(alias))
      assert.ok(
        line.includes("git:1ec62783^:"),
        alias + " must retain exact historical revision",
      );
  }
  for (const [
    id,
    description,
    origin,
    status,
    evidence,
    command,
    limit,
  ] of rows) {
    for (const field of [description, evidence, command, limit]) {
      assert.ok(
        field.length >= 8,
        id + " empty/uninformative accountability field",
      );
      assert.doesNotMatch(
        field,
        /^(?:TODO|TBD|N\/A|all green|suite passed|fixed)$/i,
        id + " blanket evidence forbidden",
      );
    }
    const source = origin.split("#");
    assert.equal(source.length, 2, id + " must name one source record");
    assert.ok(provenance[source[0]], id + " unknown source alias");
    const alias = id.startsWith("HW-")
      ? "HW"
      : id.startsWith("H11-")
        ? "H11"
        : id.startsWith("P10-")
          ? "H10"
          : id.startsWith("P8-")
            ? "H8"
            : id.startsWith("P9-")
              ? "H9"
              : id.startsWith("V1-")
                ? "HV1"
                : id.startsWith("FORMAT-")
                  ? "HF"
                  : ["PUBLIC-MESSAGE", "TEST-TYPING", "API-DOCS"].includes(id)
                    ? "HQ"
                    : "HB";
    assert.equal(source[0], alias, id + " provenance from wrong source family");
    const expectedRecord = id.startsWith("H11-")
      ? id.slice(4)
      : id.startsWith("P10-")
        ? id.slice(4)
        : id.startsWith("P8-") || id.startsWith("P9-")
          ? id.slice(3)
          : id.startsWith("HW-")
            ? String(Number(id.slice(3)))
            : undefined;
    if (expectedRecord)
      assert.equal(source[1], expectedRecord, id + " exact source record lost");
    assert.ok(statuses.has(status), id + " invalid disposition vocabulary");
    assert.ok(
      command.startsWith("pnpm ") ||
        command.startsWith("node ") ||
        command.startsWith("retained:"),
      id + " exact command or explicit retained rationale required",
    );
    assert.ok(limit.length >= 30, id + " limitation must be substantive");
    const anchors = [
      ...evidence.matchAll(
        /((?:src|scripts|docs|\.vitepress)\/[\w./-]+\.(?:ts|mjs|sh|md)|(?:tsconfig.tests|typedoc)\.json)#([^;]*)/g,
      ),
    ];
    assert.ok(anchors.length, id + " named permanent source evidence required");
    for (const [, relative, snippet] of anchors) {
      const sourceText = fs.readFileSync(path.join(root, relative), "utf8");
      if (snippet.trim())
        assert.ok(
          sourceText.includes(snippet.trim()),
          id + " named evidence anchor missing: " + relative + "#" + snippet,
        );
    }
    for (const phrase of protectedLimits[id] ?? [])
      assert.ok(
        limit.includes(phrase),
        id + " approved boundary removed: " + phrase,
      );
    if (id.startsWith("HW-"))
      assert.equal(
        description,
        hwDescriptions[Number(id.slice(3)) - 1],
        id + " verbatim historical description changed",
      );
    if (id === "P9-D-09-07") {
      assert.equal(
        status,
        "observation",
        "D-09-07 can never inherit a fixed status",
      );
      assert.match(
        command,
        /^retained:.*No exact failing test or reproduction command/,
      );
      assert.match(limit, /Unidentified and unreproduced in 14 runs/);
      assert.match(limit, /11 fixer plus 3 orchestrator/);
      assert.match(limit, /Not proven unrelated; no fix or closure claimed/);
    }
    if (id === "EMPTY-NEW-DEFECTS") {
      assert.equal(status, "no-open-item");
      assert.match(description, /No additional defect/);
    } else
      assert.notEqual(
        status,
        "no-open-item",
        id + " cannot disappear into an empty category",
      );
    if (
      [
        "H11-WR-05",
        "H11-IN-02",
        "P9-D-09-08",
        "BND-ROUTES-HISTORY",
        "BND-ADOPTION-STORES",
        "BND-TIMESTAMP-EXPIRY",
        "BND-STORE-PROCESS",
      ].includes(id)
    )
      assert.equal(
        status,
        "accepted-boundary",
        id + " accepted contract cannot be silently relabeled",
      );
    if (["BND-FIRST-CONTACT", "BND-BLOB-CREDENTIALS"].includes(id))
      assert.equal(status, "deferred", id + " deferral cannot inherit closure");
  }
  return rows;
}

const ledgerPath = findLedger(path.join(root, ".planning"));
const markdown = fs.readFileSync(ledgerPath, "utf8");
test("individual inventory retains all exact source records, evidence and boundaries", () => {
  validateLedger(markdown);
});

function poisonRow(id, mutate) {
  return markdown
    .split("\n")
    .map((line) => {
      if (!line.startsWith('| <a id="' + id.toLowerCase() + '"></a>'))
        return line;
      const cells = line
        .slice(1, -1)
        .split("|")
        .map((cell) => cell.trim());
      mutate(cells);
      return "| " + cells.join(" | ") + " |";
    })
    .join("\n");
}

for (const [name, poisoned] of [
  ["missing record", markdown.replace(/^\| <a id="p8-wr-02".*\n/m, "")],
  [
    "duplicate record",
    markdown.replace(/^(\| <a id="p8-wr-01".*)$/m, "$1\n$1"),
  ],
  [
    "grouped adjacent records",
    poisonRow("P8-WR-01", (cells) => {
      cells[0] += "/WR-02";
    }),
  ],
  [
    "lost original provenance",
    markdown.replace(
      "11-exports-snapshot-qa-gate/11-REVIEW.md",
      "unrelated.md",
    ),
  ],
  [
    "wrong source record family",
    poisonRow("P10-WR-02", (cells) => {
      cells[2] = "H11#WR-02";
    }),
  ],
  [
    "wrong adjacent source record",
    poisonRow("H11-WR-01", (cells) => {
      cells[2] = "H11#WR-02";
    }),
  ],
  [
    "blanket green evidence",
    poisonRow("H11-WR-01", (cells) => {
      cells[4] = "all green";
    }),
  ],
  [
    "nonexistent named source",
    poisonRow("H11-WR-02", (cells) => {
      cells[4] = "src/missing.test.ts#not-real";
    }),
  ],
  [
    "missing verification rationale",
    poisonRow("P9-D-09-07", (cells) => {
      cells[5] = "";
    }),
  ],
  [
    "observation called fixed",
    poisonRow("P9-D-09-07", (cells) => {
      cells[3] = "fixed";
    }),
  ],
  [
    "observation investigation limit changed",
    poisonRow("P9-D-09-07", (cells) => {
      cells[6] = cells[6].replace("14 runs", "15 runs");
    }),
  ],
  [
    "historical description rewritten",
    poisonRow("HW-08", (cells) => {
      cells[1] = "Artifact cleanup completed";
    }),
  ],
  [
    "approved fallback removed",
    poisonRow("H11-WR-05", (cells) => {
      cells[6] =
        "Canonical component tests passed; all last-resort concerns resolved.";
    }),
  ],
  [
    "deferral called fixed",
    poisonRow("BND-FIRST-CONTACT", (cells) => {
      cells[3] = "fixed";
    }),
  ],
  [
    "empty category used to erase a finding",
    poisonRow("H11-WR-02", (cells) => {
      cells[3] = "no-open-item";
    }),
  ],
  [
    "unstable source ordering",
    (() => {
      const lines = markdown.split("\n");
      const a = lines.findIndex((line) =>
        line.startsWith('| <a id="p8-wr-01"'),
      );
      [lines[a], lines[a + 1]] = [lines[a + 1], lines[a]];
      return lines.join("\n");
    })(),
  ],
]) {
  test("rejects " + name, () => assert.throws(() => validateLedger(poisoned)));
}

for (const [id, phrases] of Object.entries(protectedLimits)) {
  test("rejects removed retained boundary " + id, () => {
    for (const phrase of phrases) {
      const poisoned = poisonRow(id, (cells) => {
        cells[6] = cells[6].replace(phrase, "removed");
      });
      assert.throws(() => validateLedger(poisoned), id + ": " + phrase);
    }
  });
}

test("archived evidence discovery fails closed for missing or ambiguous ledgers", () => {
  const fixture = fs.mkdtempSync(path.join(root, ".finding-discovery-"));
  try {
    assert.throws(() => findLedger(fixture), /Retain exactly one/);
    const archived = path.join(fixture, "milestones", "v2.2");
    fs.mkdirSync(archived, { recursive: true });
    fs.writeFileSync(path.join(archived, ledgerName), markdown);
    assert.equal(findLedger(fixture), path.join(archived, ledgerName));
    fs.writeFileSync(path.join(fixture, ledgerName), markdown);
    assert.throws(() => findLedger(fixture), /Retain exactly one/);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

function validateRelease(release, ledger, foundPath = ledgerPath) {
  const rows = validateLedger(ledger);
  const lines = release.split("\n");
  const records = lines.filter((line) => /^- \[[A-Z0-9-]+\]/.test(line));
  assert.equal(
    records.length,
    expectedIds.length,
    "every release record must retain one individual link",
  );
  assert.deepEqual(
    records.map((line) => line.match(/^- \[([^\]]+)\]/)[1]),
    expectedIds,
    "release IDs must be complete, ungrouped and ordered",
  );
  records.forEach((line, index) => {
    const [id, , , status, , , limit] = rows[index];
    const link = line.match(/^- \[([^\]]+)\]\(([^)]+)\): \*\*([a-z-]+)\*\*/);
    assert.ok(link, id + " individual release status/link required");
    assert.equal(
      link[3],
      status,
      id + " release disposition must agree with ledger",
    );
    const [relative, anchor, extra] = link[2].split("#");
    assert.equal(extra, undefined);
    assert.equal(anchor, id.toLowerCase(), id + " exact row backlink required");
    assert.equal(
      path.resolve(root, ".planning", relative),
      foundPath,
      id + " release must link to retained ledger location",
    );
    assert.ok(fs.existsSync(foundPath), "release ledger target must exist");
    assert.ok(
      line.includes("Evidence: "),
      id + " named release evidence required",
    );
    assert.ok(
      line.includes("Limitation: "),
      id + " release limitation required",
    );
    for (const phrase of protectedLimits[id] ?? [])
      assert.ok(
        line.includes(phrase),
        id + " release boundary removed: " + phrase,
      );
    if (id === "P9-D-09-07") {
      assert.ok(
        line.includes(limit),
        "release observation must preserve investigation limits",
      );
      assert.match(line, /Unidentified and unreproduced in 14 runs/);
    }
  });
  for (const phrase of [
    "does not certify an unobserved CI run or npm publication",
    "owner roundtrip",
    "Plan 18-06",
  ])
    assert.ok(
      release.includes(phrase),
      "release evidence scope removed: " + phrase,
    );
}
const release = fs.readFileSync(
  path.join(root, ".planning/RELEASE-FOLLOWUPS.md"),
  "utf8",
);
const releaseLedgerPrefix = path
  .relative(path.join(root, ".planning"), ledgerPath)
  .split(path.sep)
  .join("/");
test("release summaries link every individual row and preserve retained limits", () => {
  validateRelease(release, markdown);
});
for (const [name, poisoned] of [
  ["missing release item", release.replace(/^- \[P8-WR-02\].*\n/m, "")],
  ["wrong row backlink", release.replace("#p9-d-09-07", "#p9-d-09-01")],
  [
    "release observation relabeled",
    release.replace(
      /(\[P9-D-09-07\].*?): \*\*observation\*\*/,
      "$1: **fixed**",
    ),
  ],
  [
    "release accepted boundary omitted",
    release.replace("MDK legacy-marker read fallback", "removed"),
  ],
  [
    "release ledger lost after archival",
    release.replaceAll(releaseLedgerPrefix, "missing-ledger.md"),
  ],
  [
    "unobserved CI limitation erased",
    release.replace(
      "does not certify an unobserved CI run or npm publication",
      "all gates certify publication",
    ),
  ],
]) {
  test("rejects " + name, () =>
    assert.throws(() => validateRelease(poisoned, markdown)),
  );
}
