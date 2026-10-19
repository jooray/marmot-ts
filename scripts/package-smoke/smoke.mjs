// Packed-tarball consumer smoke test for @internet-privacy/marmot-ts.
//
// Runs unchanged under Node, Bun and Deno against a real `npm install` of the
// packed tarball (see run.sh). It checks every manifest runtime entry and signs a
// KeyPackage's required 0x8009 account identity proof with a signer built
// from explicitly declared consumer crypto dependencies, validating that proof, then
// creating a real one-member Marmot group and encoding its GroupContext with
// the fork-only groupContextEncoder.
//
// All runtime fixtures are local; no live Nostr or HTTP service is required.

import { entrypoints } from "./entrypoints.mjs";
import * as marmotTs from "@internet-privacy/marmot-ts";
import {
  defaultCryptoProvider,
  encode,
  getCiphersuiteImpl,
  groupContextEncoder,
} from "@internet-privacy/marmot-ts/mls";
import {
  createCredential,
  createSimpleGroup,
  generateKeyPackage,
  validateKeyPackageAccountIdentityProof,
  buildGroupImageAad,
  canonicalizeGroupImageMediaType,
  encodeGroupBlossomImage,
  decodeGroupBlossomImage,
  encryptGroupImage,
  decryptGroupImage,
  getGroupImageSource,
  getGroupImageSnapshotIdentity,
} from "@internet-privacy/marmot-ts/core";
import {
  GroupImageService,
  fetchGroupImageTransport,
} from "@internet-privacy/marmot-ts/client";
import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";

function assert(condition, message) {
  if (!condition) {
    throw new Error(`package smoke assertion failed: ${message}`);
  }
}

assert(
  typeof marmotTs.MarmotClient === "function",
  "MarmotClient is not exported as a function from the root entrypoint",
);

const anchors = {
  ".": "MarmotClient",
  "./mls": "groupContextEncoder",
  "./client": "GroupImageService",
  "./core": "createSimpleGroup",
  "./engine": "MarmotGroupEngine",
  "./audit": "noopAuditSink",
  "./extra": "InMemoryKeyValueStore",
  "./extra/audit/node": "NodeJsonlAuditRecorder",
  "./extra/audit/browser": "AutoBrowserAuditWriter",
  "./utils": "normalizeRelayUrl",
};
const namespaces = {};
assert(
  entrypoints.length === Object.keys(anchors).length,
  "ten runtime entries required",
);
for (const { key, specifier, keys } of entrypoints) {
  assert(
    Object.hasOwn(anchors, key) && !Object.hasOwn(namespaces, key),
    `unexpected/duplicate entry ${key}`,
  );
  const namespace = await import(specifier);
  const anchor = anchors[key];
  const value = namespace[anchor];
  assert(
    key === "./audit"
      ? typeof value?.record === "function"
      : typeof value === "function",
    `${key} must export meaningful ${anchor}`,
  );
  assert(
    JSON.stringify(Object.keys(namespace).sort()) === JSON.stringify(keys),
    `${key} packed keys differ from current build`,
  );
  namespaces[key] = namespace;
  console.log(
    `package smoke entry OK: ${key} (${anchor}, ${keys.length} keys)`,
  );
}
for (const [key, names] of [
  [
    "./client",
    ["MarmotClient", "GroupImageService", "fetchGroupImageTransport"],
  ],
  [
    "./core",
    ["createSimpleGroup", "marmotAuthService", "encodeGroupBlossomImage"],
  ],
  ["./engine", ["MarmotGroupEngine"]],
  ["./utils", ["normalizeRelayUrl"]],
]) {
  for (const name of names)
    assert(
      marmotTs[name] === namespaces[key][name],
      `root/${key} identity mismatch: ${name}`,
    );
}
assert(
  namespaces["./audit"].safeAuditSink(undefined) ===
    namespaces["./audit"].noopAuditSink,
  "audit default sink identity",
);
assert(
  namespaces["./mls"].groupContextEncoder === groupContextEncoder,
  "MLS encoder identity",
);

const store = new namespaces["./extra"].InMemoryKeyValueStore();
await store.setItem("packed", "consumer");
assert((await store.getItem("packed")) === "consumer", "extra store roundtrip");
await store.removeItem("packed");
assert((await store.getItem("packed")) === null, "extra store removal");
assert(
  namespaces["./utils"].normalizeRelayUrl("wss://relay.example") ===
    "wss://relay.example/",
  "utils URL normalization",
);
assert(
  namespaces["./audit"].noopAuditSink.record({ kind: "package-smoke" }) ===
    undefined,
  "audit noop sink behavior",
);
assert(
  typeof namespaces["./engine"].MarmotGroupEngine.prototype.ingest ===
    "function",
  "engine ingestion API",
);
// Platform entries expose callable methods without inventing browser storage in
// Node/Bun/Deno. Their actual storage behavior belongs to their platform suites.
assert(
  typeof namespaces["./extra/audit/node"].NodeJsonlAuditRecorder.prototype
    .record === "function",
  "Node recorder API",
);
assert(
  typeof namespaces["./extra/audit/browser"].AutoBrowserAuditWriter.open ===
    "function",
  "browser writer factory API",
);

// A deterministic throwaway smoke-test key. It controls nothing of value and
// this script is not in package.json's `files`, so it never ships in the
// tarball.
const SMOKE_SECRET_KEY = hexToBytes("01".repeat(32));
const pubkey = bytesToHex(schnorr.getPublicKey(SMOKE_SECRET_KEY));

// Satisfies AuthorizationProofSigner (Pick<EventSigner, "signEvent">) from
// src/core/authorization-proof.ts using only @noble/curves and @noble/hashes
// -- explicitly declared by the isolated consumer, also used by marmot-ts at
// runtime. A nested install cannot borrow the library's private dependencies.
// Deliberately does not use the devDependency
// account-signer helper this repo's own tests rely on
// (src/__tests__/helpers/test-accounts.ts, backed by applesauce-accounts): a
// real consumer would not have that package, and depending on it here would
// mask exactly the class of bug this smoke exists to catch. produceAuthorizationProof
// re-verifies the returned event's id and BIP-340 signature, so this must
// produce a genuine signature, not a stub.
const smokeSigner = {
  async signEvent(draft) {
    const event = { ...draft, pubkey };
    const id = bytesToHex(
      sha256(
        utf8ToBytes(
          JSON.stringify([
            0,
            event.pubkey,
            event.created_at,
            event.kind,
            event.tags,
            event.content,
          ]),
        ),
      ),
    );
    const sig = bytesToHex(schnorr.sign(hexToBytes(id), SMOKE_SECRET_KEY));
    return { ...event, id, sig };
  },
};

const impl = await getCiphersuiteImpl(
  "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
  defaultCryptoProvider,
);

const credential = createCredential(pubkey);
const kp = await generateKeyPackage({
  credential,
  ciphersuiteImpl: impl,
  signer: smokeSigner,
});

// Throws AccountIdentityProofError if the shipped 0x8009 proof path is broken
// in the packed build.
validateKeyPackageAccountIdentityProof(kp.publicPackage);

const { clientState } = await createSimpleGroup(kp, impl, "Package Smoke", {
  adminPubkeys: [pubkey],
  relays: [],
});

assert(
  clientState.groupContext.epoch === 0n,
  `expected fresh group epoch 0n, got ${clientState.groupContext.epoch}`,
);

const encoded = encode(groupContextEncoder, clientState.groupContext);
assert(
  encoded instanceof Uint8Array && encoded.length > 0,
  "encode(groupContextEncoder, groupContext) did not return a non-empty Uint8Array",
);

assert(
  marmotTs.GroupImageService === GroupImageService,
  "root/client image service mismatch",
);
assert(
  marmotTs.fetchGroupImageTransport === fetchGroupImageTransport,
  "root/client image transport mismatch",
);
assert(
  marmotTs.encodeGroupBlossomImage === encodeGroupBlossomImage,
  "root/core image codec mismatch",
);
const emptyImage = encodeGroupBlossomImage({ kind: "empty" });
assert(
  bytesToHex(emptyImage) === "0000000000",
  "image clear must have five empty field prefixes",
);
assert(
  decodeGroupBlossomImage(emptyImage).kind === "empty",
  "empty image codec roundtrip",
);
assert(
  canonicalizeGroupImageMediaType("IMAGE/PNG") === "image/png",
  "image MIME canonicalization",
);
assert(
  bytesToHex(buildGroupImageAad("image/png")) ===
    bytesToHex(utf8ToBytes("marmot-group-image-v1\0image/png")),
  "image AAD wire bytes",
);
assert(
  getGroupImageSource(clientState).kind === "none",
  "fresh group's canonical source should be none",
);
const plaintext = Uint8Array.of(0, 1, 2, 255);
const image = encryptGroupImage(plaintext, "image/png");
const imageMetadata = decodeGroupBlossomImage(
  encodeGroupBlossomImage(image.metadata),
);
assert(imageMetadata.kind === "present", "present image codec roundtrip");
assert(
  bytesToHex(decryptGroupImage(image.ciphertext, imageMetadata)) ===
    bytesToHex(plaintext),
  "image crypto roundtrip",
);
assert(
  getGroupImageSnapshotIdentity(imageMetadata) ===
    getGroupImageSnapshotIdentity(image.metadata),
  "complete image snapshot survives wire encoding",
);
const service = new GroupImageService({
  getState: () => clientState,
  isClosed: () => false,
});
assert(
  service.source().kind === "none",
  "packed image service canonical source",
);
const noImage = await service.read({
  endpoints: ["https://images.example.com"],
});
assert(
  noImage.kind === "unavailable" && noImage.reason === "no-image",
  "none must return typed unavailable without HTTP",
);
service.close();
assert(service.closedSignal.aborted, "packed service close signal");

const runtime = globalThis.Deno
  ? "Deno"
  : globalThis.Bun
    ? "Bun"
    : `node ${typeof process !== "undefined" ? process.version : "unknown"}`;

console.log(`package smoke OK (${runtime})`);
