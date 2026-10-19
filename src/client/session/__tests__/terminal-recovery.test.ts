import {
  createCommit,
  defaultCryptoProvider,
  getCiphersuiteImpl,
  unsafeTestingAuthenticationService,
} from "ts-mls";
import { describe, expect, it, vi } from "vitest";
import { createCredential } from "../../../core/credential.js";
import { createSimpleGroup } from "../../../core/group.js";
import { generateKeyPackage } from "../../../core/key-package.js";
import { testAccount } from "../../../__tests__/helpers/test-accounts.js";
import { MockNetwork } from "../../../__tests__/helpers/mock-network.js";
import { InMemoryKeyValueStore } from "../../../extra/in-memory-key-value-store.js";
import { GroupRegistry } from "../../group-registry.js";
import { GroupTerminalError, MarmotGroup } from "../../group/marmot-group.js";
import {
  ConvergenceEffectLedger,
  TerminalWrapperLedger,
} from "../../group/wrapper-ledger.js";
import { GroupSession } from "../group-session.js";
import { GroupHistoryTree } from "../../../engine/history-tree.js";
import {
  deserializeClientState,
  serializeClientState,
} from "../../../core/client-state.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { DEFAULT_CONVERGENCE_POLICY } from "../../../core/convergence.js";
import { getEventHash } from "applesauce-core/helpers/event";
import { serializeApplicationRumor } from "../../../core/group-message.js";
import {
  encodeDeliveredEvidence,
  decodeDeliveredEvidence,
} from "../delivered-payload-store.js";

async function fixture() {
  const account = testAccount(6);
  const ciphersuite = await getCiphersuiteImpl(
    "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
    defaultCryptoProvider,
  );
  const kp = await generateKeyPackage({
    credential: createCredential(account.pubkey),
    ciphersuiteImpl: ciphersuite,
    signer: account.signer,
  });
  const { clientState } = await createSimpleGroup(
    kp,
    ciphersuite,
    "terminal recovery",
    { adminPubkeys: [account.pubkey], relays: ["wss://relay.test"] },
  );
  const store = new InMemoryKeyValueStore<Uint8Array>();
  const lifecycleStore = new InMemoryKeyValueStore<Uint8Array>();
  const network = new MockNetwork(["wss://relay.test"]);
  const options = {
    store,
    lifecycleStore,
    ingestStateStore: new InMemoryKeyValueStore<Uint8Array>(),
    network,
    signer: account.signer,
    ciphersuite,
  };
  const group = new MarmotGroup(clientState, options);
  await group.save(true);
  const evidence = {
    actorPubkey: account.pubkey,
    commitDigest: new Uint8Array(32).fill(4),
    parentTag: "parent",
    sourceEpoch: 0,
    terminalOutcome: "disbanded" as const,
  };
  return { group, options, evidence };
}

describe("terminal persistence interruption", () => {
  for (const boundary of ["intent/v1", "terminal", "registry-state", "cleanup"])
    for (const forwarding of ["before", "after"] as const)
      it(`fences live use and restores durable authority ${forwarding} ${boundary}`, async () => {
        const { group, options, evidence } = await fixture();
        let armed = true;
        const writes: string[] = [];
        const faultStore = {
          ...options.lifecycleStore,
          getItem: (key: string) => options.lifecycleStore.getItem(key),
          keys: () => options.lifecycleStore.keys(),
          clear: () => options.lifecycleStore.clear(),
          removeItem: async (key: string) => {
            const hit = armed && boundary === "cleanup";
            if (hit && forwarding === "before") {
              armed = false;
              throw new Error("crash");
            }
            await options.lifecycleStore.removeItem(key);
            if (hit) {
              armed = false;
              throw new Error("crash");
            }
          },
          setItem: async (key: string, value: Uint8Array) => {
            // The live fence precedes even the first adapter call.
            expect(crashing.status).toBe("disbanded");
            writes.push(key);
            const hit = armed && key.endsWith(`/disband/${boundary}`);
            if (hit && forwarding === "before") {
              armed = false;
              throw new Error("crash");
            }
            const result = await options.lifecycleStore.setItem(key, value);
            if (hit) {
              armed = false;
              throw new Error("crash");
            }
            return result;
          },
        };
        const crashing = new MarmotGroup(group.state, {
          ...options,
          lifecycleStore: faultStore,
        });
        await expect(
          crashing.session.persistSelectedDisband(evidence),
        ).rejects.toThrow("crash");
        expect(crashing.status).toBe("disbanded");
        await expect(crashing.selfUpdate()).rejects.toBeInstanceOf(
          GroupTerminalError,
        );
        expect(writes[0]).toBe(`${group.idStr}/disband/intent/v1`);
        crashing.dispose();
        group.dispose();
        const expected =
          boundary === "intent/v1" && forwarding === "before"
            ? "active"
            : "disbanded";
        for (let restart = 0; restart < 2; restart++) {
          const registry = new GroupRegistry(options);
          const restored = await registry.get(group.id);
          expect(restored.status).toBe(expected);
          if (expected === "disbanded")
            await expect(restored.selfUpdate()).rejects.toBeInstanceOf(
              GroupTerminalError,
            );
          registry.untrack(group.id);
        }
      });
});

describe("terminal work ownership", () => {
  it.each([false, true])(
    "settles an admitted history save before terminal purge (throws after forwarding: %s)",
    async (throwAfterForwarding) => {
      const { group, options, evidence } = await fixture();
      let enter!: () => void;
      let release!: () => void;
      let reachCleanup!: () => void;
      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      const paused = new Promise<void>((resolve) => {
        release = resolve;
      });
      const cleanupReached = new Promise<void>((resolve) => {
        reachCleanup = resolve;
      });
      const rows: Uint8Array[] = [];
      const history = {
        saveMessage: vi.fn(async (payload: Uint8Array) => {
          enter();
          await paused;
          rows.push(payload.slice());
          if (throwAfterForwarding)
            throw new Error("save forwarded before failure");
        }),
        purgeMessages: vi.fn(async () => {
          rows.length = 0;
        }),
        removeMessage: vi.fn(async () => {}),
      };
      const remove = options.store.removeItem.bind(options.store);
      const cleanup = vi
        .spyOn(options.store, "removeItem")
        .mockImplementation(async (key) => {
          await remove(key);
          reachCleanup();
        });
      const historyError = vi.fn();
      const session = new GroupSession({
        state: group.state,
        ciphersuite: options.ciphersuite,
        store: options.store,
        lifecycleStore: options.lifecycleStore,
        history,
        onHistoryError: historyError,
      });
      const rumor = {
        id: "",
        pubkey: evidence.actorPubkey,
        created_at: 1000,
        kind: 9,
        tags: [],
        content: "admitted plaintext",
      };
      rumor.id = getEventHash(rumor);
      const sending = session.send({
        kind: "applicationMessage",
        payload: serializeApplicationRumor(rumor),
      });
      const rejected = expect(sending).rejects.toThrow("Group disbanded");
      await entered;
      let terminalComplete = false;
      const terminal = session.persistSelectedDisband(evidence).then(() => {
        terminalComplete = true;
      });
      try {
        await cleanupReached;
        // Give every unblocked continuation a turn; cleanup must remain behind
        // the paused adapter, rather than purging first and accepting its row later.
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        expect(session.terminalTombstone).toBeDefined();
        expect(terminalComplete).toBe(false);
        expect(history.purgeMessages).not.toHaveBeenCalled();
        await expect(
          session.send({
            kind: "applicationMessage",
            payload: serializeApplicationRumor(rumor),
          }),
        ).rejects.toThrow("Group disbanded");
        expect(history.saveMessage).toHaveBeenCalledOnce();
      } finally {
        release();
        await terminal;
        await rejected;
        cleanup.mockRestore();
        session.dispose();
        group.dispose();
      }
      expect(terminalComplete).toBe(true);
      expect(history.purgeMessages).toHaveBeenCalledOnce();
      expect(rows).toEqual([]);
      expect(historyError).toHaveBeenCalledTimes(throwAfterForwarding ? 1 : 0);
    },
  );

  it.each(["before", "after"] as const)(
    "keeps pending retraction provenance across two restarts and an acknowledgement crash %s forwarding",
    async (forwarding) => {
      const { group, options, evidence } = await fixture();
      const shared = options.lifecycleStore;
      const copy = {
        getItem: (key: string) => shared.getItem(key),
        setItem: (key: string, value: Uint8Array) => shared.setItem(key, value),
        removeItem: (key: string) => shared.removeItem(key),
        keys: () => shared.keys(),
        clear: () => shared.clear(),
      };
      const source = new GroupSession({
        state: group.state,
        ciphersuite: options.ciphersuite,
        store: options.store,
        ingestStateStore: shared,
        rewindStore: copy,
      });
      const rumor = {
        id: "",
        pubkey: options.signer
          ? await options.signer.getPublicKey()
          : evidence.actorPubkey,
        created_at: 1000,
        kind: 9,
        tags: [],
        content: "terminal retraction",
      };
      rumor.id = getEventHash(rumor);
      await source.send({
        kind: "applicationMessage",
        payload: serializeApplicationRumor(rumor),
      });
      await source.save(true);
      const deliveredKey = `${group.idStr}/delivered-payloads/v1`;
      const delivered = decodeDeliveredEvidence(
        (await shared.getItem(deliveredKey))!,
        source.historyTree,
      );
      expect(delivered.entries).toHaveLength(1);
      await shared.setItem(
        deliveredKey,
        encodeDeliveredEvidence({ entries: [], pending: delivered.entries }),
      );
      // Age the genuine producing state outside a finite horizon before
      // terminal selection. Pending withdrawal owns the old snapshot/edge,
      // independently of the absorbing terminal authority.
      let retainedTip = source.state;
      const retainedTree = source.historyTree;
      source.dispose();
      for (let epoch = 0; epoch < 3; epoch++) {
        const next = await createCommit({
          context: {
            cipherSuite: options.ciphersuite,
            authService: unsafeTestingAuthenticationService,
          },
          state: deserializeClientState(serializeClientState(retainedTip)),
          extraProposals: [],
          wireAsPublicMessage: true,
        });
        retainedTree.recordCommit(
          bytesToHex(retainedTip.confirmationTag),
          next.commit,
          next.newState,
        );
        retainedTip = next.newState;
      }
      await retainedTree.publishRetention(
        await retainedTree.prepareRetention({
          canonicalTipTag: bytesToHex(retainedTip.confirmationTag),
          maxRewindCommits: 1,
          appPayloadPastEpochLimit: 1,
          pins: delivered.entries.map((entry) => ({
            stateTag: entry.stateTag,
            reason: "retraction" as const,
          })),
        }),
      );
      await retainedTree.resumeRetentionCleanup();
      await options.store.setItem(
        group.idStr,
        serializeClientState(retainedTip),
      );
      let historyFails = true;
      const rows = new Set([rumor.id]);
      const history = {
        saveMessage: vi.fn(async () => {}),
        purgeMessages: vi.fn(async () => {
          rows.clear();
        }),
        removeMessage: vi.fn(async (id: string) => {
          if (historyFails) throw new Error("history unavailable");
          rows.delete(id);
        }),
      };
      async function restart() {
        const tree = await GroupHistoryTree.load(copy, group.idStr);
        expect(tree).toBeDefined();
        return new GroupSession({
          state: retainedTip,
          ciphersuite: options.ciphersuite,
          store: options.store,
          lifecycleStore: shared,
          ingestStateStore: copy,
          rewindStore: copy,
          historyTree: tree,
          convergencePolicy: {
            ...DEFAULT_CONVERGENCE_POLICY,
            maxRewindCommits: 1,
            appPayloadPastEpochLimit: 1,
          },
          history,
        });
      }
      const first = await restart();
      await first.persistSelectedDisband(evidence);
      expect(
        decodeDeliveredEvidence(
          (await shared.getItem(deliveredKey))!,
          first.historyTree,
        ).pending,
      ).toHaveLength(1);
      first.dispose();
      for (let i = 0; i < 2; i++) {
        const restored = await restart();
        await restored.hydrateLifecycleEvidence();
        expect(restored.terminalTombstone).toBeDefined();
        expect(
          decodeDeliveredEvidence(
            (await shared.getItem(deliveredKey))!,
            restored.historyTree,
          ).pending,
        ).toHaveLength(1);
        expect(await shared.getItem(`${group.idStr}/meta`)).not.toBeNull();
        expect(
          restored.historyTree.epochOf(delivered.entries[0].stateTag),
        ).toBe(0);
        expect(
          await restored.historyTree.stateAt(delivered.entries[0].stateTag),
        ).toBeDefined();
        expect(restored.historyTree.size).toBe(4);
        expect(history.purgeMessages).not.toHaveBeenCalled();
        restored.dispose();
      }
      const acknowledging = await restart();
      await acknowledging.hydrateLifecycleEvidence();
      historyFails = false;
      let armed = true;
      const write = shared.setItem.bind(shared);
      const fault = vi
        .spyOn(shared, "setItem")
        .mockImplementation(async (key, bytes) => {
          const hit = armed && key === deliveredKey;
          if (hit && forwarding === "before") {
            armed = false;
            throw new Error("ack crash");
          }
          const value = await write(key, bytes);
          if (hit) {
            armed = false;
            throw new Error("ack crash");
          }
          return value;
        });
      for await (const _ of acknowledging.ingest([])) {
        /* fully drain acknowledgement attempt */
      }
      fault.mockRestore();
      expect(rows.has(rumor.id)).toBe(false);
      expect(
        decodeDeliveredEvidence(
          (await shared.getItem(deliveredKey))!,
          acknowledging.historyTree,
        ).pending,
      ).toHaveLength(forwarding === "before" ? 1 : 0);
      acknowledging.dispose();
      const final = await restart();
      await final.hydrateLifecycleEvidence();
      for await (const _ of final.ingest([])) {
        /* retry any surviving acknowledgement */
      }
      expect(await shared.getItem(deliveredKey)).toBeNull();
      expect(await shared.getItem(`${group.idStr}/meta`)).toBeNull();
      expect(
        await shared.getItem(`${group.idStr}/disband/terminal`),
      ).not.toBeNull();
      final.dispose();
      group.dispose();
    },
  );

  it("keeps authority and unacknowledged effects across aliased stores and terminal ingest", async () => {
    const { group, options, evidence } = await fixture();
    const shared = options.lifecycleStore;
    const session = new GroupSession({
      state: group.state,
      ciphersuite: options.ciphersuite,
      store: shared,
      lifecycleStore: shared,
      ingestStateStore: shared,
      rewindStore: shared,
    });
    await session.save(true);
    const ledger = new ConvergenceEffectLedger(shared, group.idStr);
    await ledger.prepareWithdrawal(evidence.commitDigest, 0, []);
    const wrappers = new TerminalWrapperLedger(shared, group.idStr);
    await wrappers.begin("unfinished", "parent-hash");
    await wrappers.record("completed", "accepted");
    await shared.setItem(
      `${group.idStr}/application-owned`,
      new Uint8Array([7]),
    );
    await session.persistSelectedDisband(evidence);
    expect(
      await shared.getItem(`${group.idStr}/disband/intent/v1`),
    ).not.toBeNull();
    expect(
      await shared.getItem(`${group.idStr}/disband/terminal`),
    ).not.toBeNull();
    expect(
      await shared.getItem(`${group.idStr}/disband/registry-state`),
    ).not.toBeNull();
    expect(
      await shared.getItem(`${group.idStr}/ingest/wrapper/v1/unfinished`),
    ).not.toBeNull();
    expect(
      await shared.getItem(`${group.idStr}/ingest/wrapper/v1/completed`),
    ).toBeNull();
    expect(await shared.getItem(`${group.idStr}/application-owned`)).toEqual(
      new Uint8Array([7]),
    );
    const results = [];
    for await (const result of session.ingest([])) results.push(result);
    expect(results).toMatchObject([{ kind: "stateInvalidated", forkEpoch: 0 }]);
    const effect = results[0];
    if (effect.kind !== "stateInvalidated")
      throw new Error("expected pending withdrawal");
    // Callback attempts/activation cannot consume an application's effect ack.
    for (let restart = 0; restart < 2; restart++) {
      const restored = new GroupSession({
        state: group.state,
        ciphersuite: options.ciphersuite,
        store: shared,
        lifecycleStore: shared,
        ingestStateStore: shared,
      });
      await restored.hydrateLifecycleEvidence();
      const pending = await restored.driveConvergence();
      expect(pending).toMatchObject([
        { kind: "stateInvalidated", forkEpoch: 0 },
      ]);
      restored.dispose();
    }
    const fault = vi
      .spyOn(shared, "setItem")
      .mockRejectedValueOnce(new Error("ack crash"));
    await expect(session.acknowledgeConvergenceEffect(effect)).rejects.toThrow(
      "ack crash",
    );
    fault.mockRestore();
    expect(await ledger.pending()).toHaveLength(1);
    await session.acknowledgeConvergenceEffect(effect);
    expect(await ledger.pending()).toEqual([]);
    for (let restart = 0; restart < 2; restart++) {
      const restored = new GroupSession({
        state: group.state,
        ciphersuite: options.ciphersuite,
        store: shared,
        lifecycleStore: shared,
        ingestStateStore: shared,
      });
      await restored.hydrateLifecycleEvidence();
      expect(await restored.driveConvergence()).toEqual([]);
      expect(
        await new ConvergenceEffectLedger(shared, group.idStr).pending(),
      ).toEqual([]);
      expect(await shared.getItem(`${group.idStr}/application-owned`)).toEqual(
        Uint8Array.of(7),
      );
      expect(
        await shared.getItem(`${group.idStr}/ingest/wrapper/v1/unfinished`),
      ).not.toBeNull();
      restored.dispose();
    }
    const registry = new GroupRegistry({
      ...options,
      store: shared,
      lifecycleStore: shared,
      ingestStateStore: shared,
      rewindStore: shared,
    });
    expect((await registry.get(group.id)).status).toBe("disbanded");
    registry.untrack(group.id);
    session.dispose();
    group.dispose();
  });

  it("purges only tree-owned keys when stores share their keyspace", async () => {
    const { group, options } = await fixture();
    const shared = options.lifecycleStore;
    for (const suffix of [
      "meta",
      "edge/node",
      "state/node",
      "commit/node",
      "disband/terminal",
      "ingest/effect/v1/pending",
      "application-owned",
    ])
      await shared.setItem(`${group.idStr}/${suffix}`, new Uint8Array([1]));
    await GroupHistoryTree.purge(shared, group.idStr);
    expect(await shared.keys()).toEqual([
      `${group.idStr}/disband/terminal`,
      `${group.idStr}/ingest/effect/v1/pending`,
      `${group.idStr}/application-owned`,
    ]);
    group.dispose();
  });
});
