#!/usr/bin/env node
// Vendors the compiled forked ts-mls build into dist/vendor/ts-mls, rewrites emitted
// module specifiers to point at the vendored copy, and guards against dependency-confusion
// or undeclared-import regressions. Run as part of `pnpm build` via `pnpm run vendor`.
//
// Uses Node.js builtins and the already-declared TypeScript build dependency.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  isForkSpecifier,
  moduleReferences,
  packageRoot,
  rewriteModuleReferences,
} from "./package-checks.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const REPO_ROOT = path.resolve(__dirname, "..");
const DIST_DIR = path.join(REPO_ROOT, "dist");
const VENDOR_DIR = path.join(DIST_DIR, "vendor", "ts-mls");
const FORK_DIR = path.join(REPO_ROOT, "ts-mls");
const FORK_DIST_SRC = path.join(FORK_DIR, "dist", "src");
const FORK_SRC = path.join(FORK_DIR, "src");
const FORK_PACKAGE_JSON = path.join(FORK_DIR, "package.json");
const ROOT_PACKAGE_JSON = path.join(REPO_ROOT, "package.json");

const FORK_NAME = "ts-mls";

function fail(message) {
  console.error(`vendor-ts-mls: ${message}`);
  process.exit(1);
}

// (a) Preconditions
function checkPreconditions() {
  const mlsJs = path.join(DIST_DIR, "mls.js");
  const forkIndexJs = path.join(FORK_DIST_SRC, "index.js");
  if (!fs.existsSync(mlsJs)) {
    fail(
      `${path.relative(REPO_ROOT, mlsJs)} does not exist. Run "pnpm build" first.`,
    );
  }
  if (!fs.existsSync(forkIndexJs)) {
    fail(
      `${path.relative(REPO_ROOT, forkIndexJs)} does not exist. Run "pnpm build" first.`,
    );
  }
}

// Manual recursive directory walk (Node 20 compatible; no fs.readdir recursive option).
function walk(dir) {
  const results = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walk(fullPath));
    } else if (entry.isFile()) {
      results.push(fullPath);
    }
  }
  return results;
}

// (b) Copy the fork output
function copyForkOutput() {
  fs.rmSync(VENDOR_DIR, { recursive: true, force: true });
  fs.mkdirSync(VENDOR_DIR, { recursive: true });

  const files = walk(FORK_DIST_SRC);
  let copiedCount = 0;

  for (const filePath of files) {
    const relPath = path.relative(FORK_DIST_SRC, filePath);
    const isDts = filePath.endsWith(".d.ts");
    const isJs = !isDts && filePath.endsWith(".js");
    if (!isDts && !isJs) {
      continue; // skip .map, tsdoc-metadata.json, anything else
    }

    // Derive the source-relative path to check for an orphan output.
    // relPath examples: "index.js", "clientState.d.ts"
    const sourceRelPath = isDts
      ? relPath.slice(0, -".d.ts".length) + ".ts"
      : relPath.slice(0, -".js".length) + ".ts";
    const sourcePath = path.join(FORK_SRC, sourceRelPath);
    if (!fs.existsSync(sourcePath)) {
      // Orphan output from an incremental build with no matching source file; skip it.
      continue;
    }

    const destPath = path.join(VENDOR_DIR, relPath);
    fs.mkdirSync(path.dirname(destPath), { recursive: true });

    let contents = fs.readFileSync(filePath, "utf8");
    if (isJs) {
      // Strip a trailing sourceMappingURL comment line since maps are not shipped.
      contents = contents.replace(/\n?\/\/# sourceMappingURL=.*\n?$/, "\n");
    }
    fs.writeFileSync(destPath, contents);
    copiedCount += 1;
  }

  return copiedCount;
}

// (c) Copy LICENSE and write VERSION
function writeLicenseAndVersion() {
  const licenseSrc = path.join(FORK_DIR, "LICENSE");
  const licenseDest = path.join(VENDOR_DIR, "LICENSE");
  if (fs.existsSync(licenseSrc)) {
    fs.copyFileSync(licenseSrc, licenseDest);
  } else {
    console.warn(
      "vendor-ts-mls: warning: ts-mls/LICENSE not found, skipping copy",
    );
  }

  const forkPkg = JSON.parse(fs.readFileSync(FORK_PACKAGE_JSON, "utf8"));

  let commit = "unknown";
  let dirtyStatus = "unknown";
  try {
    commit = execFileSync("git", ["-C", FORK_DIR, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
  } catch (err) {
    console.warn(
      `vendor-ts-mls: warning: could not determine fork commit: ${err.message}`,
    );
  }
  try {
    const status = execFileSync(
      "git",
      ["-C", FORK_DIR, "status", "--porcelain"],
      {
        encoding: "utf8",
      },
    );
    dirtyStatus = status.trim().length > 0 ? "dirty" : "clean";
  } catch (err) {
    console.warn(
      `vendor-ts-mls: warning: could not determine fork git status: ${err.message}`,
    );
  }

  const versionContents = [
    `${forkPkg.name}@${forkPkg.version}`,
    `commit: ${commit}`,
    `status: ${dirtyStatus}`,
    "",
  ].join("\n");
  fs.writeFileSync(path.join(VENDOR_DIR, "VERSION"), versionContents);
}

// Compute the relative specifier from a dist file to dist/vendor/ts-mls/index.js
function relativeVendorSpecifier(fromFile) {
  const fromDir = path.dirname(fromFile);
  const vendorIndex = path.join(VENDOR_DIR, "index.js");
  let rel = path.relative(fromDir, vendorIndex);
  // Always use POSIX separators for module specifiers.
  rel = rel.split(path.sep).join("/");
  if (!rel.startsWith(".")) {
    rel = "./" + rel;
  }
  return rel;
}

// (d) Rewrite pass over dist, excluding dist/vendor
function rewriteSpecifiers() {
  const allFiles = walk(DIST_DIR).filter(
    (f) => !f.startsWith(path.join(DIST_DIR, "vendor") + path.sep),
  );
  const targetFiles = allFiles.filter(
    (f) => f.endsWith(".js") || f.endsWith(".d.ts"),
  );

  let rewriteCount = 0;

  for (const filePath of targetFiles) {
    const original = fs.readFileSync(filePath, "utf8");
    const specifier = relativeVendorSpecifier(filePath);

    const changed = rewriteModuleReferences(filePath, original, (name) =>
      name === FORK_NAME ? specifier : undefined,
    );

    if (changed !== original) {
      fs.writeFileSync(filePath, changed);
      rewriteCount += 1;
    }
  }

  return rewriteCount;
}

// (e) Guard A: no leftover bare or subpath fork specifier outside vendor
function guardA() {
  const allFiles = walk(DIST_DIR).filter(
    (f) => !f.startsWith(path.join(DIST_DIR, "vendor") + path.sep),
  );
  const targetFiles = allFiles.filter(
    (f) => f.endsWith(".js") || f.endsWith(".d.ts"),
  );

  const hits = [];
  for (const filePath of targetFiles) {
    const contents = fs.readFileSync(filePath, "utf8");
    for (const reference of moduleReferences(filePath, contents)) {
      if (isForkSpecifier(reference.specifier, FORK_NAME)) {
        hits.push(
          `${path.relative(REPO_ROOT, filePath)}:${reference.line}:${reference.column}: "${reference.specifier}"`,
        );
      }
    }
  }

  if (hits.length > 0) {
    console.error(
      "vendor-ts-mls: Guard A failed: leftover bare/subpath fork specifiers found:",
    );
    for (const hit of hits) {
      console.error(`  ${hit}`);
    }
    process.exit(1);
  }
}

// (f) Guard B: every vendored bare import must be a declared dependency or peerDependency
function guardB() {
  const rootPkg = JSON.parse(fs.readFileSync(ROOT_PACKAGE_JSON, "utf8"));
  const allowed = new Set([
    ...Object.keys(rootPkg.dependencies || {}),
    ...Object.keys(rootPkg.peerDependencies || {}),
  ]);

  const vendorFiles = walk(VENDOR_DIR).filter(
    (f) => f.endsWith(".js") || f.endsWith(".d.ts"),
  );

  const offenders = [];
  for (const filePath of vendorFiles) {
    const contents = fs.readFileSync(filePath, "utf8");
    for (const { specifier, line, column } of moduleReferences(
      filePath,
      contents,
    )) {
      const pkgName = packageRoot(specifier);
      if (pkgName === null) continue;

      if (!allowed.has(pkgName)) {
        offenders.push(
          `${path.relative(REPO_ROOT, filePath)}:${line}:${column}: "${specifier}" (package "${pkgName}")`,
        );
      }
    }
  }

  if (offenders.length > 0) {
    const unique = [...new Set(offenders)];
    console.error(
      "vendor-ts-mls: Guard B failed: vendored code imports packages not declared as dependencies or peerDependencies:",
    );
    for (const offender of unique) {
      console.error(`  ${offender}`);
    }
    process.exit(1);
  }
}

function main() {
  checkPreconditions();
  const copiedCount = copyForkOutput();
  writeLicenseAndVersion();
  const rewriteCount = rewriteSpecifiers();
  guardA();
  guardB();
  console.log(
    `vendor-ts-mls: copied ${copiedCount} files, rewrote ${rewriteCount} files`,
  );
}

main();
