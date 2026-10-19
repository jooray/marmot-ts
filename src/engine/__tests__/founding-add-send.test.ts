/**
 * Engine-level test suite for `MarmotGroupEngine#send`'s `case "foundingAdd":`
 * seam (`src/engine/group-engine.ts`) — the founding Current-profile Add
 * commit (epoch 0 -> 1) that merges locally with no group-message
 * publication obligation.
 *
 * Covers:
 *  - FOUND-01: no transport envelope is ever constructed for the founding
 *    commit (proven with a call-counting peeler, not merely an unpublished
 *    envelope).
 *  - FOUND-02: the founding case runs through the identical
 *    `#assertStagedCommitLegal`/`validateCommitLegality` gate every other
 *    commit-producing send case uses.
 *  - FOUND-03: `confirmPublished(result.pending)` reaches `Stable` at
 *    epoch 1.
 *  - D-01: the founding Add's `PendingState.kind` is the existing `"commit"`
 *    literal, so it is recorded into retained history and the fork tree by
 *    `confirmPublished`'s unmodified commit-recording branch (CR-09).
 *  - D-02: the `foundingGroupCreated` result's `welcome` shape (one Welcome
 *    secrets entry per invitee).
 *  - R-01: leaving a `foundingGroupCreated` result unconfirmed is caught,
 *    not silently left as stale staged state -- canonical state stays at
 *    epoch 0 and a subsequent commit-producing send is refused while
 *    `PendingPublish`.
 *
 * @see refs/marmot/protocol-core/joining.md lines 21-30 -- "the
 *   founding-creation exception": a founding Add "has no group-message
 *   publication obligation because no pre-existing peer needs it".
 * @see .planning/phases/10-founding-group-creation-via-welcome/10-01-PLAN.md
 *
 *  - CR-03: `case "foundingAdd"` invocation legality -- the public `./engine`
 *    surface refuses `foundingAdd` unless the group is a one-member epoch-0
 *    group with no unapplied proposals and a non-empty, all-Add proposal
 *    set, before any commit is built (10-REVIEW.md / 10-VERIFICATION.md
 *    truth 2, FOUND-02 "PARTIAL").
 */
import type { NostrEvent } from "applesauce-core/helpers/event";
import {
  type CiphersuiteImpl,
  defaultCryptoProvider,
  defaultProposalTypes,
  getCiphersuiteImpl,
  type Proposal,
} from "ts-mls";
import { describe, expect, it, vi } from "vitest";

import { forgeKeyPackage } from "../../__tests__/helpers/account-identity-proof-fixtures.js";
import { testAccount } from "../../__tests__/helpers/test-accounts.js";
import { createCredential } from "../../core/credential.js";
import { createSimpleGroup } from "../../core/group.js";
import {
  createGroupEvent,
  decryptGroupMessages,
} from "../../core/group-message.js";
import { generateKeyPackage } from "../../core/key-package.js";
import { proposeInviteUser } from "../../client/group/proposals/invite-user.js";
import { CommitLegalityError, MarmotGroupEngine } from "../group-engine.js";
import type { GroupPeeler, ProposalContext, SendIntent } from "../types.js";
import type { GroupSessionSendIntent } from "../../client/session/group-effects.js";
import { framedCommitProposals } from "../wire-format.js";
import { MemoryAuditSink } from "../../audit/sink.js";
import * as messageDedup from "../message-dedup.js";
import { RetainedHistoryStore } from "../retained-store.js";

/** A real crypto-backed peeler that also counts `wrapGroupMessage` calls (FOUND-01). */
function countingPeeler(ciphersuite: CiphersuiteImpl): {
  peeler: GroupPeeler<NostrEvent>;
  wrapCount: () => number;
} {
  let wraps = 0;
  const peeler: GroupPeeler<NostrEvent> = {
    async peelGroupMessages(envelopes, state) {
      const { read, unreadable } = await decryptGroupMessages(
        envelopes,
        state,
        ciphersuite,
      );
      return {
        read: read.map(({ event, message }) => ({ envelope: event, message })),
        unreadable,
      };
    },
    async wrapGroupMessage(message, state) {
      wraps++;
      return createGroupEvent({ message, state, ciphersuite });
    },
    idOf(envelope) {
      return envelope.id;
    },
  };
  return { peeler, wrapCount: () => wraps };
}

/** A fresh solo epoch-0 group with a genuine admin identity. */
async function foundingGroup() {
  const adminAccount = testAccount(6);
  const impl = await getCiphersuiteImpl(
    "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
    defaultCryptoProvider,
  );
  const adminKp = await generateKeyPackage({
    credential: createCredential(adminAccount.pubkey),
    signer: adminAccount.signer,
    ciphersuiteImpl: impl,
  });
  const { clientState: epoch0 } = await createSimpleGroup(
    adminKp,
    impl,
    "Founding Test Group",
    { relays: ["wss://relay.test"] },
  );
  return { impl, adminAccount, adminPubkey: adminAccount.pubkey, epoch0 };
}

/** Builds a genuine, valid invitee KeyPackage for `slot`. */
async function inviteeKeyPackage(slot: number, impl: CiphersuiteImpl) {
  const account = testAccount(slot);
  return generateKeyPackage({
    credential: createCredential(account.pubkey),
    signer: account.signer,
    ciphersuiteImpl: impl,
  });
}

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/** Pause only the first real signature, without changing the shared provider. */
function signingBarrier(original: CiphersuiteImpl) {
  const entered = barrier();
  const resume = barrier();
  let signs = 0;
  const ciphersuite: CiphersuiteImpl = {
    ...original,
    signature: {
      ...original.signature,
      async sign(key, message) {
        const signature = await original.signature.sign(key, message);
        if (++signs === 1) {
          entered.release();
          await resume.promise;
        }
        return signature;
      },
    },
  };
  return { ciphersuite, entered, resume, signs: () => signs };
}

describe.each(["proposal builder", "real crypto"] as const)(
  "foundingAdd %s race matrix",
  (window) => {
    it.each([
      "parent replacement",
      "persistent direct proposal",
      "state away and back",
      "proposal-bearing state away and back",
      "lifecycle away and back",
      "competing founding pending",
      "competing founding confirmed",
      "competing ordinary pending",
      "competing ordinary confirmed",
    ] as const)(
      "refuses %s and preserves intervening work",
      async (mutation) => {
        const { impl, adminPubkey, epoch0 } = await foundingGroup();
        const sharedSignature = impl.signature;
        const invitee = await inviteeKeyPackage(9, impl);
        const competingInvitee = await inviteeKeyPackage(11, impl);
        const crypto = signingBarrier(impl);
        const entered = window === "real crypto" ? crypto.entered : barrier();
        const resume = window === "real crypto" ? crypto.resume : barrier();
        const ciphersuite =
          window === "real crypto" ? crypto.ciphersuite : impl;
        const { peeler, wrapCount } = countingPeeler(ciphersuite);
        const changes: unknown[] = [];
        const audit = new MemoryAuditSink();
        const retained = new RetainedHistoryStore(epoch0);
        const record = vi.spyOn(retained, "record");
        const engine = new MarmotGroupEngine({
          state: epoch0,
          ciphersuite,
          peeler,
          retained,
          onStateChanged: (state) => changes.push(state),
          audit,
          auditContext: { engineId: "founding-race" },
        });
        const dedup = vi.spyOn(messageDedup, "contentDedupId");
        const add: Proposal = {
          proposalType: defaultProposalTypes.add,
          add: { keyPackage: invitee.publicPackage },
        };
        const preparation = engine.send({
          kind: "foundingAdd",
          actorPubkey: adminPubkey,
          extraProposals: [
            window === "real crypto"
              ? add
              : async (context) => {
                  expect(context.state).toBe(epoch0);
                  entered.release();
                  await resume.promise;
                  return add;
                },
          ],
        });
        const outcome = preparation.then(
          () => "resolved instead of refusing stale preparation",
          (error: unknown) =>
            error instanceof Error ? error.message : String(error),
        );
        try {
          await entered.promise;
          if (window === "real crypto") expect(crypto.signs()).toBe(1);
          const proposal = {
            proposal: {
              proposalType: defaultProposalTypes.remove,
              remove: { removed: 0 },
            } as Proposal,
            senderLeafIndex: 0,
          };
          let competing: Awaited<ReturnType<typeof engine.send>> | undefined;
          switch (mutation) {
            case "parent replacement":
              engine.state = { ...epoch0 };
              break;
            case "persistent direct proposal":
              epoch0.unappliedProposals.staged = proposal;
              break;
            case "state away and back":
              engine.state = { ...epoch0 };
              engine.state = epoch0;
              break;
            case "proposal-bearing state away and back":
              engine.state = {
                ...epoch0,
                unappliedProposals: { staged: proposal },
              };
              engine.state = epoch0;
              break;
            case "lifecycle away and back":
              competing = await engine.send({
                kind: "commit",
                actorPubkey: adminPubkey,
              });
              if (competing.kind !== "groupEvolution")
                throw new Error("expected ordinary commit");
              engine.publishFailed(competing.pending);
              expect(engine.state).toBe(epoch0);
              expect(engine.lifecycle).toBe("Stable");
              break;
            case "competing founding pending":
            case "competing founding confirmed":
              competing = await engine.send({
                kind: "foundingAdd",
                actorPubkey: adminPubkey,
                extraProposals: [
                  {
                    proposalType: defaultProposalTypes.add,
                    add: { keyPackage: competingInvitee.publicPackage },
                  },
                ],
              });
              if (competing.kind !== "foundingGroupCreated")
                throw new Error("expected founding commit");
              if (mutation === "competing founding confirmed")
                engine.confirmPublished(competing.pending);
              break;
            case "competing ordinary pending":
            case "competing ordinary confirmed":
              competing = await engine.send({
                kind: "commit",
                actorPubkey: adminPubkey,
              });
              if (competing.kind !== "groupEvolution")
                throw new Error("expected ordinary commit");
              if (mutation === "competing ordinary confirmed")
                engine.confirmPublished(competing.pending);
              break;
          }
          const stateAfterIntervention = engine.state;
          const lifecycleAfterIntervention = engine.lifecycle;
          const historyAfterIntervention = engine.history.size;
          const retainedAfterIntervention = engine.retainedStates();
          const changesAfterIntervention = changes.length;
          const wrapsAfterIntervention = wrapCount();
          const auditAfterIntervention = audit.events.length;
          const dedupAfterIntervention = dedup.mock.calls.length;
          resume.release();
          expect(await outcome).toMatch(/foundingAdd:.*changed.*retry/i);
          expect(engine.state).toBe(stateAfterIntervention);
          expect(engine.lifecycle).toBe(lifecycleAfterIntervention);
          expect(engine.history.size).toBe(historyAfterIntervention);
          expect(engine.retainedStates()).toEqual(retainedAfterIntervention);
          expect(changes).toHaveLength(changesAfterIntervention);
          expect(wrapCount()).toBe(wrapsAfterIntervention);
          // The refusal is audited, but produces no lifecycle/staging event.
          expect(audit.events.slice(auditAfterIntervention)).toEqual([
            expect.objectContaining({
              kind: expect.objectContaining({ type: "send_error" }),
            }),
          ]);
          // No refused-output content id is registered for own-echo handling.
          expect(dedup.mock.calls).toHaveLength(dedupAfterIntervention);
          expect(impl.signature).toBe(sharedSignature);
          if (mutation === "persistent direct proposal") {
            expect(engine.state.unappliedProposals.staged).toBe(proposal);
          }
          if (mutation.endsWith("pending")) {
            if (!competing || !("pending" in competing))
              throw new Error("expected competing pending work");
            // Refusal did not clear/rollback the other operation's pending state.
            expect(engine.lifecycle).toBe("PendingPublish");
            engine.confirmPublished(competing.pending);
            expect(engine.state).toBe(competing.pending.newState);
            expect(engine.lifecycle).toBe("Stable");
            expect(engine.history.size).toBe(2);
            // The pending winner's parent remained pinned until confirmation.
            expect(Array.from(record.mock.calls.at(-1)![3]!)).toEqual([0]);
          }
        } finally {
          resume.release();
          crypto.resume.release();
          await preparation.catch(() => undefined);
          dedup.mockRestore();
          record.mockRestore();
        }
      },
    );
  },
);

describe("foundingAdd asynchronous preparation", () => {
  it("proposal builder refuses a persistent direct proposal edit", async () => {
    const { impl, adminPubkey, epoch0 } = await foundingGroup();
    const { peeler, wrapCount } = countingPeeler(impl);
    const engine = new MarmotGroupEngine({
      state: epoch0,
      ciphersuite: impl,
      peeler,
    });
    const proposals = epoch0.unappliedProposals;
    const descriptor = Object.getOwnPropertyDescriptor(
      epoch0,
      "unappliedProposals",
    );
    const prototype = Object.getPrototypeOf(proposals);
    const invitee = await inviteeKeyPackage(9, impl);
    const entered = barrier();
    const resume = barrier();
    const preparation = engine.send({
      kind: "foundingAdd",
      actorPubkey: adminPubkey,
      extraProposals: [
        async () => {
          entered.release();
          await resume.promise;
          return {
            proposalType: defaultProposalTypes.add,
            add: { keyPackage: invitee.publicPackage },
          };
        },
      ],
    });
    const refused = expect(preparation).rejects.toThrow(
      /foundingAdd:.*changed.*retry/i,
    );
    try {
      await entered.promise;
      proposals.staged = {
        proposal: {
          proposalType: defaultProposalTypes.remove,
          remove: { removed: 0 },
        },
        senderLeafIndex: 0,
      };
      resume.release();
      await refused;
      expect(engine.state).toBe(epoch0);
      expect(engine.state.unappliedProposals).toBe(proposals);
      expect(
        Object.getOwnPropertyDescriptor(epoch0, "unappliedProposals"),
      ).toEqual(descriptor);
      expect(Object.getPrototypeOf(proposals)).toBe(prototype);
      expect(proposals.staged).toBeDefined();
      expect(engine.lifecycle).toBe("Stable");
      expect(engine.history.size).toBe(1);
      expect(wrapCount()).toBe(0);
    } finally {
      resume.release();
      await preparation.catch(() => undefined);
    }
  });

  it("proposal builder refuses state away and back before staging", async () => {
    const { impl, adminPubkey, epoch0 } = await foundingGroup();
    const { peeler, wrapCount } = countingPeeler(impl);
    const changes: unknown[] = [];
    const engine = new MarmotGroupEngine({
      state: epoch0,
      ciphersuite: impl,
      peeler,
      onStateChanged: (state) => changes.push(state),
    });
    const invitee = await inviteeKeyPackage(9, impl);
    const entered = barrier();
    const resume = barrier();
    const preparation = engine.send({
      kind: "foundingAdd",
      actorPubkey: adminPubkey,
      extraProposals: [
        async (context) => {
          expect(context.state).toBe(epoch0);
          entered.release();
          await resume.promise;
          return {
            proposalType: defaultProposalTypes.add,
            add: { keyPackage: invitee.publicPackage },
          };
        },
      ],
    });
    // Attach the rejection handler before releasing the asynchronous work.
    const outcome = preparation.then(
      () => "resolved instead of refusing stale preparation",
      (error: unknown) =>
        error instanceof Error ? error.message : String(error),
    );
    try {
      await entered.promise;
      engine.state = { ...epoch0 };
      engine.state = epoch0;
      resume.release();
      expect(await outcome).toMatch(/foundingAdd:.*changed.*retry/i);
      expect(engine.state).toBe(epoch0);
      expect(engine.lifecycle).toBe("Stable");
      expect(changes).toHaveLength(2);
      expect(engine.history.size).toBe(1);
      expect(engine.retainedStates()).toEqual([epoch0]);
      expect(wrapCount()).toBe(0);
    } finally {
      resume.release();
      await preparation.catch(() => undefined);
    }
  });
});

describe('MarmotGroupEngine#send case "foundingAdd"', () => {
  it("resolves ordered single and array Add builders through the common public contract", async () => {
    const { impl, adminPubkey, epoch0 } = await foundingGroup();
    const { peeler, wrapCount } = countingPeeler(impl);
    const engine = new MarmotGroupEngine({
      state: epoch0,
      ciphersuite: impl,
      peeler,
    });
    const adds: Proposal[] = [];
    for (const slot of [0, 1, 2]) {
      const kp = await inviteeKeyPackage(slot, impl);
      adds.push({
        proposalType: defaultProposalTypes.add,
        add: { keyPackage: kp.publicPackage },
      });
    }
    const contexts: ProposalContext[] = [];
    const ordinary: Extract<GroupSessionSendIntent, { kind: "commit" }> = {
      kind: "commit",
      actorPubkey: adminPubkey,
      extraProposals: [
        [
          async (context) => {
            contexts.push(context);
            return adds[0]!;
          },
        ],
        async (context) => {
          contexts.push(context);
          return adds.slice(1);
        },
      ],
    };
    const intent: Extract<SendIntent, { kind: "foundingAdd" }> = {
      kind: "foundingAdd",
      actorPubkey: ordinary.actorPubkey,
      extraProposals: ordinary.extraProposals!,
    };
    const result = await engine.send(intent);
    expect(result.kind).toBe("foundingGroupCreated");
    if (result.kind !== "foundingGroupCreated")
      throw new Error("expected founding group");
    expect(contexts[0]).toBe(contexts[1]);
    expect(contexts[0]!.state).toBe(epoch0);
    expect(
      framedCommitProposals(result.pending.commitMessage!, epoch0),
    ).toEqual(adds);
    expect(result.welcome.welcome.secrets).toHaveLength(3);
    expect(wrapCount()).toBe(0);
    engine.confirmPublished(result.pending);
    expect(engine.state.groupContext.epoch).toBe(1n);
    expect(engine.lifecycle).toBe("Stable");
  });

  it.each(["empty", "mixed"] as const)(
    "rejects a %s founding builder result before state change",
    async (shape) => {
      const { impl, adminPubkey, epoch0 } = await foundingGroup();
      const { peeler, wrapCount } = countingPeeler(impl);
      const engine = new MarmotGroupEngine({
        state: epoch0,
        ciphersuite: impl,
        peeler,
      });
      const kp = await inviteeKeyPackage(0, impl);
      const proposals: Proposal[] =
        shape === "empty"
          ? []
          : [
              {
                proposalType: defaultProposalTypes.add,
                add: { keyPackage: kp.publicPackage },
              },
              {
                proposalType: defaultProposalTypes.remove,
                remove: { removed: 0 },
              },
            ];
      await expect(
        engine.send({
          kind: "foundingAdd",
          actorPubkey: adminPubkey,
          extraProposals: [async () => proposals],
        }),
      ).rejects.toThrow(
        shape === "empty" ? /empty proposal/i : /may only carry Add/,
      );
      expect(engine.state).toBe(epoch0);
      expect(engine.lifecycle).toBe("Stable");
      expect(wrapCount()).toBe(0);
    },
  );

  it("FOUND-01: builds no transport envelope for the founding commit", async () => {
    const { impl, adminPubkey, epoch0 } = await foundingGroup();
    const { peeler, wrapCount } = countingPeeler(impl);
    const engine = new MarmotGroupEngine({
      state: epoch0,
      ciphersuite: impl,
      peeler,
    });
    const invitee1 = await inviteeKeyPackage(9, impl);
    const invitee2 = await inviteeKeyPackage(11, impl);

    const result = await engine.send({
      kind: "foundingAdd",
      actorPubkey: adminPubkey,
      extraProposals: [
        proposeInviteUser(invitee1.publicPackage),
        proposeInviteUser(invitee2.publicPackage),
      ],
    });

    expect(result.kind).toBe("foundingGroupCreated");
    if (result.kind !== "foundingGroupCreated") throw new Error("unreachable");
    expect(result.welcome).toBeDefined();
    // This is the behavioral form of FOUND-01: it cannot be satisfied by an
    // envelope that is built and then dropped -- the peeler's wrap method
    // must never be invoked at all across the whole send.
    expect(wrapCount()).toBe(0);
  });

  it("FOUND-03/D-01: transits PendingPublish (epoch still 0) then reaches Stable at epoch 1 on confirm", async () => {
    const { impl, adminPubkey, epoch0 } = await foundingGroup();
    const { peeler } = countingPeeler(impl);
    const engine = new MarmotGroupEngine({
      state: epoch0,
      ciphersuite: impl,
      peeler,
    });
    const invitee = await inviteeKeyPackage(9, impl);

    const result = await engine.send({
      kind: "foundingAdd",
      actorPubkey: adminPubkey,
      extraProposals: [proposeInviteUser(invitee.publicPackage)],
    });
    if (result.kind !== "foundingGroupCreated") throw new Error("unreachable");

    // D-01: the PendingPublish transit is real but never observed by a
    // caller that confirms in the same uninterrupted continuation -- checked
    // here, before any intervening await.
    expect(engine.lifecycle).toBe("PendingPublish");
    expect(Number(engine.state.groupContext.epoch)).toBe(0);

    engine.confirmPublished(result.pending);

    expect(engine.lifecycle).toBe("Stable");
    expect(Number(engine.state.groupContext.epoch)).toBe(1);
  });

  it("D-01/CR-09: records the founding commit into retained history and the fork tree on confirmation", async () => {
    const { impl, adminPubkey, epoch0 } = await foundingGroup();
    const { peeler } = countingPeeler(impl);
    const engine = new MarmotGroupEngine({
      state: epoch0,
      ciphersuite: impl,
      peeler,
    });
    const invitee = await inviteeKeyPackage(9, impl);

    const result = await engine.send({
      kind: "foundingAdd",
      actorPubkey: adminPubkey,
      extraProposals: [proposeInviteUser(invitee.publicPackage)],
    });
    if (result.kind !== "foundingGroupCreated") throw new Error("unreachable");
    engine.confirmPublished(result.pending);

    // The whole point of D-01: the CR-09 recording path ran for a commit
    // that was never published. Two nodes: the epoch-0 root plus the
    // epoch-1 child.
    expect(engine.history.size).toBe(2);
    const retainedEpochs = engine
      .retainedStates()
      .map((state) => Number(state.groupContext.epoch));
    expect(retainedEpochs).toContain(0);
    expect(retainedEpochs).toContain(1);
  });

  it("R-01: an unconfirmed foundingGroupCreated result is caught, not silently left as stale staged state", async () => {
    const { impl, adminPubkey, epoch0 } = await foundingGroup();
    const { peeler } = countingPeeler(impl);
    const engine = new MarmotGroupEngine({
      state: epoch0,
      ciphersuite: impl,
      peeler,
    });
    const invitee = await inviteeKeyPackage(9, impl);

    await engine.send({
      kind: "foundingAdd",
      actorPubkey: adminPubkey,
      extraProposals: [proposeInviteUser(invitee.publicPackage)],
    });

    // Deliberately never confirmed. Canonical state must stay at epoch 0 --
    // this is the executable form of R-01, which CONTEXT.md flags as the
    // test most likely to be skipped and most valuable to keep.
    expect(Number(engine.state.groupContext.epoch)).toBe(0);
    expect(engine.lifecycle).toBe("PendingPublish");

    await expect(
      engine.send({ kind: "commit", actorPubkey: adminPubkey }),
    ).rejects.toThrow(/PendingPublish/);
  });

  it("FOUND-02: a foundingAdd whose Add proposal carries a KeyPackage with a missing account-identity proof is refused", async () => {
    const { impl, adminPubkey, epoch0 } = await foundingGroup();
    const { peeler, wrapCount } = countingPeeler(impl);
    const engine = new MarmotGroupEngine({
      state: epoch0,
      ciphersuite: impl,
      peeler,
    });
    const forged = await forgeKeyPackage({
      account: testAccount(3),
      ciphersuiteImpl: impl,
      proof: "missing",
    });

    // A plain literal Add proposal (not `proposeInviteUser`, which runs its
    // own client-layer proof check before the send is even attempted) so
    // this test exercises the SHARED `#assertStagedCommitLegal` gate itself
    // -- the same gate `case "commit"`/`case "selfUpdate"` call -- not a
    // separate, earlier client-side validator.
    await expect(
      engine.send({
        kind: "foundingAdd",
        actorPubkey: adminPubkey,
        extraProposals: [
          {
            proposalType: defaultProposalTypes.add,
            add: { keyPackage: forged.publicPackage },
          },
        ],
      }),
    ).rejects.toThrow(CommitLegalityError);

    // Nothing staged: no envelope built, still Stable at epoch 0.
    expect(wrapCount()).toBe(0);
    expect(engine.lifecycle).toBe("Stable");
    expect(Number(engine.state.groupContext.epoch)).toBe(0);
  });

  it("D-02 shape: welcome.welcome.secrets has one entry per invitee for a two-invitee founding Add", async () => {
    const { impl, adminPubkey, epoch0 } = await foundingGroup();
    const { peeler } = countingPeeler(impl);
    const engine = new MarmotGroupEngine({
      state: epoch0,
      ciphersuite: impl,
      peeler,
    });
    const invitee1 = await inviteeKeyPackage(9, impl);
    const invitee2 = await inviteeKeyPackage(11, impl);

    const result = await engine.send({
      kind: "foundingAdd",
      actorPubkey: adminPubkey,
      extraProposals: [
        proposeInviteUser(invitee1.publicPackage),
        proposeInviteUser(invitee2.publicPackage),
      ],
    });
    if (result.kind !== "foundingGroupCreated") throw new Error("unreachable");

    expect(result.welcome.welcome.secrets).toHaveLength(2);
  });
});

describe("foundingAdd invocation guard (CR-03)", () => {
  it("CR-03: refuses foundingAdd on a group already past epoch 0 (the live-group silent-fork case) and leaves state unchanged", async () => {
    const { impl, adminPubkey, epoch0 } = await foundingGroup();
    const { peeler, wrapCount } = countingPeeler(impl);
    const engine = new MarmotGroupEngine({
      state: epoch0,
      ciphersuite: impl,
      peeler,
    });
    const invitee1 = await inviteeKeyPackage(9, impl);
    const founding = await engine.send({
      kind: "foundingAdd",
      actorPubkey: adminPubkey,
      extraProposals: [proposeInviteUser(invitee1.publicPackage)],
    });
    if (founding.kind !== "foundingGroupCreated")
      throw new Error("unreachable");
    engine.confirmPublished(founding.pending);
    expect(Number(engine.state.groupContext.epoch)).toBe(1);

    const stateBefore = engine.state;
    const historySizeBefore = engine.history.size;
    const wrapCountBefore = wrapCount();
    const invitee2 = await inviteeKeyPackage(11, impl);

    await expect(
      engine.send({
        kind: "foundingAdd",
        actorPubkey: adminPubkey,
        extraProposals: [proposeInviteUser(invitee2.publicPackage)],
      }),
    ).rejects.toThrow(/foundingAdd: only legal at epoch 0/);

    expect(engine.state).toBe(stateBefore);
    expect(engine.lifecycle).toBe("Stable");
    expect(engine.history.size).toBe(historySizeBefore);
    expect(wrapCount()).toBe(wrapCountBefore);

    // A following selfUpdate is not blocked as PendingPublish.
    const selfUpdateResult = await engine.send({ kind: "selfUpdate" });
    expect(selfUpdateResult.kind).toBe("selfUpdate");
  });

  it("CR-03: refuses foundingAdd when the tree holds more than the local member, even at epoch 0", async () => {
    const { impl, adminPubkey, epoch0 } = await foundingGroup();
    const { peeler: peeler1 } = countingPeeler(impl);
    const engine1 = new MarmotGroupEngine({
      state: epoch0,
      ciphersuite: impl,
      peeler: peeler1,
    });
    const invitee1 = await inviteeKeyPackage(9, impl);
    const founding = await engine1.send({
      kind: "foundingAdd",
      actorPubkey: adminPubkey,
      extraProposals: [proposeInviteUser(invitee1.publicPackage)],
    });
    if (founding.kind !== "foundingGroupCreated")
      throw new Error("unreachable");
    engine1.confirmPublished(founding.pending);
    const twoMemberEpoch1State = engine1.state;

    const { peeler: peeler2, wrapCount } = countingPeeler(impl);
    const engine2 = new MarmotGroupEngine({
      state: {
        ...twoMemberEpoch1State,
        groupContext: { ...twoMemberEpoch1State.groupContext, epoch: 0n },
      },
      ciphersuite: impl,
      peeler: peeler2,
    });
    const stateBefore = engine2.state;
    const historySizeBefore = engine2.history.size;
    const invitee2 = await inviteeKeyPackage(2, impl);

    await expect(
      engine2.send({
        kind: "foundingAdd",
        actorPubkey: adminPubkey,
        extraProposals: [proposeInviteUser(invitee2.publicPackage)],
      }),
    ).rejects.toThrow(/foundingAdd: requires a one-member group/);

    expect(engine2.state).toBe(stateBefore);
    expect(engine2.lifecycle).toBe("Stable");
    expect(engine2.history.size).toBe(historySizeBefore);
    expect(wrapCount()).toBe(0);
  });

  it("CR-03: refuses foundingAdd while unapplied proposals are staged", async () => {
    const { impl, adminPubkey, epoch0 } = await foundingGroup();
    const { peeler, wrapCount } = countingPeeler(impl);
    const engine = new MarmotGroupEngine({
      state: {
        ...epoch0,
        unappliedProposals: {
          staged: {
            proposal: {
              proposalType: defaultProposalTypes.remove,
              remove: { removed: 0 },
            },
            senderLeafIndex: 0,
          },
        },
      },
      ciphersuite: impl,
      peeler,
    });
    const stateBefore = engine.state;
    const historySizeBefore = engine.history.size;
    const invitee = await inviteeKeyPackage(9, impl);

    await expect(
      engine.send({
        kind: "foundingAdd",
        actorPubkey: adminPubkey,
        extraProposals: [proposeInviteUser(invitee.publicPackage)],
      }),
    ).rejects.toThrow(/foundingAdd: requires no unapplied proposals/);

    expect(engine.state).toBe(stateBefore);
    expect(engine.lifecycle).toBe("Stable");
    expect(engine.history.size).toBe(historySizeBefore);
    expect(wrapCount()).toBe(0);
  });

  it("CR-03: refuses foundingAdd carrying a non-Add proposal, by value or via a ProposalAction", async () => {
    const { impl, adminPubkey, epoch0 } = await foundingGroup();
    const { peeler, wrapCount } = countingPeeler(impl);
    const engine = new MarmotGroupEngine({
      state: epoch0,
      ciphersuite: impl,
      peeler,
    });
    const stateBefore = engine.state;
    const historySizeBefore = engine.history.size;
    const invitee = await inviteeKeyPackage(9, impl);
    const removeLiteral = {
      proposalType: defaultProposalTypes.remove,
      remove: { removed: 0 },
    } as const;

    await expect(
      engine.send({
        kind: "foundingAdd",
        actorPubkey: adminPubkey,
        extraProposals: [
          proposeInviteUser(invitee.publicPackage),
          removeLiteral,
        ],
      }),
    ).rejects.toThrow(/foundingAdd: may only carry Add proposals/);

    // Same regex via a ProposalAction resolving to the same Remove literal --
    // proves the check runs on RESOLVED proposals, not on the raw intent shape.
    await expect(
      engine.send({
        kind: "foundingAdd",
        actorPubkey: adminPubkey,
        extraProposals: [
          proposeInviteUser(invitee.publicPackage),
          async () => removeLiteral,
        ],
      }),
    ).rejects.toThrow(/foundingAdd: may only carry Add proposals/);

    expect(engine.state).toBe(stateBefore);
    expect(engine.lifecycle).toBe("Stable");
    expect(engine.history.size).toBe(historySizeBefore);
    expect(wrapCount()).toBe(0);
  });

  it("CR-03: refuses foundingAdd with no proposals", async () => {
    const { impl, adminPubkey, epoch0 } = await foundingGroup();
    const { peeler, wrapCount } = countingPeeler(impl);
    const engine = new MarmotGroupEngine({
      state: epoch0,
      ciphersuite: impl,
      peeler,
    });
    const stateBefore = engine.state;
    const historySizeBefore = engine.history.size;

    await expect(
      engine.send({
        kind: "foundingAdd",
        actorPubkey: adminPubkey,
        extraProposals: [],
      }),
    ).rejects.toThrow(/foundingAdd: requires at least one Add proposal/);

    expect(engine.state).toBe(stateBefore);
    expect(engine.lifecycle).toBe("Stable");
    expect(engine.history.size).toBe(historySizeBefore);
    expect(wrapCount()).toBe(0);
  });
});
