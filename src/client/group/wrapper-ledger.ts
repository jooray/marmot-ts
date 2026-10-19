import type { GenericKeyValueStore } from "../../utils/key-value.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { StateNotification } from "../../engine/state-notifications.js";

export type TerminalWrapperOutcome = "accepted" | "stale" | "invalidated";

type StoredTerminalWrapperV1 = {
  version: 1;
  outcome: TerminalWrapperOutcome;
};

type StoredWrapperV2 =
  | { version: 2; state: "prepared"; priorStateHash: string }
  | { version: 2; state: "terminal"; outcome: TerminalWrapperOutcome };

type StoredWrapperV3 =
  | { version: 3; state: "prepared"; priorStateHash: string }
  | {
      version: 3;
      state: "applied";
      priorStateHash: string;
      resultingStateHash: string;
      outcome: TerminalWrapperOutcome;
    }
  | { version: 3; state: "terminal"; outcome: TerminalWrapperOutcome };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export type WrapperRetentionCoordinate =
  | { sourceEpoch: number; completedAtEpoch?: never }
  | { completedAtEpoch: number; sourceEpoch?: never };

type StoredTerminalWrapperV4 = {
  version: 4;
  state: "terminal";
  outcome: TerminalWrapperOutcome;
} & WrapperRetentionCoordinate;
const safeEpoch = (epoch: unknown): epoch is number =>
  Number.isSafeInteger(epoch) && (epoch as number) >= 0;
const outcomeValid = (outcome: unknown): outcome is TerminalWrapperOutcome =>
  outcome === "accepted" || outcome === "stale" || outcome === "invalidated";
const exactOwnedKey = (key: string, prefix: string) =>
  key.startsWith(prefix) && /^[a-f0-9]{64}$/.test(key.slice(prefix.length));

/** Durable, group-scoped record of verified transport wrappers handled terminally. */
export class TerminalWrapperLedger {
  constructor(
    readonly store: GenericKeyValueStore<Uint8Array>,
    readonly groupId: string,
  ) {}

  #key(eventId: string): string {
    return `${this.groupId}/ingest/wrapper/v1/${eventId}`;
  }

  async get(
    eventId: string,
    currentStateHash?: string,
  ): Promise<TerminalWrapperOutcome | undefined> {
    const bytes = await this.store.getItem(this.#key(eventId));
    if (!bytes) return undefined;
    try {
      const value = JSON.parse(
        decoder.decode(bytes),
      ) as StoredTerminalWrapperV1;
      if (
        value.version === 1 &&
        (value.outcome === "accepted" ||
          value.outcome === "stale" ||
          value.outcome === "invalidated")
      )
        return value.outcome;
      const current = value as unknown as StoredWrapperV2 | StoredWrapperV3;
      if (
        current.version === 2 &&
        current.state === "terminal" &&
        outcomeValid(current.outcome)
      )
        return current.outcome;
      if (
        current.version === 3 &&
        current.state === "terminal" &&
        outcomeValid(current.outcome)
      )
        return current.outcome;
      const attributed = value as unknown as StoredTerminalWrapperV4;
      if (
        attributed.version === 4 &&
        attributed.state === "terminal" &&
        outcomeValid(attributed.outcome) &&
        ((safeEpoch(attributed.sourceEpoch) &&
          attributed.completedAtEpoch === undefined) ||
          (safeEpoch(attributed.completedAtEpoch) &&
            attributed.sourceEpoch === undefined))
      )
        return attributed.outcome;
      if (
        current.version === 3 &&
        current.state === "applied" &&
        currentStateHash === current.resultingStateHash &&
        current.resultingStateHash !== current.priorStateHash
      )
        return current.outcome;
    } catch {
      // Corrupt evidence is ignored; the verified wrapper remains processable.
    }
    return undefined;
  }

  /** Records the durable pre-apply side of the ingest transaction. */
  async begin(eventId: string, priorStateHash: string): Promise<void> {
    if (await this.get(eventId, priorStateHash)) return;
    const existing = await this.store.getItem(this.#key(eventId));
    if (existing) return;
    const value: StoredWrapperV3 = {
      version: 3,
      state: "prepared",
      priorStateHash,
    };
    await this.store.setItem(
      this.#key(eventId),
      encoder.encode(JSON.stringify(value)),
    );
  }

  /** Binds recoverable application evidence to this wrapper's exact result. */
  async stageApplied(
    eventId: string,
    priorStateHash: string,
    resultingStateHash: string,
    outcome: TerminalWrapperOutcome,
  ): Promise<void> {
    const value: StoredWrapperV3 = {
      version: 3,
      state: "applied",
      priorStateHash,
      resultingStateHash,
      outcome,
    };
    await this.store.setItem(
      this.#key(eventId),
      encoder.encode(JSON.stringify(value)),
    );
  }

  async record(
    eventId: string,
    outcome: TerminalWrapperOutcome,
    coordinate?: WrapperRetentionCoordinate,
  ): Promise<void> {
    if (
      !outcomeValid(outcome) ||
      (coordinate &&
        !(
          (safeEpoch(coordinate.sourceEpoch) &&
            coordinate.completedAtEpoch === undefined) ||
          (safeEpoch(coordinate.completedAtEpoch) &&
            coordinate.sourceEpoch === undefined)
        ))
    )
      throw new Error("Invalid wrapper retention coordinate");
    const value: StoredWrapperV3 | StoredTerminalWrapperV4 = coordinate
      ? { version: 4, state: "terminal", outcome, ...coordinate }
      : { version: 3, state: "terminal", outcome };
    await this.store.setItem(
      this.#key(eventId),
      encoder.encode(JSON.stringify(value)),
    );
  }
  /** Unknown/prepared/applied evidence cannot authorize provenance release. */
  async hasUnfinished(): Promise<boolean> {
    const prefix = `${this.groupId}/ingest/wrapper/v1/`;
    for (const key of await this.store.keys()) {
      if (!exactOwnedKey(key, prefix)) continue;
      if (!(await this.get(key.slice(prefix.length)))) return true;
    }
    return false;
  }

  /** Migrate legacy terminal rows locally, then retire strictly below the floor. */
  async compactRetained(
    floorEpoch: number,
    completedAtEpoch: number,
    pinnedIds: ReadonlySet<string> = new Set(),
  ): Promise<void> {
    if (!safeEpoch(floorEpoch) || !safeEpoch(completedAtEpoch))
      throw new Error("Invalid wrapper retention epoch");
    const prefix = `${this.groupId}/ingest/wrapper/v1/`;
    for (const key of await this.store.keys()) {
      if (!exactOwnedKey(key, prefix)) continue;
      const id = key.slice(prefix.length);
      const outcome = await this.get(id);
      if (!outcome) continue;
      const bytes = await this.store.getItem(key);
      if (!bytes) continue;
      const value = JSON.parse(
        decoder.decode(bytes),
      ) as StoredTerminalWrapperV4;
      if (value.version !== 4) {
        await this.record(id, outcome, { completedAtEpoch });
        continue;
      }
      const epoch = value.sourceEpoch ?? value.completedAtEpoch;
      if (epoch < floorEpoch && !pinnedIds.has(id))
        await this.store.removeItem(key);
    }
  }
  /** Only completed wrapper evidence belongs to terminal cleanup. */
  async cleanupCompleted(): Promise<void> {
    const prefix = `${this.groupId}/ingest/wrapper/v1/`;
    for (const key of await this.store.keys())
      if (key.startsWith(prefix) && (await this.get(key.slice(prefix.length))))
        await this.store.removeItem(key);
  }
}

type StoredEffectVerdictV1 = { version: 1; state: "withdrawn" | "active" };
type StoredEffectV2 = {
  version: 2 | 3;
  state: "pending" | "observed";
  direction: "withdrawal" | "adoption";
  forkEpoch?: number;
  producingDigest?: string;
  producingEpoch?: number;
  notifications: Array<
    Omit<StateNotification, "commitDigest"> & { commitDigest: string }
  >;
};

export type PendingConvergenceEffect =
  | {
      kind: "stateInvalidated";
      commitDigest: Uint8Array;
      forkEpoch: number;
      withdrawn: StateNotification[];
    }
  | {
      kind: "stateRevalidated";
      commitDigest: Uint8Array;
      effectId: Uint8Array;
      notifications: StateNotification[];
    };

/** Durable observation verdicts for branch-selection withdrawal/re-adoption. */
export class ConvergenceEffectLedger {
  constructor(
    readonly store: GenericKeyValueStore<Uint8Array>,
    readonly groupId: string,
  ) {}

  #key(digest: Uint8Array): string {
    return `${this.groupId}/ingest/effect/v1/${bytesToHex(digest)}`;
  }

  async #readKey(
    key: string,
  ): Promise<StoredEffectVerdictV1 | StoredEffectV2 | undefined> {
    const bytes = await this.store.getItem(key);
    if (!bytes) return undefined;
    try {
      const value = JSON.parse(decoder.decode(bytes)) as
        StoredEffectVerdictV1 | StoredEffectV2;
      if (
        value.version === 1 &&
        (value.state === "withdrawn" || value.state === "active")
      )
        return value;
      if (
        (value.version === 2 || value.version === 3) &&
        (value.state === "pending" || value.state === "observed") &&
        (value.direction === "withdrawal" || value.direction === "adoption") &&
        Array.isArray(value.notifications) &&
        (value.forkEpoch === undefined || safeEpoch(value.forkEpoch)) &&
        (value.direction !== "withdrawal" || safeEpoch(value.forkEpoch)) &&
        (value.version !== 3 ||
          (value.producingDigest === key.slice(key.lastIndexOf("/") + 1) &&
            /^[a-f0-9]{64}$/.test(value.producingDigest))) &&
        (value.producingEpoch === undefined ||
          safeEpoch(value.producingEpoch)) &&
        value.notifications.every((notification) =>
          /^[a-f0-9]{64}$/.test(notification.commitDigest),
        )
      )
        return value;
    } catch {
      // Corrupt local evidence cannot establish an observation boundary.
    }
    return undefined;
  }

  async #read(digest: Uint8Array) {
    return this.#readKey(this.#key(digest));
  }

  async #write(digest: Uint8Array, value: StoredEffectV2) {
    await this.store.setItem(
      this.#key(digest),
      encoder.encode(JSON.stringify(value)),
    );
  }

  async prepareWithdrawal(
    digest: Uint8Array,
    forkEpoch: number,
    notifications: readonly StateNotification[],
  ): Promise<boolean> {
    const existing = await this.#read(digest);
    if (existing?.version === 1 && existing.state === "withdrawn") return false;
    if (
      existing &&
      existing.version !== 1 &&
      existing.direction === "withdrawal"
    )
      return existing.state === "pending";
    await this.#write(digest, {
      version: 3,
      producingDigest: bytesToHex(digest),
      producingEpoch:
        notifications.find(
          (notification) =>
            notification.kind === "epochAdvanced" &&
            bytesToHex(notification.commitDigest) === bytesToHex(digest),
        )?.kind === "epochAdvanced"
          ? (
              notifications.find(
                (notification) =>
                  notification.kind === "epochAdvanced" &&
                  bytesToHex(notification.commitDigest) === bytesToHex(digest),
              ) as Extract<StateNotification, { kind: "epochAdvanced" }>
            ).to
          : undefined,
      state: "pending",
      direction: "withdrawal",
      forkEpoch,
      notifications: notifications.map((notification) => ({
        ...notification,
        commitDigest: bytesToHex(notification.commitDigest),
      })),
    });
    return true;
  }

  async prepareAdoption(
    digest: Uint8Array,
    notifications: readonly StateNotification[],
  ): Promise<boolean> {
    const existing = await this.#read(digest);
    const withdrawn =
      (existing?.version === 1 && existing.state === "withdrawn") ||
      (existing &&
        existing.version !== 1 &&
        existing.direction === "withdrawal" &&
        existing.state === "observed");
    if (!withdrawn) {
      if (
        existing &&
        existing.version !== 1 &&
        existing.direction === "adoption"
      )
        return existing.state === "pending";
      return false;
    }
    await this.#write(digest, {
      version: 3,
      producingDigest: bytesToHex(digest),
      producingEpoch:
        existing && existing.version !== 1
          ? existing.producingEpoch
          : undefined,
      state: "pending",
      direction: "adoption",
      notifications: notifications.map((notification) => ({
        ...notification,
        commitDigest: bytesToHex(notification.commitDigest),
      })),
    });
    return true;
  }

  async acknowledge(
    digest: Uint8Array,
    direction: StoredEffectV2["direction"],
  ): Promise<void> {
    const existing = await this.#read(digest);
    if (
      !existing ||
      existing.version === 1 ||
      existing.direction !== direction ||
      existing.state !== "pending"
    )
      return;
    await this.#write(digest, { ...existing, state: "observed" });
  }

  async pending(): Promise<PendingConvergenceEffect[]> {
    const prefix = `${this.groupId}/ingest/effect/v1/`;
    const pending: PendingConvergenceEffect[] = [];
    for (const key of await this.store.keys()) {
      if (!exactOwnedKey(key, prefix)) continue;
      const value = await this.#readKey(key);
      if (!value || value.version === 1 || value.state !== "pending") continue;
      const digest = Uint8Array.from(
        key
          .slice(prefix.length)
          .match(/.{2}/g)
          ?.map((byte) => Number.parseInt(byte, 16)) ?? [],
      );
      const notifications = value.notifications.map((notification) => ({
        ...notification,
        commitDigest: Uint8Array.from(
          notification.commitDigest
            .match(/.{2}/g)
            ?.map((byte) => Number.parseInt(byte, 16)) ?? [],
        ),
      })) as StateNotification[];
      pending.push(
        value.direction === "withdrawal"
          ? {
              kind: "stateInvalidated",
              commitDigest: digest,
              forkEpoch: value.forkEpoch!,
              withdrawn: notifications,
            }
          : {
              kind: "stateRevalidated",
              commitDigest: digest,
              effectId: digest,
              notifications,
            },
      );
    }
    return pending;
  }

  /** Completed effects retire only when no proposed selectable member names them. */
  async compactRetained(digests: ReadonlySet<string>): Promise<void> {
    const prefix = `${this.groupId}/ingest/effect/v1/`;
    for (const key of await this.store.keys()) {
      if (!exactOwnedKey(key, prefix)) continue;
      const value = await this.#readKey(key);
      if (!value || (value.version !== 1 && value.state === "pending"))
        continue;
      if (!digests.has(key.slice(prefix.length)))
        await this.store.removeItem(key);
    }
  }

  async hasOpaqueDependency(): Promise<boolean> {
    const prefix = `${this.groupId}/ingest/effect/v1/`;
    for (const key of await this.store.keys())
      if (exactOwnedKey(key, prefix) && !(await this.#readKey(key)))
        return true;
    return false;
  }
}
