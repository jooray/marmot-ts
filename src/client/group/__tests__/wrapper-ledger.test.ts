import { bytesToHex } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";
import { InMemoryKeyValueStore } from "../../../extra/in-memory-key-value-store.js";
import {
  ConvergenceEffectLedger,
  TerminalWrapperLedger,
} from "../wrapper-ledger.js";

const id = "ab".repeat(32);
const digest = new Uint8Array(32).fill(3);

describe("retention-attributed wrapper evidence", () => {
  it("stores authenticated source separately from local completion", async () => {
    const store = new InMemoryKeyValueStore<Uint8Array>();
    const ledger = new TerminalWrapperLedger(store, "group");
    await ledger.record(id, "accepted", { sourceEpoch: 1 });
    const value = JSON.parse(
      new TextDecoder().decode(
        (await store.getItem(`group/ingest/wrapper/v1/${id}`))!,
      ),
    );
    expect(
      value.sourceEpoch === 1 && value.completedAtEpoch === undefined,
    ).toBe(true);
  });

  it("retains equality, pins, unfinished, corrupt and exact-prefix neighbors", async () => {
    const store = new InMemoryKeyValueStore<Uint8Array>();
    const ledger = new TerminalWrapperLedger(store, "group");
    await ledger.compactRetained(2, 3);
    expect(await store.keys()).toEqual([]);
    await ledger.record(id, "accepted", { sourceEpoch: 1 });
    await ledger.compactRetained(2, 3, new Set([id]));
    expect(await ledger.get(id)).toBe("accepted");
    await ledger.compactRetained(1, 3);
    expect(await ledger.get(id)).toBe("accepted");
    await ledger.compactRetained(2, 3);
    expect(await ledger.get(id)).toBeUndefined();
    const pending = "cd".repeat(32);
    await ledger.begin(pending, "prior");
    await ledger.stageApplied(pending, "prior", "result", "accepted");
    await store.setItem(
      `group/ingest/wrapper/v1/${id}`,
      new TextEncoder().encode(
        '{"version":4,"state":"terminal","outcome":"accepted","sourceEpoch":-1}',
      ),
    );
    const neighbors = [
      `group/ingest/wrapper/v1/${id}/application`,
      `group-extra/ingest/wrapper/v1/${id}`,
    ];
    for (const key of neighbors) await store.setItem(key, new Uint8Array([7]));
    await ledger.compactRetained(100, 100);
    expect(await ledger.hasUnfinished()).toBe(true);
    for (const key of neighbors)
      expect(await store.getItem(key)).toEqual(new Uint8Array([7]));
    expect(
      await store.getItem(`group/ingest/wrapper/v1/${pending}`),
    ).not.toBeNull();
    await expect(
      ledger.record(id, "accepted", {
        sourceEpoch: Number.MAX_SAFE_INTEGER + 1,
      }),
    ).rejects.toThrow("coordinate");
  });

  it("migrates legacy terminals once with a local coordinate across two restarts", async () => {
    const store = new InMemoryKeyValueStore<Uint8Array>();
    await new TerminalWrapperLedger(store, "group").record(id, "stale");
    for (let restart = 0; restart < 2; restart++) {
      const ledger = new TerminalWrapperLedger(store, "group");
      await ledger.compactRetained(4, 5 + restart);
      const value = JSON.parse(
        new TextDecoder().decode(
          (await store.getItem(`group/ingest/wrapper/v1/${id}`))!,
        ),
      );
      expect(value.completedAtEpoch).toBe(5);
      expect(value.sourceEpoch).toBeUndefined();
    }
    await new TerminalWrapperLedger(store, "group").compactRetained(6, 7);
    expect(await store.keys()).toEqual([]);
  });

  for (const forwarding of ["before", "after"] as const)
    it(`preserves honest effect acknowledgement after ${forwarding} forwarding`, async () => {
      const store = new InMemoryKeyValueStore<Uint8Array>();
      const ledger = new ConvergenceEffectLedger(store, "group");
      await ledger.compactRetained(new Set());
      await ledger.prepareWithdrawal(digest, 0, [
        { kind: "epochAdvanced", commitDigest: digest, from: 0, to: 1 },
      ]);
      await ledger.compactRetained(new Set());
      expect(await ledger.pending()).toHaveLength(1);
      const set = store.setItem.bind(store);
      store.setItem = async (key, value) => {
        if (forwarding === "after") await set(key, value);
        throw new Error("ack crash");
      };
      await expect(ledger.acknowledge(digest, "withdrawal")).rejects.toThrow(
        "ack crash",
      );
      store.setItem = set;
      for (let restart = 0; restart < 2; restart++) {
        const restored = new ConvergenceEffectLedger(store, "group");
        expect((await restored.pending()).length).toBe(
          forwarding === "before" ? 1 : 0,
        );
        await restored.compactRetained(new Set([bytesToHex(digest)]));
        expect(
          await store.getItem(`group/ingest/effect/v1/${bytesToHex(digest)}`),
        ).not.toBeNull();
      }
      await ledger.acknowledge(digest, "withdrawal");
      await ledger.compactRetained(new Set());
      expect(await store.keys()).toEqual([]);
    });

  it("retires legacy effects by exact digest membership and preserves corrupt rows", async () => {
    const store = new InMemoryKeyValueStore<Uint8Array>();
    const key = `group/ingest/effect/v1/${bytesToHex(digest)}`;
    await store.setItem(
      key,
      new TextEncoder().encode('{"version":1,"state":"active"}'),
    );
    const ledger = new ConvergenceEffectLedger(store, "group");
    await ledger.compactRetained(new Set([bytesToHex(digest.slice())]));
    expect(await store.getItem(key)).not.toBeNull();
    await ledger.compactRetained(new Set());
    expect(await store.getItem(key)).toBeNull();
    await store.setItem(key, new Uint8Array([255]));
    await ledger.compactRetained(new Set());
    expect(await ledger.hasOpaqueDependency()).toBe(true);
    expect(await store.getItem(key)).toEqual(new Uint8Array([255]));
  });
});
