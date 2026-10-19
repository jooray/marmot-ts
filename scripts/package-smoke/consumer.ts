// Type-level consumer contract for @internet-privacy/marmot-ts. Compiled (not run) under
// both nodenext and bundler module resolution to prove the packed tarball's declaration
// files resolve correctly and are not silently degraded to `any`.

import {
  MarmotClient,
  MarmotGroupEngine as RootGroupEngine,
  type AuditSink as RootAuditSink,
  normalizeRelayUrl as rootNormalizeRelayUrl,
  GroupImageService as RootGroupImageService,
  marmotAuthService as rootAuthService,
  type GroupImageProfile as RootImageProfile,
  type GroupImageReadResult as RootImageReadResult,
  type GroupImageMutationResult as RootImageMutationResult,
} from "@internet-privacy/marmot-ts";
import {
  createSimpleGroup,
  marmotAuthService as coreAuthService,
  encodeGroupBlossomImage,
  decodeGroupBlossomImage,
  encryptGroupImage,
  decryptGroupImage,
  getGroupImageSource,
  getGroupImageSnapshotIdentity,
  isApplicationMessage,
  isCommitMessage,
  isProposalMessage,
  type GroupMessagePair,
  type GroupBlossomImage,
  type GroupBlossomImagePresent,
  type EncryptedGroupImage,
  type GroupImageSource,
  type GroupImageSnapshotIdentity,
} from "@internet-privacy/marmot-ts/core";
import {
  GroupImageService,
  fetchGroupImageTransport,
  type MarmotGroup,
  type GroupImageProfile,
  type GroupImageContactPolicy,
  type GroupImageTransport,
  type GroupImageTransportRequest,
  type GroupImageTransportResponse,
  type GroupImageReadResult,
  type GroupImageUnavailableReason,
  type GroupImageOperationOptions,
  type GroupImageReplacementResult,
  type GroupImageClearResult,
  type GroupImagePublicationResult,
} from "@internet-privacy/marmot-ts/client";
import {
  encode,
  groupContextEncoder,
  wireformats,
  type ClientState,
  type GroupContext,
  type AuthenticationService,
} from "@internet-privacy/marmot-ts/mls";
import { MarmotGroupEngine } from "@internet-privacy/marmot-ts/engine";
import {
  noopAuditSink,
  type AuditSink,
} from "@internet-privacy/marmot-ts/audit";
import { InMemoryKeyValueStore } from "@internet-privacy/marmot-ts/extra";
import { NodeJsonlAuditRecorder } from "@internet-privacy/marmot-ts/extra/audit/node";
import {
  AutoBrowserAuditWriter,
  type AutoBrowserAuditWriterOptions,
} from "@internet-privacy/marmot-ts/extra/audit/browser";
import { normalizeRelayUrl } from "@internet-privacy/marmot-ts/utils";

// Exact type equality supplements runtime object identity; bidirectional
// assignments alone would accept some structurally wider declaration mistakes.
type IsAny<T> = 0 extends 1 & T ? true : false;
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
type Assert<T extends true> = T;
export type EntrypointIdentities = [
  Assert<Equal<IsAny<MarmotClient>, false>>,
  Assert<Equal<IsAny<GroupImageService>, false>>,
  Assert<Equal<IsAny<typeof createSimpleGroup>, false>>,
  Assert<Equal<IsAny<typeof groupContextEncoder>, false>>,
  Assert<Equal<IsAny<MarmotGroupEngine<unknown>>, false>>,
  Assert<Equal<IsAny<AuditSink>, false>>,
  Assert<Equal<IsAny<InMemoryKeyValueStore<string>>, false>>,
  Assert<Equal<IsAny<NodeJsonlAuditRecorder>, false>>,
  Assert<Equal<IsAny<AutoBrowserAuditWriter>, false>>,
  Assert<Equal<IsAny<typeof normalizeRelayUrl>, false>>,
  Assert<Equal<typeof RootGroupEngine, typeof MarmotGroupEngine>>,
  Assert<Equal<typeof RootGroupImageService, typeof GroupImageService>>,
  Assert<Equal<RootAuditSink, AuditSink>>,
  Assert<Equal<typeof rootNormalizeRelayUrl, typeof normalizeRelayUrl>>,
  Assert<Equal<typeof rootAuthService, typeof coreAuthService>>,
  Assert<Equal<RootImageProfile, GroupImageProfile>>,
  Assert<Equal<RootImageReadResult, GroupImageReadResult>>,
  Assert<Equal<CoreState, ClientState>>,
];

export const auditContract: AuditSink = noopAuditSink;
export const relayContract: string = normalizeRelayUrl("wss://relay.example");
export async function extraStoreContract(): Promise<string | null> {
  const store = new InMemoryKeyValueStore<string>();
  await store.setItem("packed", "consumer");
  const keys: string[] = await store.keys();
  return keys.length ? store.getItem(keys[0]!) : null;
}
export function nodeRecorderContract(path: string): NodeJsonlAuditRecorder {
  const recorder = new NodeJsonlAuditRecorder(path);
  const sink: AuditSink = recorder;
  // @ts-expect-error - AuditSink must preserve its event contract.
  sink.record(42);
  return recorder;
}
export async function browserWriterContract(
  options: AutoBrowserAuditWriterOptions,
): Promise<AutoBrowserAuditWriter> {
  const writer = await AutoBrowserAuditWriter.open(options);
  await writer.appendLine("packed consumer");
  return writer;
}
export function engineStateContract(
  engine: MarmotGroupEngine<unknown>,
): ClientState {
  return engine.state;
}

// Every remaining entry has a negative contract: `any` would make these
// expect-error directives unused, and a wrong entry would lose its named anchor.
// @ts-expect-error - Engine state cannot be a number.
export const engineGuard: MarmotGroupEngine<unknown> = 42;
// @ts-expect-error - Audit sink requires record(event).
export const auditGuard: AuditSink = 42;
// @ts-expect-error - Extra store retains its generic value contract.
new InMemoryKeyValueStore<string>().setItem("packed", 42);
// @ts-expect-error - Node recorder requires a string path.
new NodeJsonlAuditRecorder(42);
export type BrowserBackend = AutoBrowserAuditWriterOptions["backend"];
// @ts-expect-error - Browser writer backend discriminant is closed.
export const browserGuard: BrowserBackend = "disk";
// @ts-expect-error - Utility URL normalization requires a string.
normalizeRelayUrl(42);

export function commitSourceEpoch(pair: GroupMessagePair): bigint | undefined {
  if (!isCommitMessage(pair)) return undefined;
  // @ts-expect-error - A successful handshake guard is not private-only.
  pair.message.privateMessage;
  switch (pair.message.wireformat) {
    case wireformats.mls_public_message:
      return pair.message.publicMessage.content.epoch;
    case wireformats.mls_private_message:
      return pair.message.privateMessage.epoch;
    default: {
      const exhaustive: never = pair.message;
      return exhaustive;
    }
  }
}

export function proposalContentType(
  pair: GroupMessagePair,
): number | undefined {
  if (!isProposalMessage(pair)) return undefined;
  // @ts-expect-error - Public fields also require a carriage branch.
  pair.message.publicMessage;
  switch (pair.message.wireformat) {
    case wireformats.mls_public_message:
      return pair.message.publicMessage.content.contentType;
    case wireformats.mls_private_message:
      return pair.message.privateMessage.contentType;
    default: {
      const exhaustive: never = pair.message;
      return exhaustive;
    }
  }
}

export function applicationCiphertext(
  pair: GroupMessagePair,
): Uint8Array | undefined {
  if (!isApplicationMessage(pair)) return undefined;
  // @ts-expect-error - Application classification excludes public carriage.
  pair.message.publicMessage;
  return pair.message.privateMessage.ciphertext;
}

// Both supported surfaces must expose the actual vendored MLS policy contract.
export const publicAuthServices: AuthenticationService[] = [
  rootAuthService,
  coreAuthService,
];

// @ts-expect-error - The policy must retain its credential/key types, not become `any`.
coreAuthService.validateCredential(42, new Uint8Array());

// @ts-expect-error - The root export must retain the same typed policy contract.
rootAuthService.validateCredential(42, new Uint8Array());

export function encodeGroupContext(gc: GroupContext): Uint8Array {
  return encode(groupContextEncoder, gc);
}

// `/core` and `/mls` must resolve to the exact same vendored ClientState declaration.
// CoreState is derived from `/core`'s createSimpleGroup return type; the two identity
// functions below only type-check if CoreState and ClientState are the same type.
export type CoreState = Awaited<
  ReturnType<typeof createSimpleGroup>
>["clientState"];

export function coreStateToClientState(state: CoreState): ClientState {
  return state;
}

export function clientStateToCoreState(state: ClientState): CoreState {
  return state;
}

// Non-any guards: if any of these types silently degrade to `any` under skipLibCheck,
// assigning a bare number to them stops being an error, the `@ts-expect-error` directive
// above it becomes unused, and tsc fails on "Unused '@ts-expect-error' directive".

// @ts-expect-error - ClientState is not `any`; a number is not assignable to it.
export const clientStateGuard: ClientState = 42;

// @ts-expect-error - GroupContext is not `any`; a number is not assignable to it.
export const groupContextGuard: GroupContext = 42;

// @ts-expect-error - MarmotClient is not `any`; a number is not assignable to it.
export const marmotClientGuard: MarmotClient = 42;

// Realistic image calls use public entries, the same owner and explicit routing.
export const imageContactPolicy: GroupImageContactPolicy = ({ url }) =>
  new URL(url).origin === "https://images.example.com";
export const imageProfile: RootImageProfile & GroupImageProfile = {
  endpoints: ["https://images.example.com"],
  transport: fetchGroupImageTransport,
  contactPolicy: imageContactPolicy,
  maxUploadBytes: 1024 * 1024,
  maxDownloadBytes: 1024 * 1024 + 16,
  maxDiagnosticBytes: 1024,
  maxEndpointCandidates: 4,
  deadlineMs: 30_000,
};

export const imageResolverProfile: GroupImageProfile = {
  async resolveEndpoints(source: GroupImageSource, signal: AbortSignal) {
    if (signal.aborted || source.kind === "none") return [];
    return ["https://images.example.com"];
  },
};

export const imageTransport: GroupImageTransport = async (
  request: GroupImageTransportRequest,
): Promise<GroupImageTransportResponse> => fetchGroupImageTransport(request);

export function imageCodecRoundtrip(bytes: Uint8Array): Uint8Array {
  const encrypted: EncryptedGroupImage = encryptGroupImage(bytes, "image/png");
  const metadata: GroupBlossomImage = decodeGroupBlossomImage(
    encodeGroupBlossomImage(encrypted.metadata),
  );
  if (metadata.kind === "empty") throw new Error("Unexpected empty metadata");
  const present: GroupBlossomImagePresent = metadata;
  const identity: GroupImageSnapshotIdentity =
    getGroupImageSnapshotIdentity(present);
  if (!identity) throw new Error("Missing snapshot identity");
  return decryptGroupImage(encrypted.ciphertext, present);
}

export function sameOwnerImageService(group: MarmotGroup): GroupImageService {
  return new GroupImageService({
    getState: () => group.state,
    isClosed: () => group.closedSignal.aborted,
    maxCacheEntries: 0,
    maxCacheBytes: 0,
    maxActiveReads: 2,
  });
}

export async function readImage(
  group: MarmotGroup,
  signal: AbortSignal,
): Promise<RootImageReadResult & GroupImageReadResult> {
  const source: GroupImageSource = getGroupImageSource(group.state);
  if (source.kind === "none")
    return { kind: "unavailable", reason: "no-image" };
  if (source.kind === "url")
    return { kind: "unavailable", reason: "url-selected" };
  const options: GroupImageOperationOptions = { signal };
  const result = await group.image.read(imageProfile, options);
  if (result.kind === "unavailable") {
    const reason: GroupImageUnavailableReason = result.reason;
    return { kind: "unavailable", reason };
  }
  const current = group.image.source();
  if (
    current.kind !== "blossom" ||
    current.snapshotIdentity !== result.snapshotIdentity
  )
    return { kind: "unavailable", reason: "stale" };
  const bytes: Uint8Array = result.bytes;
  const mediaType: string = result.mediaType;
  return { ...result, bytes, mediaType };
}

export async function replaceAndClearImage(
  client: MarmotClient,
  group: MarmotGroup,
  bytes: Uint8Array,
  signal: AbortSignal,
): Promise<RootImageMutationResult> {
  const replaced: GroupImageReplacementResult =
    await client.groups.replaceGroupImage(
      group.id,
      bytes,
      "image/png",
      imageProfile,
      { signal },
    );
  if (replaced.kind === "published") {
    for (const publication of replaced.publications) {
      const existingResult: GroupImagePublicationResult = publication;
      if (existingResult.retryPublication) return replaced;
    }
  }
  const cleared: GroupImageClearResult = await client.groups.clearGroupImage(
    group.id,
  );
  return cleared;
}

// Non-any guards protect the discriminants, opaque identity and typed profile.
// @ts-expect-error - The profile is not any and does not select a built-in default server.
export const imageProfileGuard: GroupImageProfile = 42;
// @ts-expect-error - Only the stable unavailable union is accepted.
export const imageReasonGuard: GroupImageUnavailableReason = "unknown";
// @ts-expect-error - Read results require bytes, MIME and complete snapshot identity.
export const imageReadGuard: GroupImageReadResult = { kind: "available" };
// @ts-expect-error - The opaque fingerprint cannot be a caller-invented string.
export const imageIdentityGuard: GroupImageSnapshotIdentity = "invented";
