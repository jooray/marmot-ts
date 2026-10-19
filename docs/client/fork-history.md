# Fork History

Marmot groups can **fork**: because group events arrive over Nostr with no
guaranteed order, two members can commit from the same epoch at the same time,
producing competing branches. The convergence engine deterministically picks one
canonical branch, but the others still happened.

marmot-ts retains the canonical branch and competing branches needed for recovery
within the supported epoch window. Finite retention releases obsolete topology
after convergence settles, while unfinished work keeps its exact dependencies.
Explicit `Infinity` preserves historical recovery material. This page covers
those limits and the customer-facing API for reading the retained tree.

::: warning Forward secrecy
Retaining old group states keeps the MLS secrets for those epochs, so a device
compromise exposes more of the group's history than MLS alone would. Store the
rewind backend encrypted at rest.
:::

## The history tree

Each node in the tree is one MLS group state, identified by the hex of its MLS
**confirmation tag** (unique per state). Edges are commits: a node's parent is
the state its commit was applied to. Every non-root node has exactly one parent,
so the structure is a tree — **more than one child marks a fork**. Initially its
root is the welcome/creation state. Finite retention can advance the logical root
to a retained boundary anchor.

```
        root (epoch 1)
        ├── A (epoch 2)   ← canonical tip (group.state)
        └── B (epoch 2)   ← abandoned fork, still retained
```

Snapshots are stored as serialized bytes, never as live objects, and each node's
state rehydrates independently on demand.

## Retention policy

The rollback horizon is the convergence policy's `maxRewindCommits` (5 in
convergence policy v1). At canonical tip epoch `T`, the nominal oldest supported
epoch is `max(0, T - maxRewindCommits)`. The boundary is **inclusive**: at tip 10
with horizon 5, the epoch-5 anchor remains available. A competing branch remains
eligible when its fork point is within that horizon, including equality.

With the default policy and tip epoch 10, epoch 5 remains the nominal recovery
anchor and the oldest in-window application source; epoch 4 is outside both
nominal windows. An exact unfinished dependency may retain older recovery
material, but does not authorize an otherwise ineligible branch or make an
authenticated expired application payload current. Keep the default policy in
production and treat explicit `Infinity` as a recovery/debug choice.

Retention keeps the anchor, canonical path, and **all eligible branch topology**,
including eligible future descendants. It also preserves canonical source states
required by the independent application window. Keeping only the canonical branch
would lose supported recovery. Exact unfinished dependencies can move the logical
root further back and keep connected paths to pinned states. Traversal stops at
the logical root, but its original producing edge, Commit bytes and confirmation
stamp remain available when present. That provenance does not make its excluded
physical parent selectable again.

`maxRewindCommits` is a **pinned protocol constant**
([`protocol-core/convergence.md`](https://github.com/marmot-protocol/marmot/blob/master/protocol-core/convergence.md)).
Every client must use the same value. A client with a different horizon can select
a different canonical branch than its peers, and the group forks. Production
clients must leave `MarmotClient`'s `convergencePolicy` option at its default,
`DEFAULT_CONVERGENCE_POLICY`.

The option exists only for test harnesses and forensic or debug tools that never
send to a real group:

```ts
import { MarmotClient } from "@internet-privacy/marmot-ts/client";
import { DEFAULT_CONVERGENCE_POLICY } from "@internet-privacy/marmot-ts/core";

// Debug/forensics only. Non-conformant: never use in a client that sends.
const client = new MarmotClient({
  // ...stores, signer, network...
  convergencePolicy: {
    ...DEFAULT_CONVERGENCE_POLICY,
    maxRewindCommits: Infinity,
  },
});
```

With a non-default horizon, this client may adopt a branch its peers consider out
of range (or reject one they adopt), so its view of the group can diverge from
everyone else's.

### Pending work and snapshot secrets

Pending publication, deferred/recovery input, removed-member recovery, pending
message retractions, and unacknowledged state effects protect their required state
tags and producing evidence. Retractions also protect surviving deliveries that
support the same rumor. Historical application or resumption-PSK work can pin an
exact state and former receiver epoch. Actual publication acknowledgement or
conclusive rollback releases publication obligations; recovery and retraction
obligations remain until their durable completion. Unknown retryable input or
unresolved references postpone destructive retention rather than guessing a
dependency. These are internal correctness pins, with no new public tuning knob.

A retained snapshot keeps the MLS membership and private path material needed to
authenticate and advance from its own epoch, together with its own-epoch
application and exporter material. Nested **former-epoch receiver entries** follow
the independent inclusive `appPayloadPastEpochLimit` window (also 5 by default),
plus exact application/resumption dependencies. Projection decodes a copy and
preserves live ratchet progress; it does not mutate a caller's state. Staged
resumption proposals on every selectable source protect their referenced former
receivers, including retained parents after a child becomes canonical. Completing
one child's Commit does not abandon competing work from that parent. Those
receivers can be released when the source leaves the selectable window, or its
proposals are conclusively resolved for all supported work. Completing an explicit
pin permits release at the next settled rewrite when no other dependency remains.

`Infinity` preserves tree nodes, Commit bytes, old recovery snapshots and their
own-epoch material. It **does not widen the application window** or prevent
obsolete nested receivers from being released. Authenticated application input
strictly below the application floor remains stale even if an exact resumption
pin retains its receiver entry. Equality remains in-window.

### Stale input and required history loss

Commit input sourced strictly below the retained anchor receives the existing
stale disposition; it cannot recreate deleted history. A parent not yet received
is deferred under normal convergence rules. Required retained state that is
missing or corrupt is a recovery failure, rather than an excuse to silently drop
in-window work or reset a committed tree to the current tip. During convergence,
required anchor loss reports `missing-retained-anchor` and enters `Unrecoverable`;
below-anchor input reports `beyond-anchor`. Version-2 checkpoint
validation and interrupted-cleanup repair must succeed before registry activation;
failure rejects loading. See [Storage](/client/storage#retention-checkpoint-and-restart-repair)
for adapter errors and the legacy loading exception.

### Growth bounds

Finite retention bounds obsolete state by **eligible epoch-window occupancy plus
unfinished dependency closure**. Finite/Infinity growth controls exercise repeated
real epoch advances, usable retained branches and restart repair: finite completed
work contracts to its supported window, while explicit Infinity preserves old
recovery lookups. This is not a constant item or memory cap. Unbounded same-epoch
traffic, branch fanout, eligible future descendants, unknown retryable input or
missing acknowledgements can grow retained work. Pins, active work and interrupted
cleanup can temporarily exceed the nominal horizon; no eligible work is discarded
to satisfy a count limit.

Inspect the current tree with `group.forkTreeView()` when displaying retained
history. Its nodes are a rendering snapshot; retain your own display state and
refresh it on `historyChanged`. A fixed receiver/cache window does not guarantee
a fixed number of fork nodes or total bytes for every workload.

### Persistence

Pass a `rewindStore` to persist the tree across restarts. It is written
incrementally under exact per-group keys. Settled retention publishes complete
authoritative membership and any copied receiver projections before deleting
excluded edge, snapshot and Commit keys. Checkpointing can rewrite retained
snapshots and metadata; it has no `O(new nodes)` guarantee. On load the light index
is restored eagerly, while heavy snapshots load lazily with a bounded cache. That
cache capacity does not cap topology, pending work or total memory. Without a
`rewindStore`, contraction is process-local and the tree is rebuilt from the
current tip after restart. Persist [ingestion evidence and recovery stores](/client/storage)
together for supported restart attribution.

### Reviewed protocol and MDK differences

The reviewed Marmot `7fabb81` topic contracts are
[`protocol-core/retained-history.md`](https://github.com/marmot-protocol/marmot/blob/7fabb81/protocol-core/retained-history.md),
[`convergence.md`](https://github.com/marmot-protocol/marmot/blob/7fabb81/protocol-core/convergence.md)
and [`durability.md`](https://github.com/marmot-protocol/marmot/blob/7fabb81/protocol-core/durability.md).
The library preserves the pinned finite production policy. Explicit Infinity is a
separate full-history/debug mode, with the interoperability limits above.

Two storage/secret differences are intentional. MDK `4d97b1f0` coordinates its
OpenMLS projection with backend transactions; this library uses complete
single-value checkpoint authority and ordered repeatable generic-store repair
([storage order](/client/storage#retention-checkpoint-and-restart-repair)). An exact
resumption-only dependency temporarily retains the backward-readable nested
receiver entry, including its application fields, rather than a new PSK-only
encoding. Independent stale gating prevents expired application use, and the
entry is released after completion at a settled rewrite. This temporary whole-entry
retention is an implementation deviation from function-specific secret release.

The existing retained-anchor removal recovery is also a normative deviation from
[`protocol-core/member-departure.md`](https://github.com/marmot-protocol/marmot/blob/7fabb81/protocol-core/member-departure.md),
which makes local removal terminal and requires a fresh Welcome. The library can
restore membership only when an authenticated legally replayable winning retained
branch supersedes the exact removal and restores the same local identity and leaf.
MDK's reviewed
[`distributed_convergence.rs`](https://github.com/marmot-protocol/mdk/blob/4d97b1f0/crates/cgka-engine/src/distributed_convergence.rs)
also restores the pre-removal retained anchor on supersession and reconciles its
removed marker against active canonical/MLS membership; it does not oppose this
behavior. Retention preserves that established recovery boundary and the existing
[consumed callback-attempt boundary](/client/storage#callback-delivery-boundary).

## Reading the tree

Every [`MarmotGroup`](./marmot-group) exposes two views.

### `group.forkTree` — live queries

The live [`GroupHistoryTree`](https://github.com/marmot-protocol/marmot-ts/blob/master/src/engine/history-tree.ts) for ad-hoc traversal:

```ts
const tree = group.forkTree;

tree.rootTag; // root node tag, or undefined if empty
tree.tips(); // leaf states — the competing branches
tree.childrenOf(tag); // fork children of a node
tree.path(tag); // root → node tags
tree.lowestCommonAncestor(a, b); // the fork point of two branches

await tree.stateAt(tag); // rehydrate that branch's ClientState
await tree.commitMessageOf(tag); // the commit that produced the node
```

### `group.forkTreeView()` — a rendering snapshot

A plain, serializable snapshot for building UIs. Nodes on the path from the root
to the **canonical (live) tip** — the branch convergence settled on, i.e. the one
matching `group.state` — are flagged `canonical`:

```ts
const view = group.forkTreeView();

view.rootTag; // root tag
view.canonicalTip; // the live tip you send from
view.canonicalPath; // root → canonical tip
view.tips; // all tips (canonical and abandoned)

for (const node of view.nodes) {
  node.tag; // node id
  node.epoch; // MLS epoch
  node.parentTag; // parent, or undefined for the root
  node.childTags; // > 1 ⇒ a fork here
  node.isTip; // leaf state
  node.canonical; // on the canonical path
  node.isCanonicalTip; // the live tip
  node.commit?.digestHex; // original edge identity, including a retained boundary root
  node.commit?.senderLeafIndex; // committer's MLS leaf, when known
}
```

### Reacting to changes

The `historyChanged` event fires whenever ingest grows the tree — a new commit or
a newly observed fork branch. It fires even when the canonical state is unchanged
(a superseded fork still adds a node), so a debugging UI can re-render on it:

```ts
group.on("historyChanged", (g) => render(g.forkTreeView()));
```
