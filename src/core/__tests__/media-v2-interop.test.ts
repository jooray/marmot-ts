/** Shared MDK fixture and vectors; adapted from PR #83 by Juraj Bednar. */
import { describe, expect, it } from "vitest";
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import imetaV2Fixture from "../../../refs/mdk/fixtures/encrypted-media/imeta-v2.json" with { type: "json" };
import {
  parseMediaAttachment,
  parseMediaImetaTag,
  encodeMediaImetaTag,
  getMediaAttachmentOutcomes,
  MediaAttachmentRejection,
  deriveMediaFileKey,
  decryptMediaFile,
  decryptMediaFileV1,
  ENCRYPTED_MEDIA_VERSION,
  ENCRYPTED_MEDIA_VERSION_V1,
  type MediaAttachment,
} from "../media.js";

type FixtureCase = {
  name: string;
  valid: boolean;
  tag: string[];
  rejection_kind?: string;
  error_contains?: string;
  expected?: {
    version: string;
    locators: { kind: string; value: string }[];
    ciphertext_sha256: string;
    plaintext_sha256: string;
    nonce_hex: string;
    media_type: string;
    file_name: string;
    dim: string | null;
    thumbhash: string | null;
  };
};

const CASES = (imetaV2Fixture as { cases: FixtureCase[] }).cases;

describe("MDK shared imeta-v2 fixture", () => {
  it("has the expected schema", () => {
    expect((imetaV2Fixture as { schema: string }).schema).toBe(
      "mdk-encrypted-media-imeta-fixture/v1",
    );
    expect(CASES.length).toBeGreaterThan(0);
  });

  for (const testCase of CASES) {
    it(`${testCase.name}: ${testCase.valid ? "accepts" : `rejects (${testCase.rejection_kind})`}`, () => {
      if (!testCase.valid) {
        let caught: unknown;
        try {
          parseMediaAttachment(testCase.tag);
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(MediaAttachmentRejection);
        const rejection = caught as MediaAttachmentRejection;
        expect(rejection.kind).toBe(testCase.rejection_kind);
        expect(rejection.message).toContain(testCase.error_contains);
        return;
      }

      const expected = testCase.expected!;
      const parsed = parseMediaAttachment(testCase.tag);
      expect(parsed).toEqual({
        version: expected.version,
        locators: expected.locators,
        ciphertextSha256: expected.ciphertext_sha256,
        plaintextSha256: expected.plaintext_sha256,
        nonce: expected.nonce_hex,
        mediaType: expected.media_type,
        filename: expected.file_name,
        ...(expected.dim !== null ? { dim: expected.dim } : {}),
        ...(expected.thumbhash !== null
          ? { thumbhash: expected.thumbhash }
          : {}),
      });
      // Exact wire round-trip, including present-empty optional fields.
      expect(encodeMediaImetaTag(parsed)).toEqual(testCase.tag);
    });
  }
});

describe("encrypted-media-v2 key derivation and AEAD", () => {
  // MDK encrypted_media_v2_kdf_and_aad_are_independent_from_v1.
  const secret = new Uint8Array(32).fill(7);
  const fields = {
    plaintextSha256: "22".repeat(32),
    mediaType: "image/jpeg",
    filename: " Photo.JPG ",
  };
  const MDK_V2_KEY =
    "5fcb5672b9cb2b3ac7915fd9c97697877837f7fb1312034486f400f601cd16b5";
  const MDK_V2_AAD =
    "656e637279707465642d6d656469612d763200222222222222222222222222222222222222222222222222222222222222222200696d6167652f6a706567002050686f746f2e4a504720";

  it("matches MDK's v2 file-key vector", () => {
    const v2 = deriveMediaFileKey(secret, fields);
    expect(bytesToHex(v2)).toBe(MDK_V2_KEY);
  });

  it("decrypts a blob sealed with MDK's v2 AAD bytes", () => {
    const plaintext = new TextEncoder().encode("hello from MDK");
    const plaintextSha256 = bytesToHex(sha256(plaintext));
    const key = deriveMediaFileKey(secret, {
      ...fields,
      plaintextSha256,
    });
    // Rebuild MDK's AAD layout for this plaintext hash.
    const aad = hexToBytes(
      MDK_V2_AAD.replace("22".repeat(32), plaintextSha256),
    );
    const nonce = new Uint8Array(12).fill(3);
    const encrypted = chacha20poly1305(key, nonce, aad).encrypt(plaintext);
    const attachment: MediaAttachment = {
      version: ENCRYPTED_MEDIA_VERSION,
      locators: [],
      ciphertextSha256: bytesToHex(sha256(encrypted)),
      plaintextSha256,
      nonce: bytesToHex(nonce),
      mediaType: fields.mediaType,
      filename: fields.filename,
    };
    expect(decryptMediaFile(encrypted, key, attachment)).toEqual(plaintext);
    // The same bytes never open as v1.
    expect(() =>
      decryptMediaFileV1(encrypted, key, {
        ...attachment,
        version: ENCRYPTED_MEDIA_VERSION_V1,
      }),
    ).toThrow(/did not authenticate/);
  });
});

describe("attachment diagnostics", () => {
  const valid = imetaV2Fixture.cases.find((item) => item.valid)!.tag;

  it("preserves imeta positions and valid siblings after a rejection", () => {
    const outcomes = getMediaAttachmentOutcomes([
      ["subject", "caption"],
      [...valid, "filename duplicate"],
      valid,
      ["imeta", "v future-format"],
    ]);
    expect(outcomes).toMatchObject([
      {
        kind: "rejected",
        attachmentIndex: 0,
        rejection: { kind: "duplicate_field" },
      },
      { kind: "accepted", attachmentIndex: 1 },
      {
        kind: "rejected",
        attachmentIndex: 2,
        rejection: { kind: "unsupported_format" },
      },
    ]);
    if (outcomes[0].kind === "rejected")
      expect(outcomes[0].rejection).toBeInstanceOf(MediaAttachmentRejection);
  });

  it("keeps the nullable parser and current-profile version boundary", () => {
    const historical = valid.map((field) =>
      field === "v encrypted-media-v2" ? "v encrypted-media-v1" : field,
    );
    expect(parseMediaImetaTag(historical)).toBeNull();
    expect(() => parseMediaAttachment(historical)).toThrow(
      expect.objectContaining({ kind: "unsupported_format" }),
    );
    expect(() => parseMediaAttachment(["not-imeta"])).toThrow(
      expect.objectContaining({ kind: "invalid_structure" }),
    );
  });
});
