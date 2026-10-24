import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { base64 } from "@scure/base";
import { describe, expect, it, vi } from "vitest";
import { createBlossomMediaTransport } from "../media-blob-transport.js";
import { testAccount } from "../../../__tests__/helpers/test-accounts.js";

describe("bounded media blob transport", () => {
  it("does not contact a locally denied destination", async () => {
    const fetcher = vi.fn();
    const transport = createBlossomMediaTransport({
      signer: testAccount(6).signer,
      fetch: fetcher,
    });
    await expect(
      transport.fetch({
        url: "http://127.0.0.1/blob",
        signal: new AbortController().signal,
        maxBytes: 20,
      }),
    ).rejects.toThrow(/denied/);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("bounds streaming responses and disables redirects and credentials", async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(11));
              controller.close();
            },
          }),
        ),
    );
    const transport = createBlossomMediaTransport({
      signer: testAccount(6).signer,
      fetch: fetcher,
    });
    await expect(
      transport.fetch({
        url: "https://example.com/blob",
        signal: new AbortController().signal,
        maxBytes: 10,
      }),
    ).rejects.toThrow(/byte limit/);
    expect(fetcher.mock.calls[0][1]).toMatchObject({
      redirect: "error",
      credentials: "omit",
      cache: "no-store",
    });
  });
  it("preserves base paths on authenticated uploads and exact descriptor URLs", async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({ url: "https://example.com/custom?blob=1" }),
        ),
    );
    const transport = createBlossomMediaTransport({
      signer: testAccount(6).signer,
      fetch: fetcher,
    });
    expect(
      await transport.upload({
        baseUrl: "https://example.com/files/",
        data: Uint8Array.of(1),
        ciphertextSha256: bytesToHex(sha256(Uint8Array.of(1))),
        signal: new AbortController().signal,
        maxBytes: 20,
      }),
    ).toBe("https://example.com/custom?blob=1");
    expect(fetcher.mock.calls[0][0]).toBe("https://example.com/files/upload");
    expect(fetcher.mock.calls[0][1]).toMatchObject({
      method: "PUT",
      headers: { authorization: expect.stringMatching(/^Nostr /) },
    });
  });
});

describe("Blossom upload validation", () => {
  const data = Uint8Array.of(1, 2, 3);
  const hash = bytesToHex(sha256(data));
  function request(baseUrl = "https://example.com/files/") {
    return {
      baseUrl,
      data,
      ciphertextSha256: hash,
      signal: new AbortController().signal,
      maxBytes: 20,
    };
  }
  function setup(descriptor: unknown = {}) {
    const signer = testAccount(6).signer;
    const sign = vi.fn(signer.signEvent.bind(signer));
    const fetcher = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify(descriptor)),
    );
    const transport = createBlossomMediaTransport({
      signer: { signEvent: sign, getPublicKey: () => signer.getPublicKey() },
      fetch: fetcher,
    });
    return { transport, sign, fetcher };
  }

  it.each([
    "https://127.0.0.1/",
    "https://10.0.0.1/",
    "https://[::1]/",
    "https://169.254.169.254/",
    "http://example.com/",
    "https://user:password@example.com/",
    "https://example.com/#",
    "https://example.com/?",
    "ftp://example.com/",
  ])("rejects %s before signing or fetching", async (baseUrl) => {
    const { transport, sign, fetcher } = setup();
    await expect(transport.upload(request(baseUrl))).rejects.toThrow();
    expect(sign).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("validates structural safety even with a permissive destination callback", async () => {
    const sign = vi.fn();
    const fetcher = vi.fn();
    const transport = createBlossomMediaTransport({
      signer: {
        signEvent: sign,
        getPublicKey: () => testAccount(6).signer.getPublicKey(),
      },
      fetch: fetcher,
      allowDestination: () => true,
    });
    for (const url of ["ftp://example.com/", "https://user@example.com/"]) {
      await expect(transport.upload(request(url))).rejects.toThrow(/denied/);
    }
    expect(sign).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects aborted, oversized or wrongly hashed input before signing", async () => {
    const { transport, sign, fetcher } = setup();
    await expect(
      transport.upload({ ...request(), signal: AbortSignal.abort() }),
    ).rejects.toThrow();
    await expect(
      transport.upload({ ...request(), maxBytes: 2 }),
    ).rejects.toThrow(/byte limit/);
    await expect(
      transport.upload({ ...request(), ciphertextSha256: "ab".repeat(32) }),
    ).rejects.toThrow(/hash mismatch/);
    expect(sign).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("allows an explicit local development destination", async () => {
    const signer = testAccount(6).signer;
    const fetcher = vi.fn<typeof fetch>(async () => new Response("{}"));
    const transport = createBlossomMediaTransport({
      signer,
      fetch: fetcher,
      allowDestination: (url) => url.origin === "http://localhost:7790",
    });
    await expect(
      transport.upload(request("http://localhost:7790/files/")),
    ).resolves.toBe(`http://localhost:7790/files/${hash}`);
    expect(fetcher).toHaveBeenCalledWith(
      "http://localhost:7790/files/upload",
      expect.objectContaining({ redirect: "error", credentials: "omit" }),
    );
  });

  it("binds authorization and fallback URL to the exact uploaded ciphertext", async () => {
    const { transport, fetcher } = setup({ sha256: hash.toUpperCase() });
    await expect(transport.upload(request())).resolves.toBe(
      `https://example.com/files/${hash}`,
    );
    const init = fetcher.mock.calls[0][1]!;
    const headers = init.headers as Record<string, string>;
    const event = JSON.parse(
      new TextDecoder().decode(base64.decode(headers.authorization.slice(6))),
    );
    expect(event).toMatchObject({
      kind: 24242,
      tags: expect.arrayContaining([
        ["t", "upload"],
        ["x", hash],
        ["server", "example.com"],
      ]),
    });
    expect(headers["x-sha-256"]).toBe(hash);
    expect(init.body).toEqual(data);
  });

  it.each([
    { sha256: "ab".repeat(32) },
    { sha256: 123 },
    { url: `https://example.com/${"ab".repeat(32)}.bin` },
    { url: "javascript:alert(1)" },
    { url: "not a URL" },
    { url: null },
    [],
    null,
  ])("rejects an invalid descriptor %j", async (descriptor) => {
    const { transport } = setup(descriptor);
    await expect(transport.upload(request())).rejects.toThrow(/descriptor/);
  });

  it("keeps the exact matching descriptor URL including path, extension and query", async () => {
    const url = `https://cdn.example.com/media/${hash.toUpperCase()}.bin?download=1`;
    const { transport } = setup({ url, sha256: hash });
    await expect(transport.upload(request())).resolves.toBe(url);
  });

  it("does not interpret arbitrary longer hexadecimal path segments as a content hash", async () => {
    const url = `https://example.com/${"a".repeat(65)}?blob=1`;
    const { transport } = setup({ url });
    await expect(transport.upload(request())).resolves.toBe(url);
  });

  it("checks permission again after signing", async () => {
    let allowed = true;
    const signer = testAccount(6).signer;
    const fetcher = vi.fn();
    const transport = createBlossomMediaTransport({
      signer: {
        getPublicKey: () => signer.getPublicKey(),
        async signEvent(event) {
          allowed = false;
          return signer.signEvent(event);
        },
      },
      fetch: fetcher,
      allowDestination: () => allowed,
    });
    await expect(transport.upload(request())).rejects.toThrow(/denied/);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not contact the server when cancelled during signing", async () => {
    const controller = new AbortController();
    const signer = testAccount(6).signer;
    const fetcher = vi.fn();
    const transport = createBlossomMediaTransport({
      signer: {
        getPublicKey: () => signer.getPublicKey(),
        async signEvent(event) {
          controller.abort();
          return signer.signEvent(event);
        },
      },
      fetch: fetcher,
    });
    await expect(
      transport.upload({ ...request(), signal: controller.signal }),
    ).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("snapshots upload bytes before yielding to an external signer", async () => {
    const mutable = data.slice();
    const signer = testAccount(6).signer;
    const fetcher = vi.fn<typeof fetch>(async () => new Response("{}"));
    const transport = createBlossomMediaTransport({
      signer: {
        getPublicKey: () => signer.getPublicKey(),
        async signEvent(event) {
          mutable.fill(0);
          return signer.signEvent(event);
        },
      },
      fetch: fetcher,
    });
    await transport.upload({ ...request(), data: mutable });
    expect(fetcher.mock.calls[0][1]!.body).toEqual(data);
  });
});
