import type { NostrEvent } from "applesauce-core/helpers/event";
import type { MlsWelcomeMessage } from "ts-mls";
import {
  appDataUpdateProposalType,
  defaultCryptoProvider,
  getCiphersuiteImpl,
  protocolVersions,
  wireformats,
} from "ts-mls";
import { describe, expect, it, vi } from "vitest";

import type { MarmotGroupView } from "../../../core/client-state.js";
import { getMarmotGroupView } from "../../../core/client-state.js";
import type { PendingState } from "../../../engine/types.js";
import type { StateNotification } from "../../../engine/state-notifications.js";
import type {
  NostrNetworkInterface,
  PublishResponse,
} from "../../nostr-interface.js";
import type { GroupPublishWork } from "../../session/group-effects.js";
import {
  NostrWelcomeDelivery,
  type WelcomeRecipient,
} from "../../transport/nostr/welcome-delivery.js";
import { GroupRuntime, type GroupRuntimeOptions } from "../group-runtime.js";
import { testAccount } from "../../../__tests__/helpers/test-accounts.js";
import { MemoryAuditSink } from "../../../audit/index.js";
import { MarmotGroupEngine } from "../../../engine/group-engine.js";
import { createCredential } from "../../../core/credential.js";
import { generateKeyPackage } from "../../../core/key-package.js";
import { createGroup } from "../../../core/group.js";
import {
  adminPolicyEntry,
  groupProfileEntry,
  nostrRoutingEntry,
  messageRetentionEntry,
  encodeMessageRetentionV1,
  GROUP_MESSAGE_RETENTION_COMPONENT_ID,
} from "../../../core/components/index.js";
import { serializeApplicationRumor } from "../../../core/group-message.js";
import { NostrGroupPeeler } from "../../group/nostr-peeler.js";
import { createChatRumor } from "../../group/application-message.js";
import publishFailFixture from "../../../../refs/mdk/crates/cgka-conformance-simulator/vectors/publish-fail.v1.json" with { type: "json" };
import invitePublishFailFixture from "../../../../refs/mdk/crates/cgka-conformance-simulator/vectors/invite-publish-fail.v1.json" with { type: "json" };

const RELAYS = ["wss://relay.test"];

/** Structurally complete Welcome; fanout mocks do not attempt MLS joining. */
function welcomeMessage(): MlsWelcomeMessage {
  return {
    version: protocolVersions.mls10,
    wireformat: wireformats.mls_welcome,
    welcome: {
      cipherSuite: 1,
      secrets: [],
      encryptedGroupInfo: new Uint8Array([1, 2, 3, 4]),
    },
  };
}

/** A fake envelope; the runtime only forwards it to the network. */
const envelope = { id: "evt-1", kind: 445 } as unknown as NostrEvent;

/** Opaque pending markers; the runtime only hands them back to the session. */
const pending = { tag: "pending" } as unknown as PendingState;

function ackResponse(): Record<string, PublishResponse> {
  return { [RELAYS[0]]: { from: RELAYS[0], ok: true } };
}

function noAckResponse(): Record<string, PublishResponse> {
  return { [RELAYS[0]]: { from: RELAYS[0], ok: false, message: "rejected" } };
}

function makeNetwork(
  publish: NostrNetworkInterface["publish"],
): NostrNetworkInterface {
  return {
    publish,
    request: async () => {
      throw new Error("not used");
    },
    subscription: () => {
      throw new Error("not used");
    },
    getUserInboxRelays: async () => {
      throw new Error("not used");
    },
  };
}

/**
 * Builds a `deliverMany` implementation that runs the production method
 * (see the call below) against the fixture's `deliver` mock, so this
 * suite's Welcome-delivery assertions cannot drift from the real
 * per-recipient classification (CR-02). A complete delivery instance
 * supplies the signer and network, with only `deliver` replaced.
 */
function makeDeliverManyFromDeliver(deliver: NostrWelcomeDelivery["deliver"]) {
  const delivery = makeWelcomeDelivery({ deliver });
  return delivery.deliverMany.bind(delivery);
}

function makeWelcomeDelivery(
  overrides: Partial<Pick<NostrWelcomeDelivery, "deliver" | "deliverMany">>,
): NostrWelcomeDelivery {
  return Object.assign(
    new NostrWelcomeDelivery({
      signer: testAccount(0).signer,
      network: makeNetwork(async () => ackResponse()),
    }),
    overrides,
  );
}

function makeRuntime(overrides: Partial<GroupRuntimeOptions> = {}) {
  const confirmedNotifications: StateNotification[] = [
    {
      kind: "epochAdvanced",
      commitDigest: new Uint8Array(32).fill(7),
      from: 1,
      to: 2,
    },
  ];
  const confirmPublished = vi.fn<GroupRuntimeOptions["confirmPublished"]>(
    () => confirmedNotifications,
  );
  const publishFailed = vi.fn<GroupRuntimeOptions["publishFailed"]>();
  const save = vi.fn<GroupRuntimeOptions["save"]>(async () => {});
  const deliver = vi.fn<NostrWelcomeDelivery["deliver"]>(async () =>
    ackResponse(),
  );
  const deliverMany = vi.fn(makeDeliverManyFromDeliver(deliver));
  const groupData: MarmotGroupView = {
    relays: RELAYS,
    name: "Runtime fixture",
    description: "Publish and delivery seam",
    adminPubkeys: [testAccount(0).pubkey],
    imageSource: { kind: "none" },
  };

  const options: GroupRuntimeOptions = {
    welcomeDelivery: makeWelcomeDelivery({
      deliver,
      deliverMany,
    }),
    getNetwork: () => makeNetwork(async () => ackResponse()),
    getRelays: () => RELAYS,
    getGroupRef: () => "group-ref",
    getGroupData: () => groupData,
    confirmPublished,
    publishFailed,
    save,
    ...overrides,
  };

  return {
    runtime: new GroupRuntime(options),
    confirmPublished,
    publishFailed,
    save,
    deliver,
    deliverMany,
    confirmedNotifications,
  };
}

const recipient: WelcomeRecipient = {
  pubkey: "f".repeat(64),
  keyPackageEventId: "kp-1",
  keyPackageEvent: {} as NostrEvent,
};

function commitWork(
  extra: Partial<Extract<GroupPublishWork, { kind: "groupEvolution" }>> = {},
): GroupPublishWork {
  return {
    kind: "groupEvolution",
    envelope,
    pending,
    actorPubkey: "a".repeat(64),
    ...extra,
  };
}

describe("GroupRuntime publish acknowledgement", () => {
  it("retries the original signed application after a retention-policy epoch change", async () => {
    const account = testAccount(6);
    const ciphersuite = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );
    const kp = await generateKeyPackage({
      credential: createCredential(account.pubkey),
      signer: account.signer,
      ciphersuiteImpl: ciphersuite,
    });
    const { clientState: state } = await createGroup({
      creatorKeyPackage: kp,
      ciphersuiteImpl: ciphersuite,
      components: [
        adminPolicyEntry([account.pubkey]),
        groupProfileEntry({ name: "retention", description: "" }),
        nostrRoutingEntry({
          nostrGroupId: new Uint8Array(32).fill(7),
          relays: RELAYS,
        }),
        messageRetentionEntry(60n),
      ],
    });
    const peeler = new NostrGroupPeeler(ciphersuite);
    const wrap = vi.spyOn(peeler, "wrapGroupMessage");
    const engine = new MarmotGroupEngine({ state, ciphersuite, peeler });
    const sent = await engine.send({
      kind: "applicationMessage",
      payload: serializeApplicationRumor(
        createChatRumor({
          pubkey: account.pubkey,
          content: "retry me",
          created_at: 100,
        }),
      ),
    });
    if (sent.kind !== "applicationMessage")
      throw new Error("expected application");
    expect(sent.envelope.tags.filter((tag) => tag[0] === "expiration")).toEqual(
      [["expiration", "160"]],
    );
    const originalBytes = new TextEncoder().encode(
      JSON.stringify(sent.envelope),
    );
    const publish = vi
      .fn<NostrNetworkInterface["publish"]>()
      .mockResolvedValueOnce(noAckResponse())
      .mockResolvedValueOnce(ackResponse());
    const audit = new MemoryAuditSink();
    const { runtime, confirmPublished, publishFailed, save } = makeRuntime({
      getNetwork: () => makeNetwork(publish),
      getGroupData: () => getMarmotGroupView(engine.state),
      audit,
      auditContext: { engineId: "retention-retry", dataMode: "full_data" },
    });
    const work: GroupPublishWork = {
      kind: "applicationMessage",
      envelope: sent.envelope,
    };
    await expect(runtime.publishWork(work)).rejects.toThrow(
      /Failed to publish application message/,
    );

    const update = await engine.send({
      kind: "commit",
      actorPubkey: account.pubkey,
      extraProposals: [
        {
          proposalType: appDataUpdateProposalType,
          appDataUpdate: {
            componentId: GROUP_MESSAGE_RETENTION_COMPONENT_ID,
            operation: "update",
            update: encodeMessageRetentionV1(3600n),
          },
        },
      ],
    });
    if (update.kind !== "groupEvolution") throw new Error("expected commit");
    engine.confirmPublished(update.pending);
    expect(engine.state.groupContext.epoch).toBe(state.groupContext.epoch + 1n);
    const groupData = getMarmotGroupView(engine.state);
    expect(groupData).not.toBeNull();
    if (!groupData) throw new Error("expected current group data");
    expect(groupData.messageRetention).toBe(3600n);
    wrap.mockClear();

    const [result] = await runtime.publishEffects({ publish: [work] });
    expect(result.work).toBe(work);
    expect(result.retryPublication).toBe(false);
    expect(publish).toHaveBeenCalledTimes(2);
    for (const [, published] of publish.mock.calls) {
      expect(published).toBe(sent.envelope);
      expect(new TextEncoder().encode(JSON.stringify(published))).toEqual(
        originalBytes,
      );
      expect(published.id).toBe(sent.envelope.id);
      expect(published.created_at).toBe(sent.envelope.created_at);
      expect(published.tags.filter((tag) => tag[0] === "expiration")).toEqual([
        ["expiration", "160"],
      ]);
    }
    expect(wrap).not.toHaveBeenCalled();
    expect(confirmPublished).not.toHaveBeenCalled();
    expect(publishFailed).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    const publications = audit.events.filter(({ kind }) =>
      ["publish_attempt", "publish_outcome", "publish_failure"].includes(
        kind.type,
      ),
    );
    expect(publications).toHaveLength(5);
    for (const { kind } of publications) {
      if (
        kind.type !== "publish_attempt" &&
        kind.type !== "publish_outcome" &&
        kind.type !== "publish_failure"
      )
        throw new Error("expected publication audit");
      expect(kind.msg_id).toBe(sent.envelope.id);
      expect(kind.transport?.nostr_event_id).toBe(sent.envelope.id);
    }
  });

  it("confirms and saves a proposal once a relay acks", async () => {
    const { runtime, confirmPublished, publishFailed, save } = makeRuntime();

    const response = await runtime.publishWork({
      kind: "proposal",
      envelope,
      pending,
    });

    expect(response).toEqual(ackResponse());
    expect(confirmPublished).toHaveBeenCalledWith(pending);
    expect(save).toHaveBeenCalledOnce();
    expect(publishFailed).not.toHaveBeenCalled();
  });

  it("returns a confirmed proposal result when persistence fails", async () => {
    const publish = vi.fn(async () => ackResponse());
    const save = vi.fn(async () => {
      throw new Error("proposal persistence failed");
    });
    const { runtime, confirmPublished, publishFailed } = makeRuntime({
      getNetwork: () => makeNetwork(publish),
      save,
    });

    const [result] = await runtime.publishEffects({
      publish: [{ kind: "proposal", envelope, pending }],
    });

    expect(result).toEqual({
      work: { kind: "proposal", envelope, pending },
      response: ackResponse(),
      notifications: [],
      persistence: {
        kind: "failed",
        error: "proposal persistence failed",
      },
      welcomeDelivery: { kind: "notRequired" },
      retryPublication: false,
    });
    expect(publish).toHaveBeenCalledOnce();
    expect(confirmPublished).toHaveBeenCalledOnce();
    expect(confirmPublished).toHaveBeenCalledWith(pending);
    expect(save).toHaveBeenCalledOnce();
    expect(publishFailed).not.toHaveBeenCalled();
  });

  it("confirms and saves a self-update once a relay acks", async () => {
    const { runtime, confirmPublished, save } = makeRuntime();

    await runtime.publishWork({ kind: "selfUpdate", envelope, pending });

    expect(confirmPublished).toHaveBeenCalledWith(pending);
    expect(save).toHaveBeenCalledOnce();
  });

  it("publishes an application message without confirming pending state", async () => {
    const { runtime, confirmPublished, publishFailed, save } = makeRuntime();

    const response = await runtime.publishWork({
      kind: "applicationMessage",
      envelope,
    });

    expect(response).toEqual(ackResponse());
    expect(confirmPublished).not.toHaveBeenCalled();
    expect(publishFailed).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it("publishes each effect in order via publishEffects", async () => {
    const { runtime, confirmPublished } = makeRuntime();

    const results = await runtime.publishEffects({
      publish: [
        { kind: "applicationMessage", envelope },
        { kind: "proposal", envelope, pending },
      ],
    });

    expect(results).toHaveLength(2);
    expect(results[0].work.kind).toBe("applicationMessage");
    expect(results[0].notifications).toEqual([]);
    expect(results[1].work.kind).toBe("proposal");
    expect(results[1].notifications).toEqual([]);
    expect(confirmPublished).toHaveBeenCalledOnce();
  });

  it("surfaces confirmed commit notifications after publish succeeds", async () => {
    const { runtime, confirmedNotifications } = makeRuntime();

    const [result] = await runtime.publishEffects({ publish: [commitWork()] });

    expect(result.notifications).toEqual(confirmedNotifications);
  });

  it("preserves confirmed notifications when persistence fails", async () => {
    const persistenceError = new Error("disk full");
    const save = vi.fn(async () => {
      throw persistenceError;
    });
    const { runtime, confirmPublished, publishFailed, confirmedNotifications } =
      makeRuntime({ save });

    const [result] = await runtime.publishEffects({ publish: [commitWork()] });

    expect(result.notifications).toBe(confirmedNotifications);
    expect(result.persistence).toEqual({
      kind: "failed",
      error: "disk full",
    });
    expect(result.retryPublication).toBe(false);
    expect(confirmPublished).toHaveBeenCalledOnce();
    expect(publishFailed).not.toHaveBeenCalled();
  });
});

describe("GroupRuntime publish failure", () => {
  it("executes the pinned publish-fail rollback outcome", async () => {
    const step = publishFailFixture.scenario.steps.find(
      (candidate) => candidate.type === "acknowledge_outbound",
    );
    expect(step).toMatchObject({ outcome: "reached_no_endpoint" });
    const publish = vi.fn(async () => noAckResponse());
    const { runtime, confirmPublished, publishFailed, save } = makeRuntime({
      getNetwork: () => makeNetwork(publish),
    });

    await expect(runtime.publishWork(commitWork())).rejects.toThrow(
      /Failed to publish commit/,
    );
    expect(publishFailed).toHaveBeenCalledWith(pending);
    expect(confirmPublished).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(publishFailFixture.expected_trace.observations[0]).toMatchObject({
      epoch: 0,
      member_count: 1,
    });
  });

  it("executes the pinned invite-publish-fail rollback before Welcome delivery", async () => {
    const failed = invitePublishFailFixture.scenario.steps.find(
      (candidate) =>
        candidate.type === "acknowledge_outbound" &&
        candidate.outcome === "reached_no_endpoint",
    );
    expect(failed).toBeDefined();
    const publish = vi.fn(async () => noAckResponse());
    const {
      runtime,
      confirmPublished,
      publishFailed,
      save,
      deliver,
      deliverMany,
    } = makeRuntime({ getNetwork: () => makeNetwork(publish) });

    await expect(
      runtime.publishWork(
        commitWork({
          welcome: welcomeMessage(),
          welcomeRecipients: [recipient],
        }),
      ),
    ).rejects.toThrow(/Failed to publish commit/);
    expect(publishFailed).toHaveBeenCalledWith(pending);
    expect(confirmPublished).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
    expect(deliverMany).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(invitePublishFailFixture.expected_outcomes.at(-1)).toMatchObject({
      type: "client_state",
      epoch: 1,
      member_count: 2,
    });
  });
  it("throws when no relay acknowledges a proposal and never confirms", async () => {
    const publish = vi.fn(async () => noAckResponse());
    const { runtime, confirmPublished, publishFailed, save } = makeRuntime({
      getNetwork: () => makeNetwork(publish),
    });

    await expect(
      runtime.publishWork({ kind: "proposal", envelope, pending }),
    ).rejects.toThrow(/Failed to publish proposal event/);
    expect(publish).toHaveBeenCalledOnce();
    expect(publishFailed).toHaveBeenCalledOnce();
    expect(publishFailed).toHaveBeenCalledWith(pending);
    expect(confirmPublished).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it("throws when the group has no relays", async () => {
    const { runtime } = makeRuntime({ getRelays: () => undefined });

    await expect(
      runtime.publishWork({ kind: "applicationMessage", envelope }),
    ).rejects.toThrow(/no relays available/);
  });
});

describe("GroupRuntime commit rollback", () => {
  it.each(["proposal", "selfUpdate", "groupEvolution"] as const)(
    "closure during %s confirmation prevents persistence and success",
    async (kind) => {
      let closed = false;
      const confirmPublished = vi.fn(() => {
        closed = true;
        return [];
      });
      const { runtime, save, publishFailed } = makeRuntime({
        confirmPublished,
        assertOpen: () => {
          if (closed) throw new Error("Group closed");
        },
      });
      const work =
        kind === "groupEvolution" ? commitWork() : { kind, envelope, pending };
      await expect(runtime.publishEffects({ publish: [work] })).rejects.toThrow(
        "Group closed",
      );
      expect(confirmPublished).toHaveBeenCalledOnce();
      expect(save).not.toHaveBeenCalled();
      expect(publishFailed).not.toHaveBeenCalled();
    },
  );
  it("refuses a late Welcome delivery result after owner closure", async () => {
    let closed = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const deliverMany = vi.fn<NostrWelcomeDelivery["deliverMany"]>(async () => {
      await gate;
      return [];
    });
    const { runtime, publishFailed } = makeRuntime({
      welcomeDelivery: makeWelcomeDelivery({ deliverMany }),
      assertOpen: () => {
        if (closed) throw new Error("Group closed");
      },
    });
    const operation = runtime.publishEffects({
      publish: [
        commitWork({
          welcome: welcomeMessage(),
          welcomeRecipients: [recipient],
        }),
      ],
    });
    let failure = "";
    const settled = operation.catch((error) => {
      failure = String(error);
    });
    await vi.waitFor(() => expect(deliverMany).toHaveBeenCalledOnce());
    closed = true;
    release();
    await settled;
    expect(failure.includes("Group closed")).toBe(true);
    expect(publishFailed).not.toHaveBeenCalled();
  });
  it.each(["proposal", "selfUpdate", "groupEvolution"] as const)(
    "refuses a late %s persistence completion after owner closure",
    async (kind) => {
      let closed = false;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const save = vi.fn(() => gate);
      const { runtime, confirmPublished } = makeRuntime({
        save,
        assertOpen: () => {
          if (closed) throw new Error("Group closed");
        },
      });
      const work =
        kind === "groupEvolution" ? commitWork() : { kind, envelope, pending };
      const operation = runtime.publishEffects({ publish: [work] });
      let failure = "";
      const settled = operation.catch((error) => {
        failure = String(error);
      });
      await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
      closed = true;
      release();
      await settled;
      expect(failure.includes("Group closed")).toBe(true);
      expect(confirmPublished).toHaveBeenCalledOnce();
    },
  );

  it("does not confirm or save a late relay acknowledgement after closure", async () => {
    let closed = false;
    let release!: (response: Record<string, PublishResponse>) => void;
    const gate = new Promise<Record<string, PublishResponse>>((resolve) => {
      release = resolve;
    });
    const publish = vi.fn(() => gate);
    const { runtime, confirmPublished, save } = makeRuntime({
      getNetwork: () => makeNetwork(publish),
      assertOpen: () => {
        if (closed) throw new Error("Group closed");
      },
    });
    const operation = runtime.publishEffects({ publish: [commitWork()] });
    const rejected = expect(operation).rejects.toThrow("Group closed");
    await vi.waitFor(() => expect(publish).toHaveBeenCalledOnce());
    closed = true;
    release(ackResponse());
    await rejected;
    expect(confirmPublished).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });
  it("returns a confirmed failure result when confirmation bookkeeping throws", async () => {
    let lifecycle = "PendingPublish";
    const confirmPublished = vi.fn(() => {
      lifecycle = "Merging";
      try {
        throw new Error("history persistence failed");
      } finally {
        lifecycle = "Stable";
      }
    });
    const { runtime, publishFailed, save } = makeRuntime({ confirmPublished });

    const [result] = await runtime.publishEffects({ publish: [commitWork()] });

    expect(lifecycle).toBe("Stable");
    expect(result.notifications).toEqual([]);
    expect(result.persistence).toEqual({
      kind: "failed",
      error: "history persistence failed",
    });
    expect(result.retryPublication).toBe(false);
    expect(publishFailed).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });
  it("rolls back pending state when the commit fails to publish", async () => {
    const { runtime, confirmPublished, publishFailed, save } = makeRuntime({
      getNetwork: () => makeNetwork(async () => noAckResponse()),
    });

    await expect(runtime.publishWork(commitWork())).rejects.toThrow(
      /Failed to publish commit/,
    );
    expect(publishFailed).toHaveBeenCalledWith(pending);
    expect(confirmPublished).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it("derives no notifications when a commit publish fails", async () => {
    const { runtime, confirmPublished } = makeRuntime({
      getNetwork: () => makeNetwork(async () => noAckResponse()),
    });

    await expect(
      runtime.publishEffects({ publish: [commitWork()] }),
    ).rejects.toThrow(/Failed to publish commit/);
    expect(confirmPublished).not.toHaveBeenCalled();
  });

  it("confirms and saves the commit when a relay acks", async () => {
    const { runtime, confirmPublished, publishFailed, save } = makeRuntime();

    await runtime.publishWork(commitWork());

    expect(confirmPublished).toHaveBeenCalledWith(pending);
    expect(save).toHaveBeenCalledOnce();
    expect(publishFailed).not.toHaveBeenCalled();
  });
});

// Migrated for D-06/D-07 (R-03): `GroupRuntime` now calls
// `NostrWelcomeDelivery.deliverMany()` (per-recipient, never throwing)
// instead of looping `deliver()` and throwing an aggregate error. The
// fixture's `welcomeDelivery` stub gained a `deliverMany` implementation
// that reproduces the real per-recipient semantics by delegating to the
// same `deliver` mock, so the existing `deliver` call-count/argument
// assertions below keep their original meaning while the runtime now
// exercises the interface it actually calls. This is a deliberate migration
// of the tests' shape, not a loosening of intent — see R-03 in
// .planning/phases/10-founding-group-creation-via-welcome/10-CONTEXT.md.
describe("GroupRuntime Welcome delivery", () => {
  const welcome = welcomeMessage();

  it("delivers a Welcome to each recipient after a successful commit", async () => {
    const { runtime, deliver } = makeRuntime();

    const [result] = await runtime.publishEffects({
      publish: [commitWork({ welcome, welcomeRecipients: [recipient] })],
    });

    expect(deliver).toHaveBeenCalledOnce();
    expect(deliver).toHaveBeenCalledWith(
      expect.objectContaining({ recipient, groupRelays: RELAYS }),
    );
    expect(result.welcomeDelivery).toEqual({
      kind: "attempted",
      outcomes: [{ kind: "succeeded", recipient, response: ackResponse() }],
    });
  });

  it("does not deliver Welcomes when there are no recipients", async () => {
    const { runtime, deliver, deliverMany } = makeRuntime();

    const [result] = await runtime.publishEffects({
      publish: [commitWork({ welcome, welcomeRecipients: [] })],
    });

    expect(deliver).not.toHaveBeenCalled();
    expect(deliverMany).not.toHaveBeenCalled();
    expect(result.welcomeDelivery).toEqual({ kind: "notRequired" });
  });

  it("preserves confirmed notifications when Welcome delivery fails", async () => {
    const deliver = vi
      .fn<NostrWelcomeDelivery["deliver"]>()
      .mockResolvedValueOnce(ackResponse())
      .mockRejectedValueOnce(new Error("inbox unreachable"));
    const deliverMany = vi.fn(makeDeliverManyFromDeliver(deliver));
    const { runtime, confirmPublished, publishFailed, confirmedNotifications } =
      makeRuntime({
        welcomeDelivery: makeWelcomeDelivery({
          deliver,
          deliverMany,
        }),
      });

    const second: WelcomeRecipient = { ...recipient, pubkey: "e".repeat(64) };

    const [result] = await runtime.publishEffects({
      publish: [
        commitWork({ welcome, welcomeRecipients: [recipient, second] }),
      ],
    });

    expect(result.notifications).toBe(confirmedNotifications);
    expect(result.persistence).toEqual({ kind: "succeeded" });
    expect(result.welcomeDelivery).toEqual({
      kind: "attempted",
      outcomes: [
        { kind: "succeeded", recipient, response: ackResponse() },
        {
          kind: "failed",
          recipient: second,
          error: expect.stringMatching(/inbox unreachable/),
        },
      ],
    });
    expect(result.retryPublication).toBe(false);
    expect(confirmPublished).toHaveBeenCalledOnce();
    expect(publishFailed).not.toHaveBeenCalled();
    expect(deliver).toHaveBeenCalledTimes(2);
  });

  it("CR-02: an ordinary invite whose Welcome no relay acknowledged reports a failed outcome (real NostrWelcomeDelivery)", async () => {
    const welcomePublish = vi.fn<NostrNetworkInterface["publish"]>(async () =>
      noAckResponse(),
    );
    const welcomeNetwork: NostrNetworkInterface = {
      ...makeNetwork(welcomePublish),
      getUserInboxRelays: async () => ["wss://inbox.test"],
    };
    const welcomeDelivery = new NostrWelcomeDelivery({
      signer: testAccount(0).signer,
      network: welcomeNetwork,
    });

    const cr02Recipient: WelcomeRecipient = {
      pubkey: testAccount(1).pubkey,
      keyPackageEventId: "a".repeat(64),
      keyPackageEvent: {} as NostrEvent,
    };
    // A minimal, real `Welcome` object shaped like the one in
    // welcome-delivery.test.ts; NostrWelcomeDelivery only encodes it into a
    // rumor's content — it does not need to be cryptographically joinable.
    const cr02Welcome: MlsWelcomeMessage = {
      version: protocolVersions.mls10,
      wireformat: wireformats.mls_welcome,
      welcome: {
        cipherSuite: 1,
        secrets: [],
        encryptedGroupInfo: new Uint8Array([1, 2, 3, 4]),
      },
    };

    const { runtime, confirmPublished, publishFailed } = makeRuntime({
      welcomeDelivery,
    });

    const [result] = await runtime.publishEffects({
      publish: [
        commitWork({
          welcome: cr02Welcome,
          welcomeRecipients: [cr02Recipient],
        }),
      ],
    });

    expect(result.welcomeDelivery).toEqual({
      kind: "attempted",
      outcomes: [
        {
          kind: "failed",
          recipient: cr02Recipient,
          error: expect.stringMatching(/^No relay accepted the Welcome/),
        },
      ],
    });
    expect(result.persistence).toEqual({ kind: "succeeded" });
    expect(confirmPublished).toHaveBeenCalledOnce();
    expect(publishFailed).not.toHaveBeenCalled();
    expect(welcomePublish).toHaveBeenCalledOnce();
    expect(welcomePublish.mock.calls[0]![1]).toMatchObject({ kind: 1059 });
  });
});
