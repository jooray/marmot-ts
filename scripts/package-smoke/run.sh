#!/usr/bin/env bash
set -euo pipefail

# Packed-tarball consumer smoke: packs the library, verifies the tarball, npm-installs it
# into a fresh throwaway project, and runs the runtime smoke on Node (always), Bun and Deno
# (when available), plus a type-level consumer check under nodenext and bundler resolution.
#
# This script never builds the library itself; run `pnpm build` before invoking it.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
# An override is a parent for a unique throwaway directory, never a directory
# whose existing contents this script may delete. Resolve symlinks before use.
WORK="$(node --input-type=module - "$ROOT" "${PACKAGE_SMOKE_WORKDIR:-}" <<'JS'
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const [rootArg, override] = process.argv.slice(2);
const root = fs.realpathSync(rootArg);
const parent = fs.realpathSync(override || os.tmpdir());
const contains = (base, target) => target === base || target.startsWith(base + path.sep);
if (contains(root, parent) || contains(parent, root)) {
  throw new Error(`package-smoke: consumer parent must be outside checkout ancestry: ${parent}`);
}
console.log(fs.mkdtempSync(path.join(parent, "marmot-package-smoke-")));
JS
)"
trap 'rm -rf -- "$WORK"' EXIT
echo "package-smoke: external consumer root $WORK/consumer"
echo "package-smoke: tools Node $(node --version), npm $(npm --version), pnpm $(pnpm --version)"

if [ ! -f "$ROOT/dist/vendor/ts-mls/index.js" ]; then
  echo "package-smoke: $ROOT/dist/vendor/ts-mls/index.js not found. Run \"pnpm build\" first." >&2
  exit 1
fi

mkdir -p "$WORK/pack" "$WORK/consumer"

echo "package-smoke: packing tarball..."
(cd "$ROOT" && pnpm pack --pack-destination "$WORK/pack") >/dev/null

tgz_count=$(find "$WORK/pack" -maxdepth 1 -name '*.tgz' | wc -l | tr -d ' ')
if [ "$tgz_count" -ne 1 ]; then
  echo "package-smoke: expected exactly one .tgz in $WORK/pack, found $tgz_count" >&2
  exit 1
fi
TGZ="$(find "$WORK/pack" -maxdepth 1 -name '*.tgz')"

echo "package-smoke: verifying tarball contents..."
node "$ROOT/scripts/verify-package-tarball.mjs" --tarball "$TGZ"

echo "package-smoke: explicit manifest-derived dependencies; install-strategy=nested, omit=peer"
node --input-type=module - "$ROOT/package.json" "$TGZ" "$WORK/consumer/package.json" <<'JS'
import fs from "node:fs";
const [manifestPath, tarball, output] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const dependencies = {
  [manifest.name]: `file:${tarball}`,
  "@noble/curves": manifest.dependencies["@noble/curves"],
  "@noble/hashes": manifest.dependencies["@noble/hashes"],
  typescript: manifest.devDependencies.typescript,
};
for (const [name, range] of Object.entries(dependencies)) {
  if (typeof range !== "string" || !range) throw new Error(`Missing explicit range: ${name}`);
  console.log(`package-smoke: declared ${name} ${range}`);
}
fs.writeFileSync(output, JSON.stringify({ private: true, type: "module", dependencies }, null, 2));
JS
(
  cd "$WORK/consumer"
  npm install --install-strategy=nested --omit=peer --no-audit --no-fund >/dev/null
)

(cd "$WORK/consumer" && node --input-type=module <<'JS'
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = fs.realpathSync(process.cwd());
const forbidden = new Set([
  "ts-mls", "@hpke/chacha20poly1305", "@hpke/dhkem-x448",
  "@hpke/hybridkem-x-wing", "@hpke/ml-kem", "@noble/post-quantum",
]);
const visited = new Set();
let directories = 0;
function walk(directory) {
  const real = fs.realpathSync(directory);
  if (!real.startsWith(root + path.sep)) throw new Error(`Dependency escapes consumer: ${directory} -> ${real}`);
  for (const name of forbidden) {
    const segment = `${path.sep}node_modules${path.sep}${name.replaceAll("/", path.sep)}`;
    if (real.endsWith(segment) || real.includes(segment + path.sep)) throw new Error(`Forbidden dependency directory: ${real}`);
  }
  if (visited.has(real)) return;
  visited.add(real);
  directories++;
  const manifestPath = path.join(real, "package.json");
  if (fs.existsSync(manifestPath)) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    if (forbidden.has(manifest.name)) throw new Error(`Forbidden dependency package: ${real} (${manifest.name})`);
  }
  for (const entry of fs.readdirSync(real, { withFileTypes: true })) {
    const child = path.join(real, entry.name);
    if (entry.isDirectory() || (entry.isSymbolicLink() && fs.statSync(child).isDirectory())) walk(child);
  }
}
walk(path.join(root, "node_modules"));
console.log(`package-smoke: zero forbidden/optional dependency directories (${directories} directories scanned)`);
const manifestFile = fileURLToPath(import.meta.resolve("@internet-privacy/marmot-ts/package.json"));
const packageRoot = fs.realpathSync(path.dirname(manifestFile));
const mlsEntry = fs.realpathSync(fileURLToPath(import.meta.resolve("@internet-privacy/marmot-ts/mls")));
const vendor = fs.realpathSync(path.join(packageRoot, "dist/vendor/ts-mls/index.js"));
if (!mlsEntry.startsWith(packageRoot + path.sep) || !vendor.startsWith(packageRoot + path.sep)) throw new Error("MLS resolution escapes installed package");
const mlsSource = fs.readFileSync(mlsEntry, "utf8");
if (!mlsSource.includes('"./vendor/ts-mls/index.js"')) throw new Error("MLS entry does not re-export vendored fork");
console.log(`package-smoke: installed MLS ${mlsEntry} -> ${vendor}`);
for (const name of ["@internet-privacy/marmot-ts", "@noble/curves", "@noble/hashes", "typescript"]) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "node_modules", name, "package.json"), "utf8"));
  console.log(`package-smoke: installed ${name}@${manifest.version}`);
  if (name === "typescript" && !manifest.version.startsWith("6.")) throw new Error("TypeScript 6 is required");
}
// A runtime dependency must remain below the library, not appear via hoisting.
const nestedCore = path.join(packageRoot, "node_modules/@hpke/core/package.json");
if (!fs.existsSync(nestedCore) || fs.existsSync(path.join(root, "node_modules/@hpke/core"))) throw new Error("Expected unhoisted nested HPKE core");
console.log(`package-smoke: nested dependency proof ${nestedCore}`);
JS
)

# Read the installed manifest for the inventory, and the current build for
# expected namespace keys. Source export tests independently audit that build.
node --input-type=module - "$ROOT" "$WORK/consumer" <<'JS'
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
const [root, consumer] = process.argv.slice(2);
const original = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const packageRoot = path.join(consumer, "node_modules", original.name);
const installed = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
const entries = Object.entries(installed.exports).filter(([key]) => key !== "./package.json");
const expected = [".", "./mls", "./client", "./core", "./engine", "./audit", "./extra", "./extra/audit/node", "./extra/audit/browser", "./utils"];
if (JSON.stringify(entries.map(([key]) => key).sort()) !== JSON.stringify(expected.sort())) throw new Error("Installed runtime inventory differs from the ten-entry contract");
const inventory = [];
for (const [key, target] of entries) {
  const sourceTarget = original.exports[key];
  if (typeof target !== "object" || typeof sourceTarget !== "object" ||
      typeof target.import !== "string" || typeof target.types !== "string" ||
      target.import !== sourceTarget.import || target.types !== sourceTarget.types) {
    throw new Error(`Installed export target mismatch: ${key}`);
  }
  for (const file of [target.import, target.types]) {
    const resolved = fs.realpathSync(path.resolve(packageRoot, file));
    if (!resolved.startsWith(fs.realpathSync(packageRoot) + path.sep)) throw new Error(`Export escapes installed package: ${key}`);
  }
  const namespace = await import(pathToFileURL(path.resolve(root, sourceTarget.import)).href);
  inventory.push({ key, specifier: key === "." ? installed.name : installed.name + key.slice(1), keys: Object.keys(namespace).sort() });
}
fs.writeFileSync(path.join(consumer, "entrypoints.mjs"), `export const entrypoints = ${JSON.stringify(inventory, null, 2)};\n`);
console.log(`package-smoke: installed manifest runtime inventory (${inventory.length} entries): ${inventory.map(({ key }) => key).join(", ")}`);
JS

cp "$SCRIPT_DIR/smoke.mjs" "$WORK/consumer/smoke.mjs"
cp "$SCRIPT_DIR/consumer.ts" "$WORK/consumer/consumer.ts"
cp "$SCRIPT_DIR/legacy-negative.ts" "$WORK/consumer/legacy-negative.ts"
cp "$SCRIPT_DIR/tsconfig.nodenext.json" "$WORK/consumer/tsconfig.nodenext.json"
cp "$SCRIPT_DIR/tsconfig.bundler.json" "$WORK/consumer/tsconfig.bundler.json"

echo "package-smoke: running Node runtime smoke..."
(cd "$WORK/consumer" && node smoke.mjs)

echo "package-smoke: type-checking consumer under nodenext..."
(cd "$WORK/consumer" && ./node_modules/.bin/tsc -p tsconfig.nodenext.json)

echo "package-smoke: type-checking consumer under bundler..."
(cd "$WORK/consumer" && ./node_modules/.bin/tsc -p tsconfig.bundler.json)

echo "package-smoke: standalone five legacy-type negatives (installed TypeScript 6, --ignoreConfig)..."
(cd "$WORK/consumer" && ./node_modules/.bin/tsc --ignoreConfig --noEmit --strict --target ES2022 --lib ES2022,DOM --module NodeNext --moduleResolution NodeNext --skipLibCheck true legacy-negative.ts)
echo "package-smoke: strict consumer contracts passed; skipLibCheck=true retains the dependency-declaration checking limit"

if command -v bun >/dev/null 2>&1; then
  echo "package-smoke: running Bun $(bun --version) runtime smoke..."
  (cd "$WORK/consumer" && bun smoke.mjs)
elif [ "${PACKAGE_SMOKE_REQUIRE_BUN:-0}" = "1" ]; then
  echo "package-smoke: bun is required (PACKAGE_SMOKE_REQUIRE_BUN=1) but was not found on PATH" >&2
  exit 1
else
  echo "package-smoke: bun not found on PATH, skipping Bun runtime smoke"
fi

if command -v deno >/dev/null 2>&1; then
  echo "package-smoke: running Deno runtime smoke..."
  deno --version
  (cd "$WORK/consumer" && deno run -A --node-modules-dir=manual smoke.mjs)
elif [ "${PACKAGE_SMOKE_REQUIRE_DENO:-0}" = "1" ]; then
  echo "package-smoke: deno is required (PACKAGE_SMOKE_REQUIRE_DENO=1) but was not found on PATH" >&2
  exit 1
else
  echo "package-smoke: deno not found on PATH, skipping Deno runtime smoke"
fi

echo "package-smoke: PASSED"
