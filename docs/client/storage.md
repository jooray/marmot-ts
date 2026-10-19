# Storage

Marmot persists its data through pluggable key/value stores: serialized MLS **group state**, local **key package** material, received **invites**, and the durable records behind ingest replay protection, fork recovery, removal, and disband. All of them share one interface, so any backend that matches its shape works — in-memory for tests, IndexedDB or LocalForage in the browser, the filesystem or SQLite on the server.

## The `GenericKeyValueStore` interface

```typescript
interface GenericKeyValueStore<T> {
  getItem(key: string): Promise<T | null>;
  setItem(key: string, value: T): Promise<T>;
  removeItem(key: string): Promise<void>;
  clear(): Promise<void>;
  keys(): Promise<string[]>;
}
```

The interface is exported from both the root and the `./utils` subpath:

```typescript
import type { GenericKeyValueStore } from "@internet-privacy/marmot-ts";
```

## All stores

| Constructor option   | Value type                                    | Holds                                                                                                   | If omitted                                                            |
| -------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `groupStateStore`    | `GenericKeyValueStore<SerializedClientState>` | Serialized MLS group state (one entry per group)                                                        | Required                                                              |
| `keyPackageStore`    | `GenericKeyValueStore<StoredKeyPackage>`      | Local key package public + private material and publish tracking                                        | Required                                                              |
| `inviteStore`        | `GenericKeyValueStore<StoredInviteEntry>`     | Received gift wraps and decrypted Welcome rumors                                                        | In-memory                                                             |
| `ingestStateStore`   | `GenericKeyValueStore<Uint8Array>`            | Terminal-wrapper and convergence-effect evidence (replay suppression, acknowledged state invalidations) | In-memory; `client.ingestPersistence` reports `{ kind: "ephemeral" }` |
| `rewindStore`        | `GenericKeyValueStore<Uint8Array>`            | The per-group [fork-history tree](/client/fork-history) used for fork recovery                          | In-memory; rebuilt from the current tip after a restart               |
| `removedMarkerStore` | `GenericKeyValueStore<boolean>`               | Consumed removal-notification attempt and removed-membership fence                                      | Per-instance in-memory realization                                    |
| `lifecycleStore`     | `GenericKeyValueStore<Uint8Array>`            | Disband and lifecycle intent and terminal records                                                       | Stored in `groupStateStore` under scoped keys                         |

The spec requires replay evidence, fork-recovery state, and terminal records to survive a restart ([`protocol-core/durability.md`](https://github.com/marmot-protocol/marmot/blob/master/protocol-core/durability.md)). For production, back `ingestStateStore`, `rewindStore`, and `removedMarkerStore` with the same durable (ideally encrypted) storage as `groupStateStore`, and check `client.ingestPersistence.kind === "durable"` at startup.

`ingestPersistence` reports ingestion evidence configuration; it does not certify the durability of every adapter. The default `lifecycleStore` uses the group-state backend. Direct `MarmotGroup` / `GroupSession` construction can omit lifecycle storage; internal disband selection still fences that instance, but `session.persistSelectedDisband()` requires a lifecycle store and throws without one.

## Durable adapter requirements

For restart guarantees, each successful `setItem` must durably replace the complete value at that key, and each successful `removeItem` must durably remove it. Reads must observe completed writes; `keys()` must expose the stored keys. Preserve `Uint8Array` values exactly. Serialize competing read/modify/write operations in your adapter when they share a backing database or file; the minimal file example below does not provide that coordination or atomic file replacement.

An adapter can throw before writing or after forwarding a successful write. Lifecycle and retention repair tolerate both cases by repeating ordered operations; an error alone does not establish whether the write reached storage. These stores do not provide a cross-store transaction, compare-and-swap, or locking primitive. Configure all lifecycle and recovery stores durably, and retain them together across restarts. The library fences admissions within its owned engine/session during retention; applications must coordinate separate instances, processes or adapters that write the same group. Sharing a database does not supply that coordination automatically.

### Retention checkpoint and restart repair

Finite retention runs only after convergence genuinely settles. An active pass,
undrained `ingest()` generator, staged publication, running callback or unresolved
dependency postpones destructive work. Drain each ingestion batch before starting
another. Ordinary persistence may still complete while work is unsettled; a later
settled save can checkpoint. Scheduled convergence gets one automatic retention
followup after callback admission releases. A storage failure is reported through
the existing history-error path and waits for a later retry, rather than looping.

The session captures exact pending publication, recovery, retraction, same-rumor
support, state-effect and receiver dependencies under an engine admission fence.
The durable order is:

1. Flush required history bytes and wait for admitted history adapter writes.
2. Save the live canonical ratchet projection and complete retained delivery,
   wrapper and effect evidence projections.
3. Publish one complete version-2 tree checkpoint: authoritative node membership,
   logical root, original boundary provenance, receiver allowlists, temporary
   copied snapshot projections and exact garbage-key inventory.
4. Materialize those copied projections, delete only inventoried obsolete edge,
   state and Commit keys, then durably clear the cleanup inventories.

Until step 3 succeeds, the previous tree remains recoverable; earlier canonical
or evidence writes do not authorize deleting its material. After step 3, complete
checkpoint membership is the topology authority. Excluded physical keys cannot
resurrect branches. Copied projections remain in that authority until ordinary
snapshot keys are repaired, so interruption during a later receiver rewrite is
also restartable. A reject-after-forward checkpoint error adopts only the
validated exact authority actually stored and still reports the write failure.

Loading validates membership, connectivity, epochs, snapshot identity, required
Commit bytes/digests, receiver allowlists and boundary provenance. It resumes
materialization, exact-key deletion and acknowledgement before constructing or
activating a group. Failed repair rejects loading; missing/corrupt required
version-2 history or a canonical tip absent from its membership never silently
resets to a tip-only tree. Absent history is optional only when there are no exact
owned history keys. For backward compatibility, a readable **version-1** tree
whose tip no longer matches the saved canonical state retains its legacy
tip-only fallback; this exception does not apply to committed version-2 authority.

Adapters must atomically replace a **single complete value**, preserve bytes, and
settle promises according to actual completion. They need no new transactional
API. Ordered writes and repeated cleanup support failures both before and after
forwarding; they do not make application side effects atomic with storage. See
[Fork History](/client/fork-history) for inclusive windows, exact pins, temporary
growth and the reviewed MDK transaction difference.

### Upgrading existing stores

Use the updated loader for every reader of a group before allowing it to write
new checkpoints. Tree metadata version 1 remains readable; successful retention
checkpointing writes version 2. Once that authority is stored, an older loader
cannot safely resume the group. Keep the saved group state, rewind, ingestion,
lifecycle and removal-marker stores together; no application key rename or
store clearing is required.

Wrapper records now write version 4 and read legacy records; effect records write
version 3 and read version 2. Delivered evidence retains version 1 with stricter
coordinate validation. Legacy terminal wrappers without authenticated source
coordinates get an explicitly local `completedAtEpoch` once, and retire below the
finite floor on a later checkpoint; migration does not invent an old
authenticated epoch.

Let the updated loader finish any checkpoint materialization and exact-key
cleanup before resuming group operations. Preserve failed-repair data for a later
retry and surface the load error; clearing a store or reopening with an older
loader does not repair the committed authority. The adapter still needs complete
single-value atomic writes and application-coordinated writers, as described
above; this upgrade adds no cross-store transaction or cross-process lock.

### Duplicate and completed evidence retention

Sent/seen inner content identities and outer own-echo identities use authenticated
MLS **source epochs**, rather than arrival time. Completed identities strictly
below the finite floor retire after authority publication; equality and exact
pending dependencies remain protected. Consuming an outer echo leaves the inner
identity available to reject a rewrapped echo. Infinity intentionally preserves
historical recovery and age-based duplicate evidence, while application delivery
still obeys its independent window.

Completed delivery/rewind evidence can leave the durable projection when its
producing state is no longer retained. Completed effects retire only when their
producing digest is no longer named by selectable membership. Prepared/applied
wrappers, pending retractions, unacknowledged effects and their required branch
provenance remain unfinished. A pending retraction protects surviving deliveries
of the same inner rumor as well, until durable acknowledgement succeeds. Opaque,
corrupt or unresolved obligations postpone pruning.

Actual outbound publication pins are owned by the current session/runtime and
released by its acknowledgement or conclusive rollback. This retention protocol
does not add a durable outbound publication journal; it does not turn a
process-local pending send into a restart-safe send queue.

### Removal recovery ordering

Recovery requires durable `groupStateStore`, `lifecycleStore`, `rewindStore`, and `removedMarkerStore`. The removal-attribution record identifies the authenticated removal, its exact active parent and the local member. A winning retained branch must replay legally from that parent and restore the same local identity and leaf. A boolean marker alone cannot establish that proof.

The session writes recovery authority first, saves the active snapshot and retained history, reads and validates the saved snapshot, clears the removal marker, then deletes the attribution record last. Until that sequence finishes, public membership remains `removed` and outbound work stays blocked, even if an active snapshot is already saved or the marker was cleared before an adapter threw. Loading and activation revalidate the durable authority and finish interrupted cleanup. Missing, malformed or mismatched evidence leaves the group fenced; it never authorizes clearing a legacy marker.

### Terminal disband ordering

Canonical disband selection fences the running instance before observers or storage calls. Persistence then writes a versioned terminal intent containing authenticated terminal evidence and a scrubbed repair shell, the terminal tombstone, and the registry shell, followed by repeatable cleanup. Intent or tombstone authority takes precedence over a stale live snapshot on restart. Existing terminal tombstones remain readable.

Selection also closes ordinary session history saves. Cleanup waits for already-started history adapter writes to settle before purging plaintext, so an overlapping send cannot recreate history after the purge. Pending retractions still preserve their required history and provenance until acknowledged.

**The restart guarantee begins at the first successful recoverable terminal write.** A crash before that write can reload the previous durable active snapshot. With no lifecycle storage, only the in-process fence is available. Later write or cleanup failures leave terminal work available for retry during activation or ingestion; they cannot reopen the send gate once terminal authority is durable.

### Shared keys and unfinished work

Storage roles may share a physical backend, including different adapter objects over the same database. Keep the library's scoped keys intact: terminal cleanup removes only completed work, and tree purge owns only its metadata, edge, state and commit keys. Do not implement group cleanup as `clear()` or deletion of every group-prefixed key while other roles still own records there.

Prepared wrapper records and unacknowledged convergence effects survive terminal cleanup. Delivered-message evidence, pending history retractions and their branch provenance remain until retraction acknowledgement succeeds. Both durable `ingestStateStore` and `rewindStore` are required to validate and retry those retractions after restart. Custom history adapters must make message removal idempotent and resolve only after persistence succeeds. Applications acknowledge applied state effects with `session.acknowledgeConvergenceEffect(result)`; failed acknowledgement leaves the effect replayable. Finite retention releases obsolete completed protocol evidence, while unfinished work can exceed the nominal horizon. Application rumor history and custom media remain [application-owned](/client/history#retention-and-backfill).

### Callback delivery boundary

Removal markers and a tombstone's `notificationState: "delivered"` record a **consumed callback attempt**, written before external listeners run. Durable records suppress repeated attempts on restart, but a crash or an error after forwarding the consumed record can lose a callback that never ran. This is an at-most-once callback-attempt boundary, not exactly-once callback execution or an atomic transaction with application side effects. Durable membership and terminal authority are independent of callback success. Use [group status](/client/marmot-group#removal-and-terminal-disband) to reconcile application state after loading.

- **`SerializedClientState`** is a `Uint8Array` — the encoded MLS client state.
- **`StoredKeyPackage`** carries a key package's public package plus its private key material and publish tracking. Treat it as **secret**.

::: warning Key package material is sensitive
`keyPackageStore` holds private keys. Use a store with the same protection you would give any signing key, and never share an instance across user accounts.
:::

## In-memory store

For tests and short-lived processes, the `./extra` subpath ships an in-memory implementation:

```typescript
import { InMemoryKeyValueStore } from "@internet-privacy/marmot-ts/extra";

import type { SerializedClientState } from "@internet-privacy/marmot-ts";
import type {
  StoredInviteEntry,
  StoredKeyPackage,
} from "@internet-privacy/marmot-ts/client";

const groupStateStore = new InMemoryKeyValueStore<SerializedClientState>();
const keyPackageStore = new InMemoryKeyValueStore<StoredKeyPackage>();
const inviteStore = new InMemoryKeyValueStore<StoredInviteEntry>();
```

## LocalForage (browser)

[LocalForage](https://github.com/localForage/localForage) instances satisfy `GenericKeyValueStore` directly (IndexedDB/WebSQL/localStorage under the hood):

```typescript
import localforage from "localforage";

const groupStateStore = localforage.createInstance({ name: "marmot-groups" });
const keyPackageStore = localforage.createInstance({ name: "marmot-keys" });
```

## Custom backend

Any object with the five methods works. A minimal adapter over a load/persist pair (for example a file):

```typescript
import type { GenericKeyValueStore } from "@internet-privacy/marmot-ts";

function fileStore<T>(
  load: () => Promise<Record<string, T>>,
  persist: (all: Record<string, T>) => Promise<void>,
): GenericKeyValueStore<T> {
  return {
    async getItem(key) {
      return (await load())[key] ?? null;
    },
    async setItem(key, value) {
      const all = await load();
      all[key] = value;
      await persist(all);
      return value;
    },
    async removeItem(key) {
      const all = await load();
      delete all[key];
      await persist(all);
    },
    async clear() {
      await persist({});
    },
    async keys() {
      return Object.keys(await load());
    },
  };
}
```

Stored values include `Uint8Array`s (`SerializedClientState`, `StoredKeyPackage`, and the `Uint8Array` stores above). Use a binary-safe encoding such as structured clone, CBOR, or base64 per field. Plain `JSON.stringify` silently corrupts them.

## Per-account isolation

Each user account **must** use completely isolated stores (all of the stores above) — mixing key package material between accounts would leak private keys. Namespace your stores by the account's public key:

```typescript
const store = localforage.createInstance({ name: `marmot-${pubkey}` });
```

See [Multi-Account Support](/client/marmot-client#multi-account-support) for the full pattern.

## Encrypted store (demo only)

The `./extra` subpath also exports `EncryptedKeyValueStore`, a password-encrypting wrapper.

::: danger Not for production
`EncryptedKeyValueStore` is a demonstration of the wrapping pattern only. It is **not** a secure at-rest encryption scheme — use platform key storage (Keychain, DPAPI, libsecret, WebCrypto + a hardware-backed key) for real deployments.
:::

## Next steps

- **[MarmotClient](/client/marmot-client)** — wiring stores into the client
- **[History](/client/history)** — message history is a separate, optional backend
- **[Client State](/core/state)** — what gets serialized into `groupStateStore`
