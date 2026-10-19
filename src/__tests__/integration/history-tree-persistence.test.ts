import { bytesToHex } from "@noble/hashes/utils.js";
import {
  type ClientConfig,
  createCommit,
  encode,
  mlsMessageEncoder,
  defaultCryptoProvider,
  defaultKeyRetentionConfig,
  defaultProposalTypes,
  getCiphersuiteImpl,
  joinGroup,
  unsafeTestingAuthenticationService,
} from "ts-mls";
import { describe, expect, it } from "vitest";

import { MarmotGroup } from "../../client/group/marmot-group.js";
import {
  GroupRegistry,
  type GroupRegistryOptions,
} from "../../client/group-registry.js";
import { GroupSession } from "../../client/session/group-session.js";
import type { NostrNetworkInterface } from "../../client/nostr-interface.js";
import {
  SerializedClientState,
  deserializeClientState,
  serializeClientState,
} from "../../core/client-state.js";
import { DEFAULT_CONVERGENCE_POLICY } from "../../core/convergence.js";
import { GroupHistoryTree } from "../../engine/history-tree.js";
import { createCredential } from "../../core/credential.js";
import { createGroupEvent } from "../../core/group-message.js";
import { createSimpleGroup } from "../../core/group.js";
import { generateKeyPackage } from "../../core/key-package.js";
import { InMemoryKeyValueStore } from "../../extra/in-memory-key-value-store.js";
import { testAccount } from "../helpers/test-accounts.js";

const NETWORK: NostrNetworkInterface = {
  request: async () => {
    throw new Error("not used");
  },
  subscription: () => {
    throw new Error("not used");
  },
  publish: async () => {
    throw new Error("not used");
  },
  getUserInboxRelays: async () => {
    throw new Error("not used");
  },
};

const MEMBER_ACCOUNT = testAccount(11);
const MEMBER = MEMBER_ACCOUNT.pubkey;
const SIGNER = MEMBER_ACCOUNT.signer;

/** Separate fallback stores; explicit aliasing cases override these below. */
function registryByteStores(): Pick<
  GroupRegistryOptions,
  "ingestStateStore" | "lifecycleStore"
> {
  return {
    ingestStateStore: new InMemoryKeyValueStore<Uint8Array>(),
    lifecycleStore: new InMemoryKeyValueStore<Uint8Array>(),
  };
}

async function drain(gen: AsyncIterable<unknown>): Promise<void> {
  for await (const _ of gen) void _;
}

describe("history tree persistence across restart", () => {
  it.each([false, true])(
    "retries dirty snapshot and own-commit stamp after commit-byte failure forwarding=%s",
    async (forward) => {
      const f = await linearFixture();
      const context = {
        cipherSuite: f.impl,
        authService: unsafeTestingAuthenticationService,
      };
      const result = await createCommit({
        context,
        state: deserializeClientState(serializeClientState(f.state)),
        extraProposals: [],
        wireAsPublicMessage: true,
      });
      const stamp = {
        committer: f.account.pubkey,
        priority: "privileged" as const,
        consumedProposalRefs: [Uint8Array.of(9)],
      };
      const tip = f.tree.recordCommit(
        f.tags.at(-1)!,
        result.commit,
        result.newState,
        undefined,
        stamp,
      );
      const write = f.store.setItem.bind(f.store);
      f.store.setItem = async (key, bytes) => {
        if (key === `${f.gid}/commit/${tip}`) {
          if (forward) await write(key, bytes);
          throw new Error("commit interrupted");
        }
        return write(key, bytes);
      };
      await expect(f.tree.flush()).rejects.toThrow("commit interrupted");
      expect(f.tree.isDirty).toBe(true);
      f.store.setItem = write;
      await f.tree.flush();
      expect(f.tree.isDirty).toBe(false);
      for (let restart = 0; restart < 2; restart++) {
        const loaded = (await GroupHistoryTree.load(f.store, f.gid))!;
        expect(await loaded.ownCommitStampOf(tip)).toEqual(stamp);
        expect(await loaded.snapshotOf(tip)).toEqual(
          serializeClientState(result.newState),
        );
        expect(await loaded.commitBytesOf(tip)).toEqual(
          encode(mlsMessageEncoder, result.commit),
        );
      }
    },
  );

  for (const boundary of ["checkpoint", "state", "edge", "commit"])
    it(`fences ingest, send, confirmation and settlement while ${boundary} publication/deletion is paused`, async () => {
      const f = await linearFixture();
      const options = {
        ciphersuite: f.impl,
        store: new InMemoryKeyValueStore<Uint8Array>(),
        rewindStore: f.store,
        convergencePolicy: {
          ...DEFAULT_CONVERGENCE_POLICY,
          maxRewindCommits: 2,
          appPayloadPastEpochLimit: 0,
        },
      };
      const session = new GroupSession({
        ...options,
        state: f.state,
        historyTree: f.tree,
      });
      const producer = new GroupSession({
        ...options,
        rewindStore: undefined,
        state: deserializeClientState(serializeClientState(f.state)),
      });
      const staged = (await producer.send({ kind: "selfUpdate" })).publish[0];
      if (staged.kind !== "selfUpdate")
        throw new Error("expected genuine staged commit");
      const stale = await createGroupEvent({
        message: (await f.tree.commitMessageOf(f.tags[1]))!,
        state: (await f.tree.stateAt(f.tags[0]))!,
        ciphersuite: f.impl,
      });
      let entered!: () => void, release!: () => void;
      const waiting = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      const set = f.store.setItem.bind(f.store);
      const remove = f.store.removeItem.bind(f.store);
      let armed = true;
      const pause = async (key: string, checkpoint = false) => {
        if (
          armed &&
          (boundary === "checkpoint"
            ? checkpoint
            : key.includes(`/${boundary}/`))
        ) {
          armed = false;
          entered();
          await blocked;
        }
      };
      f.store.setItem = async (key, bytes) => {
        if (key.endsWith("/meta") && bytes[0] === 2) await pause(key, true);
        return set(key, bytes);
      };
      f.store.removeItem = async (key) => {
        await pause(key);
        return remove(key);
      };
      const saving = session.save(true);
      try {
        await waiting;
        expect(() => session.confirmPublished(staged.pending)).toThrow(
          "retention",
        );
        let sent = false,
          ingested = false,
          settled = false;
        const sending = session
          .send({ kind: "applicationMessage", payload: Uint8Array.of(1) })
          .then((result) => {
            sent = true;
            return result;
          });
        const ingesting = drain(session.ingest([stale])).then(() => {
          ingested = true;
        });
        const settling = session.driveConvergence().then(() => {
          settled = true;
        });
        await Promise.resolve();
        await Promise.resolve();
        expect([sent, ingested, settled]).toEqual([false, false, false]);
        release();
        await saving;
        await Promise.all([sending, ingesting, settling]);
        expect([sent, ingested, settled]).toEqual([true, true, true]);
        const winner = bytesToHex(session.state.confirmationTag);
        await session.save(true);
        for (let restart = 0; restart < 2; restart++) {
          const loaded = (await GroupHistoryTree.load(f.store, f.gid))!;
          await loaded.resumeRetentionCleanup();
          expect(loaded.hasNode(winner)).toBe(true);
          expect(
            bytesToHex((await loaded.stateAt(winner))!.confirmationTag),
          ).toBe(winner);
          expect(loaded.hasNode(f.tags[0])).toBe(false);
          expect(await loaded.commitMessageOf(f.tags.at(-1)!)).toBeDefined();
        }
      } finally {
        release();
        f.store.setItem = set;
        f.store.removeItem = remove;
        session.dispose();
        producer.dispose();
      }
    });

  async function linearFixture() {
    const impl = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );
    const account = testAccount(6);
    const kp = await generateKeyPackage({
      credential: createCredential(account.pubkey),
      signer: account.signer,
      ciphersuiteImpl: impl,
    });
    const { clientState: initial } = await createSimpleGroup(
      kp,
      impl,
      "Retention",
      { adminPubkeys: [account.pubkey], relays: ["wss://mock.test"] },
    );
    const context = {
      cipherSuite: impl,
      authService: unsafeTestingAuthenticationService,
      clientConfig: {
        keyRetentionConfig: {
          ...defaultKeyRetentionConfig,
          retainKeysForEpochs: 32,
        },
      } as ClientConfig,
    };
    const tree = new GroupHistoryTree(initial, { snapshotCacheSize: 1 });
    const tags = [tree.rootTag!];
    let state = initial;
    for (let i = 0; i < 8; i++) {
      const committed = await createCommit({
        context,
        state: deserializeClientState(serializeClientState(state)),
        extraProposals: [],
        wireAsPublicMessage: true,
      });
      state = committed.newState;
      tags.push(tree.recordCommit(tags.at(-1)!, committed.commit, state));
    }
    const store = new InMemoryKeyValueStore<Uint8Array>();
    tree.bindStore(store);
    await tree.flush();
    return {
      tree,
      tags,
      store,
      state,
      impl,
      account,
      gid: bytesToHex(initial.groupContext.groupId),
    };
  }

  it("publishes the inclusive default boundary and copied receiver projection before exact-key cleanup", async () => {
    const { tree, tags, store, state, gid } = await linearFixture();
    const live = serializeClientState(state);
    const plan = await tree.prepareRetention({
      canonicalTipTag: tags.at(-1)!,
      ...DEFAULT_CONVERGENCE_POLICY,
    });
    expect(plan.retainedTags).toEqual(tags.slice(3));
    expect(plan.excludedTags).toEqual(tags.slice(0, 3));
    await store.setItem(`${gid}/unrelated`, Uint8Array.of(99));
    await store.setItem(`${gid}00/state/${tags[0]}`, Uint8Array.of(99));
    await tree.publishRetention(plan);
    expect((await store.getItem(`${gid}/meta`))![0]).toBe(2);
    expect(await store.getItem(`${gid}/state/${tags[0]}`)).not.toBeNull();
    expect(serializeClientState(state)).toEqual(live);
    const loaded = (await GroupHistoryTree.load(store, gid, {
      snapshotCacheSize: 1,
    }))!;
    expect(loaded.tags()).toEqual(tags.slice(3));
    expect(loaded.path(tags.at(-1)!)).toEqual(tags.slice(3));
    expect(await loaded.commitMessageOf(tags[3])).toBeDefined();
    const tip = (await loaded.stateAt(tags.at(-1)!))!;
    expect([...tip.historicalReceiverData.keys()]).toEqual([
      3n,
      4n,
      5n,
      6n,
      7n,
    ]);
    expect((await loaded.stateAt(tags[3]))!.historicalReceiverData.size).toBe(
      0,
    );
    await loaded.resumeRetentionCleanup();
    await loaded.resumeRetentionCleanup();
    const clean = JSON.parse(
      new TextDecoder().decode(
        (await store.getItem(`${gid}/meta`))!.subarray(1),
      ),
    );
    expect(clean.projections).toEqual({});
    expect(clean.garbage).toEqual([]);
    const materialized = (await GroupHistoryTree.load(store, gid, {
      snapshotCacheSize: 0,
    }))!;
    expect([
      ...(await materialized.stateAt(
        tags.at(-1)!,
      ))!.historicalReceiverData.keys(),
    ]).toEqual([3n, 4n, 5n, 6n, 7n]);
    for (const tag of tags.slice(0, 3))
      for (const namespace of ["state", "edge", "commit"])
        expect(await store.getItem(`${gid}/${namespace}/${tag}`)).toBeNull();
    expect(await store.getItem(`${gid}/unrelated`)).toEqual(Uint8Array.of(99));
    expect(await store.getItem(`${gid}00/state/${tags[0]}`)).toEqual(
      Uint8Array.of(99),
    );
  });

  it.each([false, true])(
    "reloads recoverable authority when metadata rejects after forwarding=%s",
    async (forward) => {
      const { tree, tags, store, gid } = await linearFixture();
      const plan = await tree.prepareRetention({
        canonicalTipTag: tags.at(-1)!,
        ...DEFAULT_CONVERGENCE_POLICY,
      });
      const original = store.setItem.bind(store);
      store.setItem = async (key, bytes) => {
        if (key === `${gid}/meta` && bytes[0] === 2) {
          if (forward) await original(key, bytes);
          throw new Error("metadata fault");
        }
        return original(key, bytes);
      };
      await expect(tree.publishRetention(plan)).rejects.toThrow(
        "metadata fault",
      );
      store.setItem = original;
      const loaded = (await GroupHistoryTree.load(store, gid))!;
      expect(loaded.tags()).toEqual(forward ? tags.slice(3) : tags);
      for (const tag of loaded.tags())
        expect(await loaded.stateAt(tag)).toBeDefined();
      if (forward) await loaded.resumeRetentionCleanup();
      else {
        await loaded.publishRetention(
          await loaded.prepareRetention({
            canonicalTipTag: tags.at(-1)!,
            ...DEFAULT_CONVERGENCE_POLICY,
          }),
        );
        await loaded.resumeRetentionCleanup();
      }
      expect((await GroupHistoryTree.load(store, gid))!.tags()).toEqual(
        tags.slice(3),
      );
    },
  );

  it("resumes partially forwarded exact garbage deletion after restart", async () => {
    const { tree, tags, store, gid } = await linearFixture();
    await tree.publishRetention(
      await tree.prepareRetention({
        canonicalTipTag: tags.at(-1)!,
        ...DEFAULT_CONVERGENCE_POLICY,
      }),
    );
    const original = store.removeItem.bind(store);
    let once = true;
    store.removeItem = async (key) => {
      await original(key);
      if (once) {
        once = false;
        throw new Error("delete fault");
      }
    };
    await expect(tree.resumeRetentionCleanup()).rejects.toThrow("delete fault");
    store.removeItem = original;
    const loaded = (await GroupHistoryTree.load(store, gid))!;
    await loaded.resumeRetentionCleanup();
    expect(loaded.tags()).toEqual(tags.slice(3));
    expect(await store.getItem(`${gid}/state/${tags[0]}`)).toBeNull();
  });

  it.each([false, true])(
    "keeps previous projected authority recoverable on a repeated checkpoint forwarding=%s",
    async (forward) => {
      const { tree, tags, store, gid } = await linearFixture();
      const canonicalTipTag = tags.at(-1)!;
      await tree.publishRetention(
        await tree.prepareRetention({
          canonicalTipTag,
          maxRewindCommits: 5,
          appPayloadPastEpochLimit: 2,
        }),
      );
      await tree.resumeRetentionCleanup();
      const next = await tree.prepareRetention({
        canonicalTipTag,
        maxRewindCommits: 5,
        appPayloadPastEpochLimit: 0,
      });
      const original = store.setItem.bind(store);
      store.setItem = async (key, bytes) => {
        if (
          key === `${gid}/meta` &&
          bytes[0] === 2 &&
          Object.keys(
            JSON.parse(new TextDecoder().decode(bytes.subarray(1))).projections,
          ).length
        ) {
          if (forward) await original(key, bytes);
          throw new Error("repeat checkpoint fault");
        }
        return original(key, bytes);
      };
      await expect(tree.publishRetention(next)).rejects.toThrow(
        "repeat checkpoint fault",
      );
      store.setItem = original;
      const loaded = (await GroupHistoryTree.load(store, gid))!;
      expect([
        ...(await loaded.stateAt(
          canonicalTipTag,
        ))!.historicalReceiverData.keys(),
      ]).toEqual(forward ? [] : [6n, 7n]);
      await loaded.resumeRetentionCleanup();
    },
  );

  it("fails closed on missing required authoritative snapshot and malformed membership", async () => {
    const { tree, tags, store, gid } = await linearFixture();
    await tree.publishRetention(
      await tree.prepareRetention({
        canonicalTipTag: tags.at(-1)!,
        ...DEFAULT_CONVERGENCE_POLICY,
      }),
    );
    const bytes = (await store.getItem(`${gid}/state/${tags[3]}`))!;
    await store.removeItem(`${gid}/state/${tags[3]}`);
    await expect(GroupHistoryTree.load(store, gid)).rejects.toThrow(
      "required snapshot missing",
    );
    await store.setItem(`${gid}/state/${tags[3]}`, bytes);
    const meta = (await store.getItem(`${gid}/meta`))!;
    const value = JSON.parse(new TextDecoder().decode(meta.subarray(1)));
    value.members.push(value.members[0]);
    const encoded = new TextEncoder().encode(JSON.stringify(value));
    const corrupt = new Uint8Array(encoded.length + 1);
    corrupt[0] = 2;
    corrupt.set(encoded, 1);
    await store.setItem(`${gid}/meta`, corrupt);
    await expect(GroupHistoryTree.load(store, gid)).rejects.toThrow(
      "invalid checkpoint membership",
    );
  });

  it("registry rejects damaged committed history without reseeding the durable winner", async () => {
    const { tree, tags, store, state, gid } = await linearFixture();
    await tree.publishRetention(
      await tree.prepareRetention({
        canonicalTipTag: tags.at(-1)!,
        ...DEFAULT_CONVERGENCE_POLICY,
      }),
    );
    await tree.resumeRetentionCleanup();
    const canonical = serializeClientState(state);
    await store.setItem(gid, canonical);
    await store.removeItem(`${gid}/state/${tags[3]}`);
    const registry = new GroupRegistry({
      ...registryByteStores(),
      store,
      rewindStore: store,
      signer: SIGNER,
      network: NETWORK,
    });
    let rejected = false;
    try {
      const loaded = await registry.load(gid);
      loaded.dispose();
    } catch (error) {
      rejected = String(error).includes("required snapshot missing");
    }
    expect(rejected).toBe(true);
    expect(await store.getItem(gid)).toEqual(canonical);
    expect(registry.loaded).toHaveLength(0);
  });

  for (const boundary of [
    "flush",
    "canonical",
    "evidence",
    "checkpoint",
    "projection",
    "edge",
    "state",
    "commit",
    "acknowledgement",
  ])
    for (const forward of [false, true])
      it(`registry repairs before admission through two restarts at ${boundary} forwarding=${forward}`, async () => {
        const { tree, tags, store, state, gid, impl, account } =
          await linearFixture();
        const canonical = serializeClientState(state);
        await store.setItem(gid, canonical);
        const unrelated = [
          `${gid}/state/custom`,
          `${gid}00/state/${tags[0]}`,
          "application/row",
        ];
        for (const key of unrelated)
          await store.setItem(key, Uint8Array.of(99));
        const keys = store.keys.bind(store);
        store.keys = async () => (await keys()).reverse();
        tree.updateSnapshot(tags.at(-1)!, state);
        const session = new GroupSession({
          state,
          historyTree: tree,
          store,
          rewindStore: store,
          ingestStateStore: store,
          ciphersuite: impl,
        });
        const set = store.setItem.bind(store),
          remove = store.removeItem.bind(store);
        let armed = true,
          published = false;
        async function fault<T>(
          kind: string,
          write: () => Promise<T>,
        ): Promise<T> {
          const hit = armed && kind === boundary;
          if (hit && !forward) {
            armed = false;
            throw new Error("interruption");
          }
          const value = await write();
          if (hit) {
            armed = false;
            throw new Error("interruption");
          }
          return value;
        }
        store.setItem = async (key, bytes) => {
          let kind =
            key === gid
              ? "canonical"
              : key.includes("/delivered-payloads/")
                ? "evidence"
                : published
                  ? "projection"
                  : "flush";
          if (key === `${gid}/meta` && bytes[0] === 2) {
            const metadata = JSON.parse(
              new TextDecoder().decode(bytes.subarray(1)),
            );
            kind = metadata.garbage.length ? "checkpoint" : "acknowledgement";
          }
          return fault(kind, async () => {
            const value = await set(key, bytes);
            if (kind === "checkpoint") published = true;
            return value;
          });
        };
        store.removeItem = async (key) => {
          await fault(key.split("/")[1], () => remove(key));
        };
        await expect(session.save(true)).rejects.toThrow("interruption");
        expect(armed).toBe(false);
        session.dispose();
        store.setItem = set;
        store.removeItem = remove;
        for (let restart = 0; restart < 2; restart++) {
          const registry = new GroupRegistry({
            ...registryByteStores(),
            store,
            rewindStore: store,
            ingestStateStore: store,
            signer: account.signer,
            network: NETWORK,
          });
          const group = await registry.get(gid);
          expect(bytesToHex(group.state.confirmationTag)).toBe(tags.at(-1));
          expect(group.session.historyTree.hasNode(tags.at(-1)!)).toBe(true);
          for (const tag of group.session.historyTree.tags())
            expect(await group.session.historyTree.stateAt(tag)).toBeDefined();
          const metadata = (await store.getItem(`${gid}/meta`))!;
          if (metadata[0] === 2) {
            const value = JSON.parse(
              new TextDecoder().decode(metadata.subarray(1)),
            );
            expect(value.garbage).toEqual([]);
            expect(value.projections).toEqual({});
            expect(group.session.historyTree.tags()).toEqual(tags.slice(3));
            expect(group.session.historyTree.hasNode(tags[0])).toBe(false);
          } else expect(group.session.historyTree.tags()).toEqual(tags);
          for (const key of unrelated)
            expect(await store.getItem(key)).toEqual(Uint8Array.of(99));
          registry.untrack(gid);
        }
      });

  it.each([
    "membership",
    "snapshot",
    "commit",
    "corrupt snapshot",
    "corrupt commit",
    "edge",
    "boundary",
    "checkpoint",
    "canonical tip",
  ])(
    "registry fails closed on required %s corruption across two restarts",
    async (kind) => {
      const { tree, tags, store, state, gid } = await linearFixture();
      const excludedCanonical = serializeClientState(
        (await tree.stateAt(tags[0]))!,
      );
      await tree.publishRetention(
        await tree.prepareRetention({
          canonicalTipTag: tags.at(-1)!,
          ...DEFAULT_CONVERGENCE_POLICY,
        }),
      );
      await tree.resumeRetentionCleanup();
      let canonical = serializeClientState(state);
      if (kind === "canonical tip") canonical = excludedCanonical;
      await store.setItem(gid, canonical);
      if (["snapshot", "commit", "edge"].includes(kind))
        await store.removeItem(
          `${gid}/${kind === "snapshot" ? "state" : kind}/${tags[3]}`,
        );
      else if (kind === "checkpoint") await store.removeItem(`${gid}/meta`);
      else if (kind.startsWith("corrupt"))
        await store.setItem(
          `${gid}/${kind === "corrupt snapshot" ? "state" : "commit"}/${tags[3]}`,
          Uint8Array.of(0),
        );
      else if (kind !== "canonical tip") {
        const meta = (await store.getItem(`${gid}/meta`))!;
        const value = JSON.parse(new TextDecoder().decode(meta.subarray(1)));
        if (kind === "membership") value.members.push(value.members[0]);
        if (kind === "boundary")
          value.boundary = { ...value.boundary, digest: "00" };
        const encoded = new TextEncoder().encode(JSON.stringify(value));
        const damaged = new Uint8Array(encoded.length + 1);
        damaged[0] = 2;
        damaged.set(encoded, 1);
        await store.setItem(`${gid}/meta`, damaged);
      }
      for (let restart = 0; restart < 2; restart++) {
        const registry = new GroupRegistry({
          ...registryByteStores(),
          store,
          rewindStore: store,
          signer: SIGNER,
          network: NETWORK,
        });
        await expect(registry.get(gid)).rejects.toThrow("GroupHistoryTree:");
        expect(registry.loaded).toHaveLength(0);
        expect(await store.getItem(gid)).toEqual(canonical);
      }
    },
  );

  it("loads genuinely absent and version-1 history, and treats below-anchor absence as stale", async () => {
    const { tree, tags, store, state, gid } = await linearFixture();
    await store.setItem(gid, serializeClientState(state));
    const options = {
      ...registryByteStores(),
      store,
      rewindStore: store,
      signer: SIGNER,
      network: NETWORK,
    };
    const legacy = await new GroupRegistry(options).load(gid);
    expect(legacy.session.historyTree.tags()).toEqual(tags);
    legacy.dispose();
    await tree.publishRetention(
      await tree.prepareRetention({
        canonicalTipTag: tags.at(-1)!,
        ...DEFAULT_CONVERGENCE_POLICY,
      }),
    );
    const bounded = await new GroupRegistry(options).load(gid);
    expect(await bounded.session.historyTree.stateAt(tags[0])).toBeUndefined();
    expect(bounded.session.historyTree.path(tags[0])).toBeUndefined();
    expect(bounded.session.historyTree.tags()).toEqual(tags.slice(3));
    bounded.dispose();
    const empty = new InMemoryKeyValueStore<Uint8Array>();
    await empty.setItem(gid, serializeClientState(state));
    const fresh = await new GroupRegistry({
      ...registryByteStores(),
      ...options,
      store: empty,
      rewindStore: empty,
    }).load(gid);
    expect(fresh.session.historyTree.tags()).toEqual([tags.at(-1)]);
    fresh.dispose();
  });

  it("awaits cleanup acknowledgement before constructing an admitted group", async () => {
    const { tree, tags, store, state, gid } = await linearFixture();
    await tree.publishRetention(
      await tree.prepareRetention({
        canonicalTipTag: tags.at(-1)!,
        ...DEFAULT_CONVERGENCE_POLICY,
      }),
    );
    await store.setItem(gid, serializeClientState(state));
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const set = store.setItem.bind(store);
    store.setItem = async (key, bytes) => {
      if (key === `${gid}/meta`) {
        enter();
        await gate;
      }
      return set(key, bytes);
    };
    const registry = new GroupRegistry({
      ...registryByteStores(),
      store,
      rewindStore: store,
      signer: SIGNER,
      network: NETWORK,
    });
    const build = registry.build.bind(registry);
    let constructed = false;
    registry.build = async (...args) => {
      constructed = true;
      return build(...args);
    };
    const loading = registry.load(gid);
    await entered;
    expect(constructed).toBe(false);
    expect(registry.loaded).toHaveLength(0);
    release();
    const loaded = await loading;
    expect(constructed).toBe(true);
    loaded.dispose();
  });

  for (const boundary of [
    "projection",
    "edge",
    "state",
    "commit",
    "acknowledgement",
  ])
    for (const forward of [false, true])
      it(`refuses registry activation until cleanup succeeds at ${boundary} forwarding=${forward}`, async () => {
        const { tree, tags, store, state, gid } = await linearFixture();
        await tree.publishRetention(
          await tree.prepareRetention({
            canonicalTipTag: tags.at(-1)!,
            ...DEFAULT_CONVERGENCE_POLICY,
          }),
        );
        const canonical = serializeClientState(state);
        await store.setItem(gid, canonical);
        const set = store.setItem.bind(store),
          remove = store.removeItem.bind(store);
        let armed = true;
        async function fault<T>(
          kind: string,
          operation: () => Promise<T>,
        ): Promise<T> {
          if (!armed || kind !== boundary) {
            return operation();
          }
          armed = false;
          if (forward) await operation();
          throw new Error("cleanup interruption");
        }
        store.setItem = async (key, bytes) => {
          return fault(
            key === `${gid}/meta` ? "acknowledgement" : "projection",
            () => set(key, bytes),
          );
        };
        store.removeItem = async (key) => {
          await fault(key.split("/")[1], () => remove(key));
        };
        const registry = new GroupRegistry({
          ...registryByteStores(),
          store,
          rewindStore: store,
          signer: SIGNER,
          network: NETWORK,
        });
        const build = registry.build.bind(registry);
        let constructed = 0;
        registry.build = async (...args) => {
          constructed++;
          return build(...args);
        };
        await expect(registry.get(gid)).rejects.toThrow("cleanup interruption");
        expect(armed).toBe(false);
        expect(constructed).toBe(0);
        expect(registry.loaded).toHaveLength(0);
        expect(await store.getItem(gid)).toEqual(canonical);
        store.setItem = set;
        store.removeItem = remove;
        for (let restart = 0; restart < 2; restart++) {
          const loaded = await registry.load(gid);
          expect(loaded.session.historyTree.tags()).toEqual(tags.slice(3));
          for (const tag of tags.slice(3))
            expect(await loaded.session.historyTree.stateAt(tag)).toBeDefined();
          loaded.dispose();
        }
      });

  it("keeps a retained competing branch usable after registry cleanup and two restarts", async () => {
    const { tree, tags, store, state, gid, impl } = await linearFixture();
    const parent = (await tree.stateAt(tags[7]))!;
    const sibling = await createCommit({
      context: {
        cipherSuite: impl,
        authService: unsafeTestingAuthenticationService,
      },
      state: parent,
      extraProposals: [],
      wireAsPublicMessage: true,
    });
    const siblingTag = tree.recordCommit(
      tags[7],
      sibling.commit,
      sibling.newState,
    );
    await tree.publishRetention(
      await tree.prepareRetention({
        canonicalTipTag: tags.at(-1)!,
        ...DEFAULT_CONVERGENCE_POLICY,
      }),
    );
    await store.setItem(gid, serializeClientState(state));
    for (let restart = 0; restart < 2; restart++) {
      const registry = new GroupRegistry({
        ...registryByteStores(),
        store,
        rewindStore: store,
        signer: SIGNER,
        network: NETWORK,
      });
      const loaded = await registry.load(gid);
      expect(loaded.session.historyTree.childrenOf(tags[7])).toContain(
        siblingTag,
      );
      expect(
        await loaded.session.historyTree.commitMessageOf(siblingTag),
      ).toBeDefined();
      const retained = (await loaded.session.historyTree.stateAt(siblingTag))!;
      expect(
        (
          await createCommit({
            context: {
              cipherSuite: impl,
              authService: unsafeTestingAuthenticationService,
            },
            state: retained,
            extraProposals: [],
            wireAsPublicMessage: true,
          })
        ).newState.groupContext.epoch,
      ).toBe(9n);
      expect(loaded.session.historyTree.hasNode(tags[0])).toBe(false);
      loaded.dispose();
    }
  });
  it("retains both fork branches in the tree and reloads them after a restart", async () => {
    const impl = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );
    const ctx = {
      cipherSuite: impl,
      authService: unsafeTestingAuthenticationService,
    };

    const adminAccount = testAccount(6);
    const adminKp = await generateKeyPackage({
      credential: createCredential(adminAccount.pubkey),
      signer: adminAccount.signer,
      ciphersuiteImpl: impl,
    });
    const { clientState: created } = await createSimpleGroup(
      adminKp,
      impl,
      "Test Group",
      {
        adminPubkeys: [adminAccount.pubkey],
        relays: ["wss://mock-relay.test"],
      },
    );
    const memberKp = await generateKeyPackage({
      credential: createCredential(MEMBER),
      signer: MEMBER_ACCOUNT.signer,
      ciphersuiteImpl: impl,
    });
    const { newState: adminE1, welcome } = await createCommit({
      context: ctx,
      state: created,
      wireAsPublicMessage: false,
      extraProposals: [
        {
          proposalType: defaultProposalTypes.add,
          add: { keyPackage: memberKp.publicPackage },
        },
      ],
      ratchetTreeExtension: true,
    });
    if (!welcome) throw new Error("expected the Add commit Welcome");
    const memberE1 = await joinGroup({
      context: ctx,
      welcome: welcome.welcome,
      keyPackage: memberKp.publicPackage,
      privateKeys: memberKp.privatePackage,
      ratchetTree: undefined,
    });
    const groupId = bytesToHex(memberE1.groupContext.groupId);

    const commitA = await createCommit({
      context: ctx,
      state: adminE1,
      extraProposals: [],
    });
    const commitB = await createCommit({
      context: ctx,
      state: adminE1,
      extraProposals: [],
    });
    const eventA = await createGroupEvent({
      message: commitA.commit,
      state: adminE1,
      ciphersuite: impl,
    });
    const eventB = await createGroupEvent({
      message: commitB.commit,
      state: adminE1,
      ciphersuite: impl,
    });

    const store = new InMemoryKeyValueStore<SerializedClientState>();
    const rewindStore = new InMemoryKeyValueStore<Uint8Array>();
    const rootTag = bytesToHex(memberE1.confirmationTag);

    // Session 1: ingest both competing commits → the tree retains the fork.
    const first = new MarmotGroup(memberE1, {
      store,
      rewindStore,
      signer: SIGNER,
      ciphersuite: impl,
      network: NETWORK,
    });
    await drain(first.ingest([eventA]));
    await drain(first.ingest([eventB]));
    expect(first.session.historyTree.childrenOf(rootTag)).toHaveLength(2);
    await first.session.save();
    first.dispose();

    // The tree's edge keys were written under the group prefix.
    const keys = await rewindStore.keys();
    expect(keys.some((k) => k.startsWith(`${groupId}/edge/`))).toBe(true);

    // Restart through the real load path.
    const registry = new GroupRegistry({
      ...registryByteStores(),
      store,
      rewindStore,
      signer: SIGNER,
      network: NETWORK,
    });
    const reloaded = await registry.load(groupId);

    const tree = reloaded.session.historyTree;
    expect(tree.rootTag).toBe(rootTag);
    expect(tree.size).toBe(3);
    expect(tree.childrenOf(rootTag)).toHaveLength(2);

    // Heavy snapshots lazily reload from the store for both retained branches.
    for (const child of tree.childrenOf(rootTag)) {
      const state = await tree.stateAt(child);
      expect(state).toBeDefined();
      expect(bytesToHex(state!.confirmationTag)).toBe(child);
    }
  });
});
