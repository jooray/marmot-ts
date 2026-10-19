# Messages

Marmot uses MLS for end-to-end encryption and an epoch-scoped group event envelope for Nostr relay distribution.

## Encryption Strategy

### Two-Layer Encryption

1. **MLS Layer:** Encrypts application data with forward secrecy and post-compromise security
2. **Group Event Envelope:** Encrypts the serialized MLS message with a ChaCha20-Poly1305 key derived from the MLS exporter secret

```
Application Data (rumor)
  ↓ MLS Encrypt
MLSMessage
  ↓ group-event encryption (with exporter_secret)
Nostr Event (kind 445)
```

### Key Derivation

```text
group_event_key = MLS-Exporter("marmot", "group-event", 32)   // per epoch
nonce           = random(12)                                  // CSPRNG, fresh per event
aad             = ""                                          // empty
ciphertext      = ChaCha20-Poly1305.encrypt(group_event_key, nonce, mls_message_bytes, aad)
event.content   = base64(nonce || ciphertext)                 // standard base64, padded
```

A kind 445 event carries exactly one `h` tag (the lowercase-hex `nostr_group_id`). Receivers reject content that is not valid base64 or decodes to fewer than 28 bytes (12-byte nonce plus 16-byte tag). See [`transports/nostr.md`](https://github.com/marmot-protocol/marmot/blob/master/transports/nostr.md).

This approach:

- Prevents key reuse across epochs
- Provides epoch-based key rotation
- Maintains forward secrecy
- Compatible with Nostr event model

### Privacy Features

- **Ephemeral Signing:** Group events signed with ephemeral keys (not user's identity key)
- **Unlinkability:** Events cannot be tied to specific users by observers
- **Rumor-Based:** Application messages are unsigned inner events; MLS authenticates the sender

## Creating Group Events

### Encrypt and Create Event

```typescript
import { createGroupEvent } from "@internet-privacy/marmot-ts";

const event = await createGroupEvent({
  message: mlsMessage, // MLSMessage from MLS operations
  state: clientState, // Current MLS ClientState
  ciphersuite: ciphersuiteImpl, // Cryptographic implementation
});

// event is a fully formed Nostr event (including signature)
```

### Exact application expiration

The client/engine application-send path computes `expiration = innerRumor.created_at + disappearing_message_secs` from the **source epoch's** `message-retention.v1` component, before signing the kind 445 event. It carries this checked value as `bigint` transport metadata and writes the exact decimal NIP-40 `expiration` tag; even values above `Number.MAX_SAFE_INTEGER` remain exact.

The inner timestamp must be a safe, nonnegative integer, and addition must fit unsigned 64-bit seconds. Missing, removed or zero retention, invalid/noncanonical application payloads or timestamps, malformed retention, and overflowing sums omit the hint without failing the MLS send. Commits, proposals and self-updates omit expiration metadata. This tag is an application retention hint, not a reason to discard required MLS state, retained epochs or pending publish obligations. See [`app-components/message-retention-v1.md`](https://github.com/marmot-protocol/marmot/blob/master/app-components/message-retention-v1.md) and [`transports/nostr.md`](https://github.com/marmot-protocol/marmot/blob/master/transports/nostr.md), "Message expiration".

`createGroupEvent` and custom peelers cannot infer plaintext expiry from encrypted MLS bytes. Lower-level callers may pass `metadata: { expiration: checkedExpiry }` only for an application message; `checkedExpiry` must be a checked `bigint` in the uint64 range. Without metadata the event has no expiry hint. Custom transport implementations can accept the optional third `wrapGroupMessage(message, state, metadata)` argument; existing two-argument adapters continue to work.

Publication retries reuse the original signed event, including its ID, content, tags and outer `created_at`. A later retention-policy update does not recompute expiry or create another envelope. The outer timestamp remains the original wrap-time timestamp; expiry is derived from the inner rumor timestamp.

### Ephemeral Signer

`createGroupEvent` signs each kind 445 event with a fresh random key generated for that event. The key is never reused and is never the sender's account key ([`transports/nostr.md`](https://github.com/marmot-protocol/marmot/blob/master/transports/nostr.md), "Group message delivery").

## Decrypting Group Events

### Single Event Decryption

```typescript
import { decryptGroupMessageEvent } from "@internet-privacy/marmot-ts";

try {
  const mlsMessage = await decryptGroupMessageEvent(
    event, // Nostr event (kind 445)
    clientState, // Current MLS group state
    ciphersuiteImpl, // Cryptographic implementation
  );
  // mlsMessage ready for MLS processing
} catch (error) {
  // Decryption failed (wrong epoch, corrupted data, etc.)
}
```

### Batch Decryption

For multiple events with error handling:

```typescript
import { decryptGroupMessages } from "@internet-privacy/marmot-ts";

const { read, unreadable } = await decryptGroupMessages(
  events, // Array of kind 445 events
  clientState,
  ciphersuiteImpl,
);

// `read` contains successfully decrypted `{ event, message }` pairs.
// `unreadable` contains events that could not be decrypted in the current epoch.
```

::: warning
These helpers only decrypt. They do not verify the outer event. Before decrypting, verify the NIP-01 id and signature and check that the event has exactly one `h` tag matching the group. Events in `unreadable` are not terminal: retry them after the epoch (or the set of retained candidate epochs) changes instead of discarding them. `MarmotGroup.ingest()` and `client.groups.connect()` handle all of this for you.
:::

## Commit Ordering

When members race commits for the same epoch, Marmot deterministically selects one canonical branch (spec: [`protocol-core/convergence.md`](https://github.com/marmot-protocol/marmot/blob/master/protocol-core/convergence.md)). Any member can race this way, for example with a self-update or self-remove commit; it is not limited to admins.

### Ordering Rules

Convergence is decided from authenticated MLS bytes only. Relay `created_at`, Nostr event ids and arrival order MUST NOT choose group state. When two commits race for the same epoch, the canonical branch is the one with:

1. Higher effective commit depth
2. Witness quorum (beats no quorum)
3. Higher app-witness score
4. A privileged tip (beats an ordinary one)
5. Lower committer account pubkey
6. Lower `commit_digest` (SHA-256 of the commit's MLSMessage bytes)

`MarmotGroup.ingest()` / `MarmotGroupEngine` implement convergence, rollback and retained-history handling. Use them rather than ordering commits yourself.

### `sortGroupCommits`

```typescript
import { sortGroupCommits } from "@internet-privacy/marmot-ts/core";

// Deterministic pre-order: MLS source epoch, then commit_digest
const sortedPairs = sortGroupCommits(messagePairs);
```

::: warning
`sortGroupCommits` is an epoch/digest pre-order. Full Marmot branch convergence additionally evaluates depth, witnesses, priority and authenticated committer criteria. Use `MarmotGroup.ingest()` / `MarmotGroupEngine` to select and apply branches.
:::

The helper reads the actual source epoch from either `PublicMessage.content` or `PrivateMessage`, then breaks equal-epoch ties with SHA-256 of the canonical encoded MLSMessage bytes. Outer event ids, `created_at`, arrival order and carriage preference do not influence that comparison. It returns a new array, preserves the supplied array's order and keeps the original message pairs.

Ordering throws an explicit error for unsupported wire formats (`Welcome`, `GroupInfo` or `KeyPackage`) and a `RangeError` for negative epochs or epochs above `Number.MAX_SAFE_INTEGER`. Epoch zero and the maximum safe epoch are accepted; invalid input never produces a partial result or an invented epoch-zero order.

### Message classification

`isCommitMessage` and `isProposalMessage` recognize both public and private framed messages and narrow to that carriage union. `isApplicationMessage` remains private-only: public application-shaped content is not classified as an application message. All three guards return `false` for nonframed messages. These guards classify carriage/content type; they do not authenticate MLS content.

After a successful commit or proposal guard, branch on `wireformat` before accessing carriage-specific fields:

```typescript
import {
  isCommitMessage,
  type GroupMessagePair,
} from "@internet-privacy/marmot-ts/core";
import { wireformats } from "@internet-privacy/marmot-ts/mls";

function commitSourceEpoch(pair: GroupMessagePair): bigint | undefined {
  if (!isCommitMessage(pair)) return undefined;
  return pair.message.wireformat === wireformats.mls_public_message
    ? pair.message.publicMessage.content.epoch
    : pair.message.privateMessage.epoch;
}
```

`GroupMessagePair` preserves the original Nostr event and MLS message. The guard
narrows the message to the public/private carriage union; it does not prove a
commit's authorization or choose its branch. Open **Reference** in the navigation
for the exported helper signatures and [fork history](/client/fork-history) for
the engine's authenticated branch selection.

## Application Messages

Application messages are the actual content users send (chat messages, files, etc.). They're wrapped as "rumors" (unsigned Nostr events) and encrypted within MLS messages.

### What are Rumors?

A rumor is an unsigned Nostr event:

```typescript
interface Rumor {
  kind: number;
  content: string;
  tags: string[][];
  created_at: number;
  pubkey: string; // Sender's real pubkey
  id: string; // Required (Nostr event id), even though the rumor is unsigned
  // No 'sig' - unsigned!
}
```

**Why unsigned?**

- MLS already authenticates the sender as a group member
- The payload is not a valid standalone Nostr event, so it can't be published to relays
- Clients MUST NOT add a Nostr signature ([`foundation/application-messages.md`](https://github.com/marmot-protocol/marmot/blob/master/foundation/application-messages.md))

### Serializing Rumors

```typescript
import {
  createChatRumor,
  serializeApplicationRumor,
} from "@internet-privacy/marmot-ts";

// kind 9 chat rumor, id = canonical NIP-01 hash
const rumor = createChatRumor({
  pubkey: senderPubkey,
  content: "Hello, group!",
});

const serialized = serializeApplicationRumor(rumor);
// Use this as MLS application data
```

For custom kinds, build the rumor yourself and set `id: getEventHash(rumor)` (from `applesauce-core/helpers/event`). Decoders reject a rumor whose `id` is not the canonical NIP-01 hash.

### Deserializing Rumors

```typescript
import { deserializeApplicationData } from "@internet-privacy/marmot-ts";

// After processing MLS message, extract application data
const rumor = deserializeApplicationData(applicationData);

console.log(rumor.content); // "Hello, group!"
console.log(rumor.pubkey); // Sender's pubkey
```

`deserializeApplicationData` checks the structure (the exact six members, no `sig`) and the `id`. It does **not** check who sent the message. If you process MLS messages yourself, use `verifyApplicationRumorAuthorship(applicationData, senderAccountPubkeyHex)` instead. It also checks that the inner `pubkey` equals the MLS-authenticated sender's account identity, so a member can't impersonate another member. `MarmotGroup` runs this check before emitting `applicationMessage`.

## Complete Message Flow

The recommended path is the client: [`MarmotGroup`](/client/marmot-group) handles MLS encryption, the group event envelope, convergence-gated sending, and inbound validation (admin policy, identity proofs, commit legality, convergence).

::: tip Why not raw `processMessage`?
`createApplicationMessage` / `processMessage` from `@internet-privacy/marmot-ts/mls` apply MLS rules only. They skip Marmot's admin-policy, identity-proof, commit-legality, authorship and convergence checks. The public [`marmotAuthService`](./credentials#authentication) provides basic-credential identity and curve validation; it does not supply those additional checks. Use the client or engine path below.
:::

### Sending a Message

```typescript
import {
  createApplicationMessageIntent,
  createChatRumor,
} from "@internet-privacy/marmot-ts";

const rumor = createChatRumor({ pubkey: myPubkey, content: "Hello!" });
await client.groups.send(group.id, createApplicationMessageIntent(rumor));
// or: await group.submitIntent(createApplicationMessageIntent(rumor));
```

### Receiving Messages

```typescript
import { deserializeApplicationData } from "@internet-privacy/marmot-ts";

// Subscribes to the group's relays, verifies each kind 445 event
// (signature + `h` tag), and drains it through group.ingest()
const sub = await client.groups.connect(group.id);

group.on("applicationMessage", (data) => {
  const rumor = deserializeApplicationData(data);
  console.log(`${rumor.pubkey}: ${rumor.content}`);
});

// later: sub.unsubscribe();
```

To feed events manually, verify each event first, then pass a batch to `group.ingest(events)` and fully drain that generator before starting another one. See [MarmotGroup](/client/marmot-group#receiving-messages).

## Privacy Properties

### Ephemeral Signing

Group events are signed with ephemeral keys:

- Each event uses a different keypair
- Events cannot be linked to sender's identity
- Observers see random pubkeys, not real identities

### Encrypted Sender Identity

- Sender's real pubkey is in the rumor (inner event)
- Rumor is encrypted with MLS
- Only group members can see who sent what
- Relays and observers see only encrypted data

### Unlinkability

- Events cannot be tied to specific users
- Content completely opaque to non-members

## Related

- [Groups](./groups) - Creating groups to send messages in
- [Client State](./state) - Managing group state for encryption
- [Protocol](./protocol) - app components and event kinds
