/** @module @category Client - Group Images */
import { bytesToHex } from "@noble/hashes/utils.js";
import type { ClientState } from "ts-mls";
import {
  decryptGroupImage,
  getGroupImageSource,
  getGroupImageSnapshotIdentity,
  GroupImageIntegrityError,
  type GroupImageSource,
  type GroupImageSnapshotIdentity,
} from "../../core/group-image.js";
import {
  fetchGroupImageTransport,
  GroupImageRequestError,
  normalizeGroupImageEndpoint,
  validateGroupImageRequestUrl,
  validateGroupImageUploadRequest,
  type GroupImageTransport,
  type GroupImageTransportRequest,
  type GroupImageTransportResponse,
} from "./group-image-transport.js";
import type { GroupPublishResult } from "../session/group-effects.js";

export interface GroupImageProfile {
  endpoints?: readonly string[];
  resolveEndpoints?: (
    source: GroupImageSource,
    signal: AbortSignal,
  ) => Promise<readonly string[]>;
  transport?: GroupImageTransport;
  maxDownloadBytes?: number;
  maxUploadBytes?: number;
  maxDescriptorBytes?: number;
  maxDiagnosticBytes?: number;
  maxEndpointCandidates?: number;
  deadlineMs?: number;
  /** Called again for every request and before delivery; false refuses contact. */
  contactPolicy?: GroupImageContactPolicy;
}
export type GroupImageContactPolicy = (
  request: { url: string; method: "GET" | "PUT" },
  signal: AbortSignal,
) => boolean | Promise<boolean>;

/** @internal Complete compatibility tuple; never weaken a caller via reuse. */
export interface EffectiveGroupImageReadProfile {
  endpoints: readonly string[];
  resolverOutcome: "configured" | "resolved";
  transport: GroupImageTransport;
  contactPolicy?: GroupImageContactPolicy;
  authorization: readonly boolean[];
  maxDownloadBytes: number;
  maxUploadBytes: number;
  maxDescriptorBytes: number;
  maxDiagnosticBytes: number;
  maxEndpointCandidates: number;
  deadlineMs: number;
  /** Provenance for future cache entries and in-flight operations. */
  compatibilityKey: string;
}
const profileIdentities = new WeakMap<object, number>();
let nextProfileIdentity = 0;
function identity(value: object | undefined): number {
  if (!value) return 0;
  let id = profileIdentities.get(value);
  if (!id) {
    id = ++nextProfileIdentity;
    profileIdentities.set(value, id);
  }
  return id;
}

/** @internal Evaluate this caller before any cache lookup or shared admission. */
export async function effectiveGroupImageReadProfile(
  profile: GroupImageProfile,
  source: Extract<GroupImageSource, { kind: "blossom" }>,
  signal: AbortSignal,
): Promise<EffectiveGroupImageReadProfile> {
  const maxDownloadBytes = groupImageLimit(
    profile.maxDownloadBytes,
    10 * 1024 * 1024 + 16,
  );
  const maxUploadBytes = groupImageLimit(
    profile.maxUploadBytes,
    10 * 1024 * 1024,
  );
  const maxDescriptorBytes = groupImageLimit(
    profile.maxDescriptorBytes,
    16 * 1024,
  );
  const maxDiagnosticBytes = groupImageLimit(profile.maxDiagnosticBytes, 1024);
  const maxEndpointCandidates = groupImageLimit(
    profile.maxEndpointCandidates,
    4,
  );
  const deadlineMs = groupImageLimit(profile.deadlineMs, 60_000, 2_147_483_647);
  const endpoints = await groupImageEndpoints(profile, source, signal);
  const transport = profile.transport ?? fetchGroupImageTransport;
  const resolverOutcome = profile.resolveEndpoints ? "resolved" : "configured";
  const authorization = await Promise.all(
    endpoints.map(
      async (endpoint) =>
        (await (profile.contactPolicy?.(
          {
            url: `${endpoint}/${bytesToHex(source.metadata.imageHash)}`,
            method: "GET",
          },
          signal,
        ) ?? true)) === true,
    ),
  );
  const compatibilityKey = JSON.stringify([
    endpoints,
    resolverOutcome,
    identity(profile.resolveEndpoints),
    identity(transport),
    identity(profile.contactPolicy),
    authorization,
    maxDownloadBytes,
    maxUploadBytes,
    maxDescriptorBytes,
    maxDiagnosticBytes,
    maxEndpointCandidates,
    deadlineMs,
  ]);
  return {
    endpoints,
    resolverOutcome,
    transport,
    contactPolicy: profile.contactPolicy,
    authorization,
    maxDownloadBytes,
    maxUploadBytes,
    maxDescriptorBytes,
    maxDiagnosticBytes,
    maxEndpointCandidates,
    deadlineMs,
    compatibilityKey,
  };
}

/** @internal One budget including resolver, policy, transport and body reading. */
export async function withGroupImageBudget<T>(
  profile: GroupImageProfile,
  options: GroupImageOperationOptions,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const deadlineMs = groupImageLimit(profile.deadlineMs, 60_000, 2_147_483_647);
  const expiresAt = performance.now() + deadlineMs;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    const interrupted = new Promise<never>((_, reject) => {
      onAbort = () => {
        controller.abort();
        reject(new GroupImageRequestError("cancelled"));
      };
      options.signal?.addEventListener("abort", onAbort, { once: true });
      if (options.signal?.aborted) onAbort();
      timer = setTimeout(() => {
        controller.abort();
        reject(new GroupImageRequestError("deadline"));
      }, deadlineMs);
    });
    if (options.signal?.aborted) return await interrupted;
    const result = await Promise.race([
      operation(controller.signal),
      interrupted,
    ]);
    if (performance.now() >= expiresAt)
      throw new GroupImageRequestError("deadline");
    return result;
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) options.signal?.removeEventListener("abort", onAbort);
    controller.abort();
  }
}
export type GroupImageUnavailableReason =
  | "no-image"
  | "url-selected"
  | "endpoint-absent"
  | "missing-blob"
  | "contact-denied"
  | "byte-limit"
  | "deadline"
  | "transport"
  | "invalid-response"
  | "hash-mismatch"
  | "aead-failure"
  | "cancelled"
  | "stale"
  | "closed";
export type GroupImageReadResult =
  | {
      kind: "available";
      bytes: Uint8Array;
      mediaType: string;
      snapshotIdentity: GroupImageSnapshotIdentity;
    }
  | { kind: "unavailable"; reason: GroupImageUnavailableReason };
export interface GroupImageOperationOptions {
  signal?: AbortSignal;
}
export type GroupImageMutationResult =
  | { kind: "published"; publications: GroupPublishResult[] }
  | { kind: "unavailable"; reason: GroupImageUnavailableReason };
export type GroupImageReplacementResult = GroupImageMutationResult;
export type GroupImageClearResult = GroupImageMutationResult;

export function groupImageLimit(
  value: number | undefined,
  fallback: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximum)
    throw new GroupImageRequestError("byte-limit");
  return limit;
}

export async function groupImageEndpoints(
  profile: GroupImageProfile,
  source: GroupImageSource,
  signal: AbortSignal,
): Promise<string[]> {
  if (signal.aborted) throw new GroupImageRequestError("cancelled");
  const maximum = groupImageLimit(profile.maxEndpointCandidates, 4);
  const endpoints = profile.resolveEndpoints
    ? await profile.resolveEndpoints(source, signal)
    : (profile.endpoints ?? []);
  if (signal.aborted) throw new GroupImageRequestError("cancelled");
  if (!Array.isArray(endpoints))
    throw new GroupImageRequestError("contact-denied");
  if (endpoints.length === 0)
    throw new GroupImageRequestError("endpoint-absent");
  if (endpoints.length > maximum)
    throw new GroupImageRequestError("contact-denied");
  return [...new Set(endpoints.map(normalizeGroupImageEndpoint))];
}

/** Deadline also covers custom transports that do not settle after abort. */
export async function requestGroupImage(
  profile: GroupImageProfile,
  request: Omit<GroupImageTransportRequest, "signal" | "deadlineMs">,
  options: GroupImageOperationOptions = {},
): Promise<GroupImageTransportResponse> {
  profile = { ...profile };
  validateGroupImageRequestUrl(request.url, request.method);
  groupImageLimit(request.maxBytes, 1);
  const maxUploadBytes = groupImageLimit(
    profile.maxUploadBytes,
    10 * 1024 * 1024,
  );
  if (request.body && request.body.length > maxUploadBytes + 16)
    throw new GroupImageRequestError("byte-limit");
  request = {
    ...request,
    headers: { ...request.headers },
    body: request.body?.slice(),
  };
  validateGroupImageUploadRequest(request);
  groupImageLimit(profile.maxDownloadBytes, 10 * 1024 * 1024 + 16);
  groupImageLimit(profile.maxDescriptorBytes, 16 * 1024);
  const maxDiagnosticBytes = groupImageLimit(profile.maxDiagnosticBytes, 1024);
  const deadlineMs = groupImageLimit(profile.deadlineMs, 60_000, 2_147_483_647);
  const expiresAt = performance.now() + deadlineMs;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    const interrupted = new Promise<never>((_, reject) => {
      onAbort = () => {
        controller.abort();
        reject(new GroupImageRequestError("cancelled"));
      };
      options.signal?.addEventListener("abort", onAbort, { once: true });
      if (options.signal?.aborted) onAbort();
      timer = setTimeout(() => {
        controller.abort();
        reject(new GroupImageRequestError("deadline"));
      }, deadlineMs);
    });
    if (options.signal?.aborted) return await interrupted;
    const response = await Promise.race([
      (async () => {
        if (
          profile.contactPolicy &&
          (await profile.contactPolicy(
            { url: request.url, method: request.method },
            controller.signal,
          )) !== true
        )
          throw new GroupImageRequestError("contact-denied");
        if (controller.signal.aborted)
          throw new GroupImageRequestError("cancelled");
        return (profile.transport ?? fetchGroupImageTransport)({
          ...request,
          signal: controller.signal,
          deadlineMs,
          maxDiagnosticBytes,
        });
      })(),
      interrupted,
    ]);
    if (performance.now() >= expiresAt)
      throw new GroupImageRequestError("deadline");
    if (
      !response ||
      !(response.body instanceof Uint8Array) ||
      !Number.isInteger(response.status)
    )
      throw new GroupImageRequestError("invalid-response");
    const limit =
      response.status >= 200 && response.status < 300
        ? request.maxBytes
        : Math.min(request.maxBytes, maxDiagnosticBytes);
    if (response.body.length > limit)
      throw new GroupImageRequestError("byte-limit");
    return { ...response, body: response.body.slice() };
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) options.signal?.removeEventListener("abort", onAbort);
    controller.abort();
  }
}

export function groupImageUnavailable(
  error: unknown,
): GroupImageReadResult & { kind: "unavailable" } {
  return {
    kind: "unavailable",
    reason:
      error instanceof GroupImageRequestError ||
      error instanceof GroupImageReadError ||
      error instanceof GroupImageIntegrityError
        ? error.reason
        : "transport",
  };
}

class GroupImageReadError extends Error {
  constructor(readonly reason: "closed" | "stale" | "missing-blob") {
    super(`group image ${reason}`);
  }
}

/** Canonical source projection and verified image retrieval; no default persistence. */
type ImageReadSuccess = Extract<GroupImageReadResult, { kind: "available" }> & {
  ciphertextBytes: number;
};
type ImageOperation = {
  controller: AbortController;
  waiters: Set<symbol>;
  bytes?: Uint8Array;
  promise: Promise<
    ImageReadSuccess | Extract<GroupImageReadResult, { kind: "unavailable" }>
  >;
};
type ImageCacheEntry = ImageReadSuccess & {
  compatibilityKey: string;
  plaintextBytes: number;
};

function cacheCapacity(value: number | undefined, fallback: number): number {
  const capacity = value ?? fallback;
  if (!Number.isSafeInteger(capacity) || capacity < 0)
    throw new GroupImageRequestError("byte-limit");
  return capacity;
}

export class GroupImageService {
  private readonly inFlight = new Map<string, ImageOperation>();
  private readonly activeReads = new Map<GroupImageSnapshotIdentity, number>();
  private readonly plaintext = new Set<Uint8Array>();
  private readonly cache = new Map<
    GroupImageSnapshotIdentity,
    ImageCacheEntry
  >();
  private cacheBytes = 0;
  private readonly lifetime = new AbortController();
  private readonly maxCacheEntries: number;
  private readonly maxCacheBytes: number;
  private readonly maxActiveReads: number;
  constructor(
    private readonly options: {
      getState: () => ClientState;
      /** @internal Canonical snapshots retained by the session. */
      getRetainedStates?: () => Iterable<ClientState>;
      isClosed: () => boolean;
      /** Verified in-memory entries, default 16; zero disables caching. */
      maxCacheEntries?: number;
      /** Total cached plaintext bytes, default 20 MiB; zero disables caching. */
      maxCacheBytes?: number;
      /** Concurrent physical reads, default four. */
      maxActiveReads?: number;
    },
  ) {
    this.maxCacheEntries = cacheCapacity(options.maxCacheEntries, 16);
    this.maxCacheBytes = cacheCapacity(options.maxCacheBytes, 20 * 1024 * 1024);
    this.maxActiveReads = groupImageLimit(options.maxActiveReads, 4);
  }
  /** Image lifetime, also used by manager-owned uploads and identity reads. */
  get closedSignal(): AbortSignal {
    return this.lifetime.signal;
  }

  /** Release owned image work and plaintext on group teardown. Idempotent. */
  close(): void {
    if (this.lifetime.signal.aborted) return;
    this.lifetime.abort();
    for (const operation of this.inFlight.values())
      operation.controller.abort();
    this.inFlight.clear();
    for (const bytes of this.plaintext) bytes.fill(0);
    this.plaintext.clear();
    this.cache.clear();
    this.cacheBytes = 0;
  }

  /** @internal Release detached owned copies after successful session persistence. */
  retireRetained(branchStates: Iterable<ClientState> = []): void {
    if (this.isClosed() || this.cache.size === 0) return;
    const protectedIdentities = new Set(this.activeReads.keys());
    const protect = (source: GroupImageSource) => {
      if (source.kind === "blossom")
        protectedIdentities.add(getGroupImageSnapshotIdentity(source.metadata));
    };
    protect(this.source());
    for (const state of this.options.getRetainedStates?.() ?? [])
      protect(getGroupImageSource(state));
    for (const state of branchStates) protect(getGroupImageSource(state));
    for (const [snapshotIdentity, entry] of this.cache) {
      if (protectedIdentities.has(snapshotIdentity)) continue;
      this.cache.delete(snapshotIdentity);
      this.cacheBytes -= entry.plaintextBytes;
      this.forget(entry.bytes);
    }
  }
  private forget(bytes: Uint8Array): void {
    bytes.fill(0);
    this.plaintext.delete(bytes);
  }
  private isClosed(): boolean {
    if (this.options.isClosed()) this.close();
    return this.lifetime.signal.aborted;
  }
  private remember(
    value: ImageReadSuccess,
    compatibilityKey: string,
  ): ImageCacheEntry | undefined {
    if (
      !this.maxCacheEntries ||
      !this.maxCacheBytes ||
      value.bytes.length > this.maxCacheBytes
    )
      return;
    const previous = this.cache.get(value.snapshotIdentity);
    if (previous?.compatibilityKey === compatibilityKey) {
      this.cache.delete(value.snapshotIdentity);
      this.cache.set(value.snapshotIdentity, previous);
      return previous;
    }
    if (previous) {
      this.cacheBytes -= previous.plaintextBytes;
      this.cache.delete(value.snapshotIdentity);
      this.forget(previous.bytes);
    }
    const entry = {
      ...value,
      bytes: value.bytes.slice(),
      plaintextBytes: value.bytes.length,
      compatibilityKey,
    };
    this.cache.set(value.snapshotIdentity, entry);
    this.plaintext.add(entry.bytes);
    this.cacheBytes += entry.plaintextBytes;
    while (
      this.cache.size > this.maxCacheEntries ||
      this.cacheBytes > this.maxCacheBytes
    ) {
      const oldest = this.cache.keys().next().value!;
      const evicted = this.cache.get(oldest)!;
      this.cacheBytes -= evicted.plaintextBytes;
      this.cache.delete(oldest);
      this.forget(evicted.bytes);
    }
    return entry;
  }
  source(): GroupImageSource {
    return getGroupImageSource(this.options.getState());
  }
  private current(
    source: Extract<GroupImageSource, { kind: "blossom" }>,
  ): void {
    if (this.isClosed()) throw new GroupImageReadError("closed");
    const current = this.source();
    if (
      current.kind !== "blossom" ||
      getGroupImageSnapshotIdentity(current.metadata) !==
        source.snapshotIdentity
    )
      throw new GroupImageReadError("stale");
  }
  private async fetch(
    profile: GroupImageProfile,
    source: Extract<GroupImageSource, { kind: "blossom" }>,
    effective: EffectiveGroupImageReadProfile,
    signal: AbortSignal,
  ): Promise<
    ImageReadSuccess | Extract<GroupImageReadResult, { kind: "unavailable" }>
  > {
    try {
      const endpoint = effective.endpoints.find(
        (_, index) => effective.authorization[index],
      );
      if (!endpoint) throw new GroupImageRequestError("contact-denied");
      const response = await requestGroupImage(
        profile,
        {
          url: `${endpoint}/${bytesToHex(source.metadata.imageHash)}`,
          method: "GET",
          headers: {},
          maxBytes: effective.maxDownloadBytes,
        },
        { signal },
      );
      this.current(source);
      if (response.status === 404)
        throw new GroupImageReadError("missing-blob");
      if (response.status !== 200)
        throw new GroupImageRequestError("invalid-response");
      const bytes = decryptGroupImage(response.body, source.metadata);
      if (bytes.length > effective.maxUploadBytes) {
        bytes.fill(0);
        throw new GroupImageRequestError("byte-limit");
      }
      this.current(source);
      this.plaintext.add(bytes);
      return {
        kind: "available",
        bytes,
        mediaType: source.metadata.mediaType,
        snapshotIdentity: source.snapshotIdentity,
        ciphertextBytes: response.body.length,
      };
    } catch (error) {
      return groupImageUnavailable(error);
    }
  }
  private async deliver(
    value: ImageReadSuccess,
    profile: GroupImageProfile,
    source: Extract<GroupImageSource, { kind: "blossom" }>,
    effective: EffectiveGroupImageReadProfile,
    signal: AbortSignal,
    retainDelivery: (bytes: Uint8Array) => void,
  ): Promise<GroupImageReadResult> {
    // Retain private plaintext before any policy await. Cache replacement/LRU
    // and other waiters may release their backing bytes during delivery.
    const retained = value.bytes.slice();
    this.plaintext.add(retained);
    const release = () => this.forget(retained);
    signal.addEventListener("abort", release, { once: true });
    try {
      // Re-evaluate this caller, even when another waiter performed the request.
      const now = await effectiveGroupImageReadProfile(
        profile,
        structuredClone(source),
        signal,
      );
      if (
        !now.authorization.some(Boolean) ||
        now.compatibilityKey !== effective.compatibilityKey
      )
        throw new GroupImageRequestError("contact-denied");
      if (signal.aborted) throw new GroupImageRequestError("cancelled");
      if (
        value.ciphertextBytes > now.maxDownloadBytes ||
        retained.length > now.maxUploadBytes
      )
        throw new GroupImageRequestError("byte-limit");
      this.current(source);
      const bytes = retained.slice();
      retainDelivery(bytes);
      return {
        kind: "available",
        bytes,
        mediaType: value.mediaType,
        snapshotIdentity: value.snapshotIdentity,
      };
    } finally {
      signal.removeEventListener("abort", release);
      release();
    }
  }
  async read(
    profile: GroupImageProfile,
    options: GroupImageOperationOptions = {},
  ): Promise<GroupImageReadResult> {
    profile = { ...profile, endpoints: profile.endpoints?.slice() };
    if (this.isClosed()) return { kind: "unavailable", reason: "closed" };
    if (options.signal?.aborted)
      return { kind: "unavailable", reason: "cancelled" };
    const source = structuredClone(this.source());
    if (source.kind !== "blossom")
      return {
        kind: "unavailable",
        reason: source.kind === "url" ? "url-selected" : "no-image",
      };
    source.snapshotIdentity = getGroupImageSnapshotIdentity(source.metadata);
    this.activeReads.set(
      source.snapshotIdentity,
      (this.activeReads.get(source.snapshotIdentity) ?? 0) + 1,
    );
    const caller = new AbortController();
    const abort = () => caller.abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    this.lifetime.signal.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted || this.lifetime.signal.aborted) abort();
    let undelivered: Uint8Array | undefined;
    const retainDelivery = (bytes: Uint8Array) => {
      // Own the output before returning through the budget promise. Expiry or
      // cancellation of that promise must also wipe this intermediate copy.
      undelivered = bytes;
      this.plaintext.add(bytes);
    };
    try {
      const expiresAt =
        performance.now() +
        groupImageLimit(profile.deadlineMs, 60_000, 2_147_483_647);
      let verified: { value: ImageReadSuccess; key: string } | undefined;
      const result = await withGroupImageBudget(
        profile,
        { signal: caller.signal },
        async (signal): Promise<GroupImageReadResult> => {
          const effective = await effectiveGroupImageReadProfile(
            profile,
            structuredClone(source),
            signal,
          );
          if (signal.aborted) throw new GroupImageRequestError("cancelled");
          if (!effective.authorization.some(Boolean))
            throw new GroupImageRequestError("contact-denied");
          this.current(source);
          const cached = this.cache.get(source.snapshotIdentity);
          if (cached?.compatibilityKey === effective.compatibilityKey) {
            const result = await this.deliver(
              cached,
              profile,
              source,
              effective,
              signal,
              retainDelivery,
            );
            verified = { value: cached, key: effective.compatibilityKey };
            return result;
          }
          const key = `${source.snapshotIdentity}:${effective.compatibilityKey}`;
          let operation = this.inFlight.get(key);
          if (!operation) {
            if (this.inFlight.size >= this.maxActiveReads)
              throw new GroupImageRequestError("byte-limit");
            const controller = new AbortController();
            operation = {
              controller,
              waiters: new Set(),
              promise: this.fetch(
                profile,
                source,
                effective,
                controller.signal,
              ),
            };
            this.inFlight.set(key, operation);
          }
          const active = operation;
          // The result belongs to this exact operation until its last waiter
          // finishes delivery. Late settlement after abort must also wipe it.
          if (!active.waiters.size) {
            active.promise = active.promise.then((value) => {
              if (value.kind === "available") {
                active.bytes = value.bytes;
                if (!active.waiters.size || this.isClosed())
                  this.forget(value.bytes);
              }
              return value;
            });
          }
          const waiter = Symbol();
          active.waiters.add(waiter);
          const release = () => {
            active.waiters.delete(waiter);
            if (active.waiters.size === 0) {
              if (this.inFlight.get(key) === active) this.inFlight.delete(key);
              active.controller.abort();
              if (active.bytes) this.forget(active.bytes);
            }
          };
          signal.addEventListener("abort", release, { once: true });
          try {
            const result = await active.promise;
            if (result.kind === "unavailable") return result;
            const delivery = await this.deliver(
              result,
              profile,
              source,
              effective,
              signal,
              retainDelivery,
            );
            verified = { value: result, key: effective.compatibilityKey };
            return delivery;
          } finally {
            signal.removeEventListener("abort", release);
            release();
          }
        },
      );
      if (result.kind === "available") {
        undelivered = result.bytes;
        if (caller.signal.aborted)
          throw new GroupImageRequestError("cancelled");
        if (performance.now() >= expiresAt)
          throw new GroupImageRequestError("deadline");
        this.current(source);
        // Only successful caller delivery can populate the cache; a failed,
        // revoked, expired or stale waiter never warms it for future callers.
        const cached =
          verified &&
          this.remember(
            { ...verified.value, bytes: result.bytes },
            verified.key,
          );
        // Owned copies can themselves take measurable time for large images.
        if (performance.now() >= expiresAt) {
          if (cached && this.cache.get(source.snapshotIdentity) === cached) {
            this.cache.delete(source.snapshotIdentity);
            this.cacheBytes -= cached.plaintextBytes;
            this.forget(cached.bytes);
          }
          throw new GroupImageRequestError("deadline");
        }
      }
      if (this.isClosed()) return { kind: "unavailable", reason: "closed" };
      if (result.kind === "available") this.plaintext.delete(result.bytes);
      undelivered = undefined;
      return result;
    } catch (error) {
      return this.isClosed()
        ? { kind: "unavailable", reason: "closed" }
        : groupImageUnavailable(error);
    } finally {
      if (undelivered) this.forget(undelivered);
      const readers = this.activeReads.get(source.snapshotIdentity)! - 1;
      if (readers === 0) this.activeReads.delete(source.snapshotIdentity);
      else this.activeReads.set(source.snapshotIdentity, readers);
      options.signal?.removeEventListener("abort", abort);
      this.lifetime.signal.removeEventListener("abort", abort);
    }
  }
}
