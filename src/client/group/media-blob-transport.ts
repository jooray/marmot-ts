/** @module @category Client - Group Media */
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { base64 } from "@scure/base";
import type { EventSigner } from "applesauce-core";
import { rejectNonRoutableHost } from "../../core/components/host-safety.js";
import type { MediaBlobTransport } from "./media-transfer.js";

export interface BlossomMediaTransportOptions {
  signer: EventSigner;
  /**
   * Contact-time permission, checked before signing or fetching. Defaults to
   * HTTPS, rejecting non-routable literal hosts and localhost. A callback can allow local
   * development endpoints. DNS resolution is controlled by the fetch/network
   * implementation; use a resolver-aware fetch or egress policy to restrict it.
   */
  allowDestination?: (url: URL) => boolean;
  fetch?: typeof globalThis.fetch;
}
function defaultDestination(url: URL): boolean {
  if (url.protocol !== "https:") return false;
  try {
    rejectNonRoutableHost(url.hostname, "Media destination");
    return true;
  } catch {
    return false;
  }
}

/** Bounded BUD-01/02 adapter. Redirects, browser credentials and caching are disabled. */
export function createBlossomMediaTransport(
  options: BlossomMediaTransportOptions,
): MediaBlobTransport {
  const fetcher = options.fetch ?? globalThis.fetch;
  const allow = options.allowDestination ?? defaultDestination;
  function destinationFor(url: string): URL {
    const parsed = new URL(url);
    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      !parsed.hostname ||
      parsed.username ||
      parsed.password ||
      parsed.href.includes("#") ||
      !allow(new URL(parsed.href))
    )
      throw new Error("Media destination contact denied");
    return parsed;
  }
  async function request(
    url: string,
    signal: AbortSignal,
    maxBytes: number,
    init: RequestInit = {},
  ) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)
      throw new Error("Invalid media byte limit");
    destinationFor(url);
    signal.throwIfAborted();
    const response = await fetcher(url, {
      ...init,
      signal,
      redirect: "error",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      cache: "no-store",
    });
    if (!response.ok || response.redirected || !response.body) {
      void response.body?.cancel().catch(() => undefined);
      throw new Error("Media HTTP request failed");
    }
    const reader = response.body.getReader();
    try {
      const length = response.headers.get("content-length");
      if (
        length !== null &&
        (!/^\d+$/.test(length) || Number(length) > maxBytes)
      )
        throw new Error("Media response exceeds byte limit");
      let size = 0;
      let bytes = new Uint8Array(Math.min(maxBytes, 65536));
      for (;;) {
        signal.throwIfAborted();
        const { done, value } = await reader.read();
        signal.throwIfAborted();
        if (done) break;
        if (value.length > maxBytes - size)
          throw new Error("Media response exceeds byte limit");
        if (size + value.length > bytes.length) {
          const grown = new Uint8Array(
            Math.min(maxBytes, Math.max(size + value.length, bytes.length * 2)),
          );
          grown.set(bytes.subarray(0, size));
          bytes = grown;
        }
        bytes.set(value, size);
        size += value.length;
      }
      return bytes.slice(0, size);
    } finally {
      void reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
  return {
    async fetch({ url, signal, maxBytes }) {
      return request(url, signal, maxBytes);
    },
    async upload({ baseUrl, data, ciphertextSha256, signal, maxBytes }) {
      if (
        !Number.isSafeInteger(maxBytes) ||
        maxBytes <= 0 ||
        data.byteLength > maxBytes
      )
        throw new Error("Media upload exceeds byte limit");
      signal.throwIfAborted();
      // Validate the endpoint before appending a path: query/fragment syntax
      // must not turn /upload into part of a query or fragment.
      const endpoint = destinationFor(baseUrl);
      if (endpoint.href.includes("?") || endpoint.href.includes("#"))
        throw new Error("Invalid Blossom upload endpoint");
      const url = baseUrl.replace(/\/+$/, "") + "/upload";
      const destination = destinationFor(url);
      const uploadData = data.slice();
      const hash = bytesToHex(sha256(uploadData));
      if (ciphertextSha256.toLowerCase() !== hash)
        throw new Error("Media upload ciphertext hash mismatch");
      // All endpoint and input checks precede the external signer.
      const now = Math.floor(Date.now() / 1000);
      const event = await options.signer.signEvent({
        kind: 24242,
        content: "Upload encrypted media",
        created_at: now,
        tags: [
          ["t", "upload"],
          ["x", hash],
          ["expiration", String(now + 600)],
          ["server", destination.hostname],
        ],
      });
      const result = await request(url, signal, 16 * 1024, {
        method: "PUT",
        headers: {
          "content-type": "application/octet-stream",
          "x-sha-256": hash,
          authorization:
            "Nostr " +
            base64.encode(new TextEncoder().encode(JSON.stringify(event))),
        },
        body: uploadData as Uint8Array<ArrayBuffer>,
      });
      const descriptor: unknown = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(result),
      );
      if (
        !descriptor ||
        typeof descriptor !== "object" ||
        Array.isArray(descriptor)
      )
        throw new Error("Invalid Blossom upload descriptor");
      if (
        "sha256" in descriptor &&
        (typeof descriptor.sha256 !== "string" ||
          descriptor.sha256.toLowerCase() !== hash)
      )
        throw new Error("Blossom upload descriptor hash mismatch");
      const value = "url" in descriptor ? descriptor.url : undefined;
      if (value === undefined || value === "")
        return baseUrl.replace(/\/+$/, "") + "/" + hash;
      if (typeof value !== "string" || !URL.canParse(value))
        throw new Error("Invalid Blossom upload descriptor URL");
      const locator = new URL(value);
      if (!["http:", "https:"].includes(locator.protocol))
        throw new Error("Invalid Blossom upload descriptor URL");
      // Explicit locators need not contain a hash (features/encrypted-media.md).
      // If one is encoded in the path, it must identify this ciphertext.
      const encodedHash = locator.pathname
        .match(/(?<![a-fA-F0-9])[a-fA-F0-9]{64}(?![a-fA-F0-9])/g)
        ?.at(-1);
      if (encodedHash && encodedHash.toLowerCase() !== hash)
        throw new Error("Blossom upload descriptor URL hash mismatch");
      return value;
    },
  };
}
