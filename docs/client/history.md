# History

MLS itself does not store messages — once an application message is decrypted, it is gone unless you keep it. Marmot makes message history an **optional, pluggable** concern: provide a `historyFactory` to the client and every group gets a history instance at `group.history` that records both self-sent and ingested rumors and lets you query and subscribe to them.

The library ships `GroupRumorHistory`, which stores decrypted [rumors](/getting-started#key-terms) behind a small backend interface.

## Wiring history into the client

`GroupRumorHistory.makeFactory` turns a per-group backend into the factory the client expects:

```typescript
import { GroupRumorHistory } from "@internet-privacy/marmot-ts";
import { KeyValueRumorHistoryBackend } from "@internet-privacy/marmot-ts/extra";

const historyFactory = GroupRumorHistory.makeFactory(
  (groupId) => new KeyValueRumorHistoryBackend(storeForGroup(groupId)),
);

const client = new MarmotClient({
  signer,
  network,
  groupStateStore,
  keyPackageStore,
  historyFactory,
});
```

`KeyValueRumorHistoryBackend` (from `./extra`) adapts any [`GenericKeyValueStore`](/client/storage) into a history backend, so you can persist messages with the same storage primitives you use for group state.

Once configured, you never call `saveMessage` yourself — the session writes to history automatically whenever a message is sent or ingested.

## Querying messages

`group.history` is a `GroupRumorHistory`. Query stored rumors with Nostr filters:

```typescript
const history = group.history;

// All chat messages (kind 9), newest first
const recent = await history.queryRumors({ kinds: [9], limit: 50 });
```

## Live timeline — `subscribe`

`subscribe(filters?)` is an async generator that yields a fresh filtered timeline, then reloads it whenever a matching rumor is saved, a rumor is removed, or history is cleared. This is the natural source for a chat view:

```typescript
for await (const rumors of history.subscribe({ kinds: [9], limit: 100 })) {
  renderTimeline(rumors); // newest-first NostrEvent-shaped rumors
}
```

Both self-sent messages (via `client.groups.send`) and ingested messages (via `group.ingest`) flow through the same subscription, so the UI stays consistent without a separate "echo" path.

Each snapshot applies the filters and `limit` again. Removing a recent rumor refills a limited page from older surviving records. Changes arriving during loading or while your loop body is running remain pending for the next pull; several changes may coalesce into one fresh snapshot. Your backend must return newest-first results and honor the filters. Already-rendered arrays and pagination pages are application-owned snapshots: replace or retract them when you receive an update.

## Pagination — `createPaginatedLoader`

For infinite scroll, `createPaginatedLoader(filter?)` yields one page per iteration (default 50 per page), walking backwards through history:

```typescript
const loader = history.createPaginatedLoader({ kinds: [9], limit: 30 });

async function loadOlder() {
  const { value: page, done } = await loader.next();
  if (!done && page) prependToTimeline(page);
}
```

## Other methods and events

- `saveRumor(rumor)` — manually persist an unsigned rumor.
- `removeMessage(rumorId)` — durably remove one canonical inner rumor ID; repeated removal succeeds.
- `purgeMessages()` — clear all stored rumors for the group.
- Emits `rumor` (saved), `removed` (targeted removal completed), and `cleared` (history purged), after the backend operation succeeds.

## Fork-invalidated messages

History stores a message as soon as it decrypts. When convergence abandons its branch, the session removes its inner rumor from supported history if no surviving delivery supports that rumor ID. The same rumor can arrive in multiple MLS envelopes: withdrawing a losing transport delivery preserves or restores the row when a canonical delivery remains. The `invalidated` result still identifies the affected transport. This applies to live ingestion, timer settlement, explicit reconvergence, and supported restart recovery. `GroupRumorHistory` and `KeyValueRumorHistoryBackend` provide durable targeted removal; open subscriptions refresh after successful reconciliation.

Both `client.groups.connect()` and `connectAll()` surface results through the manager's `ingestResult` event. Use this to retract application-owned views or record fork evidence; the configured supported history is already reconciled when removal succeeds:

```typescript
client.groups.on("ingestResult", (groupId, result) => {
  if (result.kind === "invalidated" && result.rumorId) {
    refreshHistoryView(groupId); // A canonical delivery may still support this rumor.
  }
});
```

`rumorId` identifies the affected inner message; `transportId` identifies the withdrawn signed kind 445 envelope. Refresh application-owned rumor views from reconciled history rather than deleting a rumor unconditionally. `tag` and `epoch` identify the losing delivery state. Optional `commitDigest` identifies the commit edge that produced that state, never the winning or triggering commit; root deliveries have no producing edge. `payload` retains decrypted application bytes. See [connection result attribution](/client/network#connection-results-and-invalidation) for the complete contract.

Membership and metadata withdrawals arrive as `stateInvalidated` / `stateRevalidated`. After applying those effects to your application, call `group.session.acknowledgeConvergenceEffect(result)`.

### Persistence and restart limits

For restart attribution, persist both `ingestStateStore` (delivered identities and pending removals) and `rewindStore` (the branch nodes used to validate that evidence), alongside `groupStateStore` and the history backend. Supply those stores to `MarmotClient`, or to lower-level sessions when constructing them directly. Hydration and pending-removal retry run before resumed convergence. Evidence follows the convergence horizon; messages delivered before this ledger existed gain no invented provenance.

Every losing delivery in a rewind batch is recorded as pending before the session saves the winning state or begins history removal. Each successful removal is acknowledged durably, so interrupted cleanup retries all remaining obligations after restart.

The ingestion delivery ledger contains decrypted payloads as well as identities. Protect it like plaintext history. Finite settled retention releases obsolete completed ledger entries after their retained authority changes. Pending removals and every surviving delivery supporting the same rumor retain their exact tags, source epochs, producing digests and payload evidence until durable acknowledgement; an error after forwarding acknowledgement is repaired on restart. Awaiting `group.destroy()`, `client.groups.destroy()`, or a successful `client.groups.leave()` purges the group's ingestion namespace, including delivery payloads and pending retractions, after admitted writes settle. Destruction closes that session permanently: stale references, delayed hydration, and saves cannot recreate its stored history or delivery ledger. Other groups' namespaces remain intact.

Omitting ingestion persistence or rewind persistence limits attribution to the current session. Persisted plaintext history alone cannot reconstruct its losing branch after restart. Durable stores must preserve `Uint8Array` values and remain isolated per account; see [Storage](/client/storage).

### Custom history migration and errors

Custom `BaseGroupHistory` and `GroupSessionHistory` implementations must add `removeMessage(rumorId: string): Promise<void>`. Custom `GroupRumorHistoryBackend` implementations must add `removeRumor(rumorId: string): Promise<void>`; `GroupRumorHistory` delegates removal to that method.

1. Remove only the exact canonical inner ID (64 lowercase hex characters), rather than the transport ID or an entire epoch.
2. Make removal idempotent: an already absent record succeeds.
3. Await durable persistence before resolving. Reject on a storage error; do not swallow it or announce a successful refresh.
4. In custom reactive histories, notify subscribers after successful removal and reload filtered snapshots so limited views refill.
5. Persist ingestion and rewind stores to support retry and attribution after restart.

Backend failures surface through `group.on("historyError", handler)` (or `GroupSession`'s `onHistoryError` callback). The invalidation still reaches the caller: the branch is invalid even when storage failed. The session retains pending-removal evidence and retries on activation, including a fresh client restart with both stores persisted. A failed removal can leave stale plaintext visible until retry succeeds; applications should reconcile their displayed views with surviving delivery evidence and report the history error. Successful retry clears pending evidence durably and notifies the history view.

This behavior follows [`protocol-core/convergence.md`](https://github.com/marmot-protocol/marmot/blob/master/protocol-core/convergence.md): losing-branch output must cease to appear as completed application state.

## Retention and backfill

History is independent of MLS epoch secrets. Relay **backfill** (re-ingesting old
kind 445 events) cannot restore plaintext from released receiver secrets.
Authenticated application delivery uses its own inclusive
`appPayloadPastEpochLimit` window (5 epochs by default), independently of the
recovery horizon. Application input one epoch below that floor is stale even
with `maxRewindCommits: Infinity` or a pinned historical resumption receiver.
Input that cannot decrypt retains its existing unreadable/deferred handling.
Full recovery history therefore does not guarantee complete offline message
backfill. Already stored rumors remain available under your application's policy.

At tip epoch 10 with the default five-epoch application window, an authenticated
epoch-5 payload remains in-window and an epoch-4 payload is stale. Retaining its
source state for removal recovery or a resumption PSK does not change that
classification. An unreadable old event has no authenticated source yet and
retains the normal unreadable/deferred handling.

Protocol retention never expires application rumor history or custom media by
epoch. It does not call `removeMessage` or `purgeMessages` just because a recovery
node or completed delivery record became obsolete. Fork retraction and explicit
leave/destruction retain their separate cleanup behavior described above. Choose
your own retention for history rows, rendered timelines, pagination snapshots,
exports and custom decrypted-media caches, including opaque records without epoch
attribution.

This separates recovery-material release from deleting application content.
Continue to handle fork invalidation and durably acknowledge its effects; a
successful history read or completed delivery alone does not acknowledge pending
retractions or state notifications.

The `message-retention` group metadata field (see
[Proposals](/client/proposals#updating-metadata)) is a group request for disappearing
messages: a nonzero value asks members to delete each message's plaintext once its
`created_at` plus the retention seconds pinned at that message's epoch has passed
([`app-components/message-retention-v1.md`](https://github.com/marmot-protocol/marmot/blob/master/app-components/message-retention-v1.md)).
`GroupRumorHistory` does not enforce this general message-expiry policy. If
`group.groupData?.messageRetention` is greater than `0n`, implement expiry in your
backend using the policy attributed to each message, rather than applying only
the latest metadata value to all old rumors.

### Library and caller plaintext ownership

Completed delivery bookkeeping releases references to obsolete plaintext; it
does not overwrite caller-owned outbound payload arrays or previously returned
results. The image service owns independent copied cache arrays. After a
successful facade save, it can detach and zero obsolete private copies while
protecting current images, canonical retained states, actual retained fork/pinned
images and active reads. Failed required persistence performs no retirement;
an incomplete or changing retained-state capture defers optional retirement until
a later successful save. Infinity preserves history-derived image identities
without disabling the image cache's separate capacity limits.

Caller-owned `Uint8Array`s, successfully returned image bytes, application rumor
rows and custom media adapter values retain their references and exact bytes
through protocol pruning. The library neither normalizes those bytes nor assumes
authority to wipe them. Negative controls cover binary/Unicode payloads and
application history/media across epoch advances and restart. Release of private
copies is not a physical overwrite guarantee for garbage-collected memory,
database pages, platform caches or backups. Protect retained secrets and plaintext
at rest according to your platform and application policy.

See [Fork History](/client/fork-history#growth-bounds) for eligible-window bounds
and temporary pending-work growth, and
[Storage](/client/storage#retention-checkpoint-and-restart-repair) for the durable
checkpoint-before-delete order and interrupted-cleanup repair.

## Next steps

- **[Storage](/client/storage)** — the key/value backends history is built on
- **[MarmotGroup](/client/marmot-group)** — sending and ingesting the messages history records
- **[Messages](/core/messages)** — the rumor serialization format
