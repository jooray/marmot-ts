/**
 * The own-commit known-state shortcut reuses a recorded child instead of
 * replaying the commit. When the commit's proposals cannot be rebuilt off the
 * wire (a PrivateMessage commit, a non-member sender, or a reference the parent
 * no longer stages), it must still run every legality check that does not need
 * those proposals — not only the `0x8009` one (08-REVIEW round 2, WR-03). A
 * persisted pre-upgrade edge that de-leafs an admin is exactly the input class
 * the shortcut must not grandfather in.
 */
import { bytesToHex } from "@noble/hashes/utils.js";
import {
  appDataUpdateProposalType,
  appDataDictionaryExtensionType,
  bytesToBase64,
  createCommit,
  createProposal,
  contentTypes,
  defaultProposalTypes,
  getAppDataDictionary,
  makeAppDataDictionaryExtension,
  processMessage,
  proposalOrRefTypes,
  wireformats,
  type ClientState,
  type Proposal,
} from "ts-mls";
import { beforeAll, describe, expect, it } from "vitest";

import {
  seamGroup,
  snapshot,
} from "../../__tests__/helpers/engine-seam-fixtures.js";
import { getMarmotGroupView } from "../../core/client-state.js";
import { getPubkeyLeafNodeIndexes } from "../../core/group-members.js";
import {
  dropAccountIdentityProofRequirement,
  forgeKeyPackage,
} from "../../__tests__/helpers/account-identity-proof-fixtures.js";
import { testAccount } from "../../__tests__/helpers/test-accounts.js";
import { createAdminCommitPolicyCallback } from "../admin-policy.js";
import { resolveCandidateParent } from "../fork-recovery.js";
import { encodeGroupBlossomImage } from "../../core/components/blossom-image.js";
import { encodeAdminPolicyV1 } from "../../core/components/admin-policy.js";
import { encodeComponentsList } from "../../core/components/app-components-list.js";
import { getAppComponents } from "../../core/components/dictionary.js";
import {
  GROUP_BLOSSOM_IMAGE_COMPONENT_ID,
  GROUP_ADMIN_POLICY_COMPONENT_ID,
  APP_COMPONENTS_COMPONENT_ID,
  ACCOUNT_IDENTITY_PROOF_COMPONENT_ID,
  GROUP_LIFECYCLE_COMPONENT_ID,
  SAFE_AAD_COMPONENT_ID,
} from "../../core/components/ids.js";

function component(
  state: ClientState,
  id: number,
  data: Uint8Array | undefined,
): ClientState {
  const dictionary = getAppDataDictionary(state.groupContext.extensions)!;
  return {
    ...state,
    groupContext: {
      ...state.groupContext,
      extensions: state.groupContext.extensions.map((extension) =>
        extension.extensionType === appDataDictionaryExtensionType
          ? makeAppDataDictionaryExtension(
              [
                ...dictionary.filter((entry) => entry.componentId !== id),
                ...(data === undefined ? [] : [{ componentId: id, data }]),
              ].sort((a, b) => a.componentId - b.componentId),
            )
          : extension,
      ),
    },
  };
}

function imageUpdate(data: Uint8Array): Proposal {
  return {
    proposalType: appDataUpdateProposalType,
    appDataUpdate: {
      componentId: GROUP_BLOSSOM_IMAGE_COMPONENT_ID,
      operation: "update",
      update: data,
    },
  };
}

describe("known image child recovery", () => {
  let f: Awaited<ReturnType<typeof seamGroup>>;
  const present = encodeGroupBlossomImage({
    kind: "present",
    imageHash: new Uint8Array(32).fill(1),
    imageKey: new Uint8Array(32).fill(2),
    imageNonce: new Uint8Array(12).fill(3),
    imageUploadKey: new Uint8Array(32).fill(4),
    mediaType: "image/png",
  });
  beforeAll(async () => {
    f = await seamGroup();
  });

  it.each([
    APP_COMPONENTS_COMPONENT_ID,
    SAFE_AAD_COMPONENT_ID,
    GROUP_LIFECYCLE_COMPONENT_ID,
    ACCOUNT_IDENTITY_PROOF_COMPONENT_ID,
  ])(
    "preserves structural/profile guards in proposal-independent recovery for %s",
    async (id) => {
      let parent = snapshot(f.admin2Epoch1);
      if (id === SAFE_AAD_COMPONENT_ID)
        parent = component(parent, id, new Uint8Array());
      const commit = await createCommit({
        context: f.ctx,
        state: snapshot(parent),
        wireAsPublicMessage: false,
      });
      let child = component(
        commit.newState,
        APP_COMPONENTS_COMPONENT_ID,
        encodeComponentsList(
          getAppComponents(parent.groupContext.extensions)!.filter(
            (required) => required !== id,
          ),
        ),
      );
      if (id !== ACCOUNT_IDENTITY_PROOF_COMPONENT_ID)
        child = component(child, id, undefined);
      const resolution = await resolveCandidateParent({
        ciphersuite: f.impl,
        parent,
        message: commit.commit,
        callback: createAdminCommitPolicyCallback({
          ratchetTree: parent.ratchetTree,
          adminPubkeys: getMarmotGroupView(parent)!.adminPubkeys,
          ciphersuiteId: f.impl.id,
        }),
        known: { parentTag: bytesToHex(parent.confirmationTag), state: child },
      });
      expect(resolution.kind).toBe("rejected");
    },
  );

  async function resolve(options: {
    data?: Uint8Array;
    rebuilt?: boolean;
    parentAdmins?: string[];
    resultingAdmins?: string[];
    authorIndex?: number;
    privateMessage?: boolean;
    requiredImage?: boolean;
    unrequire?: boolean;
  }) {
    let parent = options.parentAdmins
      ? component(
          snapshot(f.admin2Epoch1),
          GROUP_ADMIN_POLICY_COMPONENT_ID,
          encodeAdminPolicyV1(options.parentAdmins),
        )
      : snapshot(f.admin2Epoch1);
    if (options.requiredImage) {
      parent = component(parent, GROUP_BLOSSOM_IMAGE_COMPONENT_ID, present);
      parent = component(
        parent,
        APP_COMPONENTS_COMPONENT_ID,
        encodeComponentsList([
          ...getAppComponents(parent.groupContext.extensions)!,
          GROUP_BLOSSOM_IMAGE_COMPONENT_ID,
        ]),
      );
    }
    const index = Number(parent.privatePath.leafIndex);
    const ref = bytesToBase64(new Uint8Array(32).fill(99));
    const staged = {
      proposal:
        options.data === undefined
          ? {
              proposalType:
                appDataUpdateProposalType as typeof appDataUpdateProposalType,
              appDataUpdate: {
                componentId: GROUP_BLOSSOM_IMAGE_COMPONENT_ID,
                operation: "remove" as const,
              },
            }
          : imageUpdate(options.data),
      senderLeafIndex: options.authorIndex ?? index,
    };
    parent.unappliedProposals[ref] = staged;
    const commit = await createCommit({
      context: f.ctx,
      state: snapshot(parent),
      wireAsPublicMessage: !options.privateMessage,
      extraProposals: options.unrequire
        ? [
            {
              proposalType: appDataUpdateProposalType,
              appDataUpdate: {
                componentId: APP_COMPONENTS_COMPONENT_ID,
                operation: "update",
                update: encodeComponentsList(
                  getAppComponents(parent.groupContext.extensions)!.filter(
                    (id) => id !== GROUP_BLOSSOM_IMAGE_COMPONENT_ID,
                  ),
                ),
              },
            },
          ]
        : [],
    });
    if (!options.rebuilt) parent.unappliedProposals = {};
    const child = options.resultingAdmins
      ? component(
          commit.newState,
          GROUP_ADMIN_POLICY_COMPONENT_ID,
          encodeAdminPolicyV1(options.resultingAdmins),
        )
      : commit.newState;
    const view = getMarmotGroupView(parent)!;
    return resolveCandidateParent({
      ciphersuite: f.impl,
      parent,
      message: commit.commit,
      callback: createAdminCommitPolicyCallback({
        ratchetTree: parent.ratchetTree,
        adminPubkeys: view.adminPubkeys,
        ciphersuiteId: f.impl.id,
      }),
      known: { parentTag: bytesToHex(parent.confirmationTag), state: child },
    });
  }

  it.each([false, true])(
    "supports atomic image unrequire/remove in recovery rebuilt=%s",
    async (rebuilt) => {
      expect(
        (await resolve({ requiredImage: true, unrequire: true, rebuilt })).kind,
      ).toBe("resolved");
      expect((await resolve({ requiredImage: true, rebuilt })).kind).toBe(
        "rejected",
      );
      expect(
        (
          await resolve({
            data: encodeGroupBlossomImage({ kind: "empty" }),
            requiredImage: true,
            rebuilt,
          })
        ).kind,
      ).toBe("resolved");
    },
  );
  it("rejects unauthorized removal inferred from a recorded dictionary diff", async () => {
    expect(
      (
        await resolve({
          requiredImage: true,
          unrequire: true,
          parentAdmins: [f.adminPubkey],
        })
      ).kind,
    ).toBe("rejected");
  });

  it("rejects malformed image bytes with unavailable references", async () => {
    expect((await resolve({ data: new Uint8Array([1]) })).kind).toBe(
      "rejected",
    );
  });
  it.each([false, true])(
    "accepts valid present and empty images with rebuilt=%s",
    async (rebuilt) => {
      for (const data of [present, encodeGroupBlossomImage({ kind: "empty" })])
        expect((await resolve({ data, rebuilt })).kind).toBe("resolved");
    },
  );
  it("rejects noncanonical empty bytes even for private stamped children", async () => {
    expect(
      (
        await resolve({
          data: new Uint8Array([0, 0, 0, 0, 0, 0]),
          privateMessage: true,
        })
      ).kind,
    ).toBe("rejected");
  });
  it("uses parent committer authority despite resulting promotion", async () => {
    expect(
      (
        await resolve({
          data: present,
          parentAdmins: [f.adminPubkey],
          resultingAdmins: [f.adminPubkey, f.admin2Pubkey],
        })
      ).kind,
    ).toBe("rejected");
  });
  it("retains parent admin authority despite resulting demotion", async () => {
    expect(
      (await resolve({ data: present, resultingAdmins: [f.adminPubkey] })).kind,
    ).toBe("resolved");
  });
  it("rechecks original referenced authors when rebuilding proposals", async () => {
    expect(
      (
        await resolve({
          data: present,
          rebuilt: true,
          parentAdmins: [f.admin2Pubkey],
          authorIndex: Number(f.adminEpoch1.privatePath.leafIndex),
        })
      ).kind,
    ).toBe("rejected");
  });
  it("keeps valid private stamped image children viable without actor attribution", async () => {
    expect((await resolve({ data: present, privateMessage: true })).kind).toBe(
      "resolved",
    );
  });
});

describe("D-09-08 exact known-child acceptance matrix", () => {
  let f: Awaited<ReturnType<typeof seamGroup>>;
  beforeAll(async () => {
    f = await seamGroup();
  });

  function resolve(
    message: Awaited<ReturnType<typeof createCommit>>["commit"],
    child: ClientState,
    parent = snapshot(f.admin2Epoch1),
    parentTag = bytesToHex(f.admin2Epoch1.confirmationTag),
  ) {
    return resolveCandidateParent({
      ciphersuite: f.impl,
      parent,
      message,
      callback: createAdminCommitPolicyCallback({
        ratchetTree: parent.ratchetTree,
        adminPubkeys: getMarmotGroupView(parent)!.adminPubkeys,
        ciphersuiteId: f.impl.id,
      }),
      known: { parentTag, state: child },
    });
  }

  async function commit(
    extraProposals: Proposal[] = [],
    publicMessage = false,
  ) {
    return createCommit({
      context: f.ctx,
      state: snapshot(f.admin2Epoch1),
      wireAsPublicMessage: publicMessage,
      extraProposals,
    });
  }

  it("accepts a public own child with a genuinely missing proposal reference", async () => {
    const proposal = await createProposal({
      context: f.ctx,
      state: snapshot(f.admin2Epoch1),
      wireAsPublicMessage: true,
      proposal: imageUpdate(encodeGroupBlossomImage({ kind: "empty" })),
    });
    const own = await createCommit({
      context: f.ctx,
      state: proposal.newState,
      wireAsPublicMessage: true,
    });
    if (own.commit.wireformat !== wireformats.mls_public_message)
      throw new Error("expected public commit");
    expect(own.commit.publicMessage.content.contentType).toBe(
      contentTypes.commit,
    );
    if (own.commit.publicMessage.content.contentType !== contentTypes.commit)
      throw new Error("expected commit content");
    expect(
      own.commit.publicMessage.content.commit.proposals.some(
        (entry) => entry.proposalOrRefType === proposalOrRefTypes.reference,
      ),
    ).toBe(true);
    expect(Object.keys(f.admin2Epoch1.unappliedProposals)).toHaveLength(0);
    const resolution = await resolve(own.commit, own.newState);
    expect(resolution.kind).toBe("resolved");
    if (resolution.kind === "resolved")
      expect(bytesToHex(resolution.result.newState.confirmationTag)).toBe(
        bytesToHex(own.newState.confirmationTag),
      );
  });

  it("accepts a private own child whose encrypted proposals cannot be rebuilt", async () => {
    const own = await commit([
      imageUpdate(encodeGroupBlossomImage({ kind: "empty" })),
    ]);
    expect(own.commit.wireformat).toBe(wireformats.mls_private_message);
    const resolution = await resolve(own.commit, own.newState);
    expect(resolution.kind).toBe("resolved");
    if (resolution.kind === "resolved")
      expect(bytesToHex(resolution.result.newState.confirmationTag)).toBe(
        bytesToHex(own.newState.confirmationTag),
      );
  });

  it("rejects a malformed identity proof in a genuine private Add child", async () => {
    const forged = await forgeKeyPackage({
      account: testAccount(9),
      ciphersuiteImpl: f.impl,
      proof: "tampered",
    });
    const own = await commit([
      {
        proposalType: defaultProposalTypes.add,
        add: { keyPackage: forged.publicPackage },
      },
    ]);
    expect(await resolve(own.commit, own.newState)).toMatchObject({
      kind: "rejected",
      violation: { reason: "account-identity-proof" },
    });
  });

  it("rejects a profile mismatch reached by an authenticated private commit", async () => {
    const own = await commit([
      dropAccountIdentityProofRequirement(f.admin2Epoch1),
    ]);
    expect(await resolve(own.commit, own.newState)).toMatchObject({
      kind: "rejected",
      violation: { reason: "account-identity-proof" },
    });
  });

  it("rejects a protected-extension mismatch reached by an authenticated private commit", async () => {
    const own = await commit([
      {
        proposalType: appDataUpdateProposalType,
        appDataUpdate: {
          componentId: GROUP_ADMIN_POLICY_COMPONENT_ID,
          operation: "remove",
        },
      },
    ]);
    expect(await resolve(own.commit, own.newState)).toMatchObject({
      kind: "rejected",
      violation: { reason: "component-integrity" },
    });
  });

  it("rejects invalid admin-leaf coupling in a genuine private Remove child", async () => {
    const [removed] = getPubkeyLeafNodeIndexes(f.admin2Epoch1, f.adminPubkey);
    if (removed === undefined) throw new Error("expected admin leaf");
    const own = await commit([
      { proposalType: defaultProposalTypes.remove, remove: { removed } },
    ]);
    expect(await resolve(own.commit, own.newState)).toMatchObject({
      kind: "rejected",
      violation: { reason: "admin-leaf-coupling" },
    });
  });

  it("rejects a wrong recorded exact parent instead of bypassing own-commit authentication", async () => {
    const own = await commit();
    const other = await commit();
    const resolution = await resolve(
      own.commit,
      own.newState,
      snapshot(f.admin2Epoch1),
      bytesToHex(other.newState.confirmationTag),
    );
    expect(resolution.kind).toBe("authentication_mismatch");
  });

  it("cannot splice an own child onto a competing same-epoch branch", async () => {
    const a = await commit();
    const b = await commit();
    expect(a.newState.groupContext.epoch).toBe(b.newState.groupContext.epoch);
    expect(bytesToHex(a.newState.confirmationTag)).not.toBe(
      bytesToHex(b.newState.confirmationTag),
    );
    const own = await createCommit({
      context: f.ctx,
      state: snapshot(a.newState),
      wireAsPublicMessage: false,
    });
    const resolution = await resolve(
      own.commit,
      own.newState,
      snapshot(b.newState),
      bytesToHex(a.newState.confirmationTag),
    );
    expect(resolution.kind).toBe("authentication_mismatch");
    // Positive exact-parent control on the same message and child.
    expect(
      (
        await resolve(
          own.commit,
          own.newState,
          snapshot(a.newState),
          bytesToHex(a.newState.confirmationTag),
        )
      ).kind,
    ).toBe("resolved");
  });

  it("rejects a genuine grandchild supplied as the exact parent's immediate child", async () => {
    const own = await commit();
    const grandchild = await createCommit({
      context: f.ctx,
      state: snapshot(own.newState),
      wireAsPublicMessage: false,
    });
    expect(grandchild.newState.groupContext.epoch).toBe(
      f.admin2Epoch1.groupContext.epoch + 2n,
    );
    expect((await resolve(own.commit, grandchild.newState)).kind).toBe(
      "authentication_mismatch",
    );
  });

  it("rejects a genuine next-epoch commit paired with an earlier stamped parent", async () => {
    const own = await commit();
    const next = await createCommit({
      context: f.ctx,
      state: snapshot(own.newState),
      wireAsPublicMessage: false,
    });
    expect((await resolve(next.commit, own.newState)).kind).toBe(
      "authentication_mismatch",
    );
  });
});

describe("known-state shortcut without rebuildable proposals (WR-03)", () => {
  it("still rejects a recorded child that leaves an admin without a member leaf", async () => {
    const { impl, ctx, adminPubkey, adminEpoch1, admin2Epoch1, forgedEpoch1 } =
      await seamGroup({ forgedMember: "tampered" });
    const [adminLeaf] = getPubkeyLeafNodeIndexes(adminEpoch1, adminPubkey);
    if (adminLeaf === undefined) throw new Error("expected admin1's leaf");

    // admin2 removes admin1's only leaf without dropping admin1 from
    // admin_policy. Sent as a PrivateMessage, so the shortcut cannot rebuild
    // the commit's proposals off the wire.
    const orphaning = await createCommit({
      context: ctx,
      state: admin2Epoch1,
      wireAsPublicMessage: false,
      ratchetTreeExtension: true,
      extraProposals: [
        {
          proposalType: defaultProposalTypes.remove,
          remove: { removed: adminLeaf },
        },
      ],
    });

    // The recorded child, reached with no Marmot gates, from a third member's
    // perspective (a member other than the committer can replay the commit).
    const parent = snapshot(forgedEpoch1!);
    const replayed = await processMessage({
      context: {
        cipherSuite: impl,
        authService: ctx.authService,
        externalPsks: {},
      },
      state: snapshot(forgedEpoch1!),
      message: orphaning.commit,
    });
    if (replayed.kind !== "newState") throw new Error("expected newState");
    expect(getMarmotGroupView(replayed.newState)?.adminPubkeys).toContain(
      adminPubkey,
    );

    const view = getMarmotGroupView(parent);
    if (!view) throw new Error("expected a Marmot group view");
    const resolution = await resolveCandidateParent({
      ciphersuite: impl,
      parent,
      message: orphaning.commit,
      callback: createAdminCommitPolicyCallback({
        ratchetTree: parent.ratchetTree,
        adminPubkeys: view.adminPubkeys,
        ciphersuiteId: impl.id,
      }),
      known: {
        parentTag: bytesToHex(parent.confirmationTag),
        state: replayed.newState,
      },
    });

    expect(resolution.kind).toBe("rejected");
    expect(
      resolution.kind === "rejected" ? resolution.violation?.reason : undefined,
    ).toBe("admin-leaf-coupling");
  });

  it("still resolves a LEGAL recorded child whose proposals cannot be rebuilt (CR-01 positive control)", async () => {
    const { impl, ctx, adminEpoch1, admin2Epoch1 } = await seamGroup();

    // A benign, proposal-free self-update by admin2, sent as a PrivateMessage
    // so the shortcut can rebuild neither the commit's proposals nor even a
    // committer index off the wire. This is the exact input class CR-01
    // deferred FOREVER: `validateLegalityWithoutProposals` had lost the
    // ability to return `legal` at all, so every legal own commit reaching it
    // became a permanent `temporary_refusal` — which stops `#buildBranches`
    // from registering our own deeper chain as a branch tip and hands the
    // rewind to a shallower competitor.
    const benign = await createCommit({
      context: ctx,
      state: admin2Epoch1,
      wireAsPublicMessage: false,
      ratchetTreeExtension: true,
    });

    const parent = snapshot(adminEpoch1);
    const replayed = await processMessage({
      context: {
        cipherSuite: impl,
        authService: ctx.authService,
        externalPsks: {},
      },
      state: snapshot(adminEpoch1),
      message: benign.commit,
    });
    if (replayed.kind !== "newState") throw new Error("expected newState");

    const view = getMarmotGroupView(parent);
    if (!view) throw new Error("expected a Marmot group view");
    const resolution = await resolveCandidateParent({
      ciphersuite: impl,
      parent,
      message: benign.commit,
      callback: createAdminCommitPolicyCallback({
        ratchetTree: parent.ratchetTree,
        adminPubkeys: view.adminPubkeys,
        ciphersuiteId: impl.id,
      }),
      known: {
        parentTag: bytesToHex(parent.confirmationTag),
        state: replayed.newState,
      },
    });

    // The whole point: a deferral here is indistinguishable from a rejection
    // for convergence purposes, because no future bytes can ever clear it.
    expect(resolution.kind).toBe("resolved");
  });
});
