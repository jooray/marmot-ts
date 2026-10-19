import { describe, expect, it } from "vitest";
import {
  contentTypes,
  defaultProposalTypes,
  encode,
  mlsMessageEncoder,
  protocolVersions,
  senderTypes,
  wireformats,
  type MlsPrivateMessage,
  type MlsPublicMessage,
  type ContentTypeValue,
  type MlsMessage,
} from "ts-mls";
import type { GroupMessagePair } from "../group-message-crypto.js";
import {
  isApplicationMessage,
  isCommitMessage,
  isProposalMessage,
  sortGroupCommits,
} from "../group-message-classify.js";
import { commitDigest } from "../convergence.js";

function privateCommit(epoch: bigint, marker = 1): MlsPrivateMessage {
  return {
    version: protocolVersions.mls10,
    wireformat: wireformats.mls_private_message,
    privateMessage: {
      groupId: new Uint8Array([1]),
      epoch,
      contentType: contentTypes.commit,
      authenticatedData: new Uint8Array(),
      encryptedSenderData: new Uint8Array([2]),
      ciphertext: new Uint8Array([marker]),
    },
  };
}

function publicCommit(epoch: bigint, marker = 1): MlsPublicMessage {
  return {
    version: protocolVersions.mls10,
    wireformat: wireformats.mls_public_message,
    publicMessage: {
      senderType: senderTypes.member,
      membershipTag: new Uint8Array([marker]),
      content: {
        groupId: new Uint8Array([1]),
        epoch,
        sender: { senderType: senderTypes.member, leafIndex: 0 },
        authenticatedData: new Uint8Array(),
        contentType: contentTypes.commit,
        commit: { proposals: [], path: undefined },
      },
      auth: {
        contentType: contentTypes.commit,
        signature: new Uint8Array([3]),
        confirmationTag: new Uint8Array([4]),
      },
    },
  };
}

function pair(
  message: GroupMessagePair["message"],
  id = "a",
  createdAt = 0,
): GroupMessagePair {
  return {
    event: {
      id,
      pubkey: "b",
      created_at: createdAt,
      kind: 445,
      tags: [],
      content: "",
      sig: "c",
    },
    message,
  };
}

function framedMessage(
  carriage: "public" | "private",
  contentType: ContentTypeValue,
  epoch = 0n,
): MlsPrivateMessage | MlsPublicMessage {
  if (carriage === "private") {
    const message = privateCommit(epoch);
    message.privateMessage.contentType = contentType;
    return message;
  }
  const message = publicCommit(epoch);
  const fields = message.publicMessage.content;
  message.publicMessage.content =
    contentType === contentTypes.commit
      ? fields
      : contentType === contentTypes.proposal
        ? {
            ...fields,
            contentType,
            proposal: {
              proposalType: defaultProposalTypes.remove,
              remove: { removed: 0 },
            },
          }
        : { ...fields, contentType, applicationData: new Uint8Array([5]) };
  message.publicMessage.auth =
    contentType === contentTypes.commit
      ? message.publicMessage.auth
      : { contentType, signature: new Uint8Array([3]) };
  return message;
}

// Rejection must happen before inspecting or encoding unsupported payloads.
// These getters expose an accidental payload read without mocking any helper.
const nonframedMessages: [string, MlsMessage][] = [
  [
    "Welcome",
    {
      version: protocolVersions.mls10,
      wireformat: wireformats.mls_welcome,
      get welcome(): never {
        throw new Error("Unexpected Welcome payload access");
      },
    },
  ],
  [
    "GroupInfo",
    {
      version: protocolVersions.mls10,
      wireformat: wireformats.mls_group_info,
      get groupInfo(): never {
        throw new Error("Unexpected GroupInfo payload access");
      },
    },
  ],
  [
    "KeyPackage",
    {
      version: protocolVersions.mls10,
      wireformat: wireformats.mls_key_package,
      get keyPackage(): never {
        throw new Error("Unexpected KeyPackage payload access");
      },
    },
  ],
];

describe("group message helpers", () => {
  it("tracer recognizes a public commit", () => {
    expect(isCommitMessage(pair(publicCommit(2n)))).toBe(true);
  });

  it("tracer orders mixed carriage commits by actual source epoch", () => {
    const earlier = pair(privateCommit(1n));
    const later = pair(publicCommit(2n));
    expect(sortGroupCommits([later, earlier])).toEqual([earlier, later]);
  });

  describe.each(["public", "private"] as const)("%s carriage", (carriage) => {
    it.each([
      ["commit", contentTypes.commit, false, true, false],
      ["proposal", contentTypes.proposal, false, false, true],
      [
        "application",
        contentTypes.application,
        carriage === "private",
        false,
        false,
      ],
    ] as const)(
      "classifies %s content",
      (_name, type, application, commit, proposal) => {
        const message = pair(framedMessage(carriage, type));
        expect(isApplicationMessage(message)).toBe(application);
        expect(isCommitMessage(message)).toBe(commit);
        expect(isProposalMessage(message)).toBe(proposal);
      },
    );

    it.each([
      ["negative", -1n],
      ["unsafe", BigInt(Number.MAX_SAFE_INTEGER) + 1n],
    ] as const)(
      "rejects %s epochs before returning an order",
      (_name, epoch) => {
        const valid = pair(privateCommit(0n));
        const invalid = pair(
          framedMessage(carriage, contentTypes.commit, epoch),
        );
        const input = [valid, invalid];
        expect(() => sortGroupCommits(input)).toThrow(
          /source epoch.*0.*MAX_SAFE_INTEGER/,
        );
        expect(input).toEqual([valid, invalid]);
      },
    );
  });

  it.each(nonframedMessages)(
    "rejects %s carriage and classifies it as no framed content",
    (_name, message) => {
      const input = pair(message);
      expect(isApplicationMessage(input)).toBe(false);
      expect(isCommitMessage(input)).toBe(false);
      expect(isProposalMessage(input)).toBe(false);
      expect(() => sortGroupCommits([pair(privateCommit(0n)), input])).toThrow(
        /Unsupported MLS wire format/,
      );
    },
  );

  it("accepts zero and maximum safe epochs for both carriages", () => {
    const messages = [
      pair(publicCommit(BigInt(Number.MAX_SAFE_INTEGER))),
      pair(privateCommit(0n)),
      pair(privateCommit(BigInt(Number.MAX_SAFE_INTEGER))),
      pair(publicCommit(0n)),
    ];
    const sorted = sortGroupCommits(messages);
    expect(sorted.slice(0, 2)).toEqual(
      expect.arrayContaining([messages[1], messages[3]]),
    );
    expect(sorted.slice(2)).toEqual(
      expect.arrayContaining([messages[0], messages[2]]),
    );
  });

  it("orders equal epochs by canonical MLS bytes independently of carriage and envelope metadata", () => {
    const messages = [
      publicCommit(5n, 1),
      privateCommit(5n, 7),
      publicCommit(5n, 8),
      privateCommit(5n, 2),
    ];
    const digest = (message: MlsMessage) =>
      Array.from(commitDigest(encode(mlsMessageEncoder, message)))
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
    const expected = [...messages].sort((a, b) =>
      digest(a).localeCompare(digest(b)),
    );
    for (const arrival of [
      messages,
      [...messages].reverse(),
      [messages[2], messages[0], messages[3], messages[1]],
    ]) {
      const input = arrival.map((message, index) =>
        pair(message, String(100 - index), 500 - index),
      );
      expect(sortGroupCommits(input).map(({ message }) => message)).toEqual(
        expected,
      );
      const changedEnvelope = input.map(({ message }, index) =>
        pair(message, String(index), index),
      );
      expect(
        sortGroupCommits(changedEnvelope).map(({ message }) => message),
      ).toEqual(expected);
    }
  });

  it("returns a distinct array and preserves input order and pair identities", () => {
    const later = pair(privateCommit(9n));
    const earlier = pair(publicCommit(2n));
    const input = [later, earlier];
    Object.freeze(input);
    const sorted = sortGroupCommits(input);
    expect(sorted).not.toBe(input);
    expect(input).toEqual([later, earlier]);
    expect(sorted[0]).toBe(earlier);
    expect(sorted[1]).toBe(later);
  });

  it("returns a distinct empty array", () => {
    const input: GroupMessagePair[] = [];
    expect(sortGroupCommits(input)).toEqual([]);
    expect(sortGroupCommits(input)).not.toBe(input);
  });
});
