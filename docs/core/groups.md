# Groups

Groups are the foundation of Marmot messaging. A group contains members who can exchange encrypted messages.

## What is a Group?

An MLS group is a cryptographic context where:

- Members share encryption keys
- Messages are end-to-end encrypted
- Members can be added or removed
- Keys rotate with each state change (epoch)

Marmot extends MLS groups with Nostr-specific metadata via versioned app components in the `app_data_dictionary` extension.

## Creating a Group

```typescript
import {
  createGroup,
  groupProfileEntry,
  adminPolicyEntry,
  nostrRoutingEntry,
} from "@internet-privacy/marmot-ts";
import {
  ciphersuites,
  defaultCryptoProvider,
} from "@internet-privacy/marmot-ts/mls";

const ciphersuiteImpl = await defaultCryptoProvider.getCiphersuiteImpl(
  ciphersuites.MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519,
);

const result = await createGroup({
  creatorKeyPackage: myKeyPackage,
  components: [
    groupProfileEntry({ name: "Developer Chat", description: "" }),
    adminPolicyEntry([myPubkey]),
    nostrRoutingEntry({
      nostrGroupId: crypto.getRandomValues(new Uint8Array(32)),
      relays: ["wss://relay.example.com"],
    }),
  ],
  ciphersuiteImpl,
  extensions: [], // Optional additional group context extensions
});

// result.clientState contains the MLS group state
```

### Parameters

- **creatorKeyPackage:** Your complete key package (public + private)
- **components:** Initial app components seeded into the `app_data_dictionary`
- **requiredComponentIds:** (Optional) Component ids advertised in the `app_components` entry. Defaults to the ids of `components`. The default group component ids (group-profile `0x8001`, admin-policy `0x8003`, account-identity-proof `0x8009`, group-lifecycle `0x800c`) are always included.
- **ciphersuiteImpl:** Cryptographic implementation
- **extensions:** (Optional) Additional MLS group context extensions

::: warning
`createGroup` does not validate your components. The spec requires the initial admin policy to contain the creator's account identity, and a Nostr-routed group to include `transport.nostr.routing.v1` ([`protocol-core/group-setup.md`](https://github.com/marmot-protocol/marmot/blob/master/protocol-core/group-setup.md)). Include an `adminPolicyEntry` with your pubkey and a `nostrRoutingEntry`. Without routing, `getNostrGroupIdHex` and `createGroupEvent` throw.
:::

### Returns

```typescript
interface CreateGroupResult {
  clientState: ClientState; // The MLS group state
}
```

## Simplified Creation

For testing or simple use cases:

```typescript
import { createSimpleGroup } from "@internet-privacy/marmot-ts";

const { clientState } = await createSimpleGroup(
  myKeyPackage,
  ciphersuiteImpl,
  "Group Name",
  {
    relays,
    adminPubkeys,
  },
);
```

`createSimpleGroup` always makes the creator an admin, but it only adds the `transport.nostr.routing.v1` component (with a fresh random `nostrGroupId`) when `relays` is non-empty.

## Group Initialization Process

When you create a group:

1. **Creates MLS Group:** Initializes MLS group with creator as sole member, using a private random 32-byte MLS group id (distinct from the public `nostrGroupId`)
2. **Seeds Components:** Writes the `app_components` entry, your components, and `group.lifecycle.v1` (`active`, unless you supplied one) into the `app_data_dictionary`, and declares the Marmot `required_capabilities` (including the `app_data_update` proposal, `0x0008`)
3. **Generates Secrets:** Creates initial encryption keys
4. **Returns State:** Provides ClientState for ongoing operations

## ClientState

The `ClientState` object contains everything needed to operate the group:

- Current encryption keys
- Member list and their credentials
- Group context (including the app-component dictionary)
- Epoch number
- Pending proposals

**Important:** ClientState must be serialized and stored for persistence. See [Client State](./state) for details.

## Example: Complete Group Creation

```typescript
import {
  generateKeyPackage,
  createSimpleGroup,
  createCredential,
  getNostrGroupIdHex,
} from "@internet-privacy/marmot-ts";
import {
  ciphersuites,
  defaultCryptoProvider,
} from "@internet-privacy/marmot-ts/mls";

const credential = createCredential(myPubkey);
const ciphersuiteImpl = await defaultCryptoProvider.getCiphersuiteImpl(
  ciphersuites.MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519,
);

// 1. Generate creator's key package
const myKeyPackage = await generateKeyPackage({
  credential,
  ciphersuiteImpl,
  signer, // signs the 0x8009 account identity proof
});

// 2. Create the group (seeds profile + admin-policy + nostr routing components)
const { clientState } = await createSimpleGroup(
  myKeyPackage,
  ciphersuiteImpl,
  "Developer Chat",
  {
    description: "A group for TypeScript developers",
    adminPubkeys: [myPubkey],
    relays: ["wss://relay.damus.io", "wss://relay.snort.social"],
  },
);

// 3. Group is ready to use!
console.log("Group created with ID:", getNostrGroupIdHex(clientState));
```

## Group Metadata

In Marmot v2 group metadata lives in versioned app components (the
`app_data_dictionary` MLS extension). Read it as a single projection with
`getMarmotGroupView`:

```typescript
import { getMarmotGroupView } from "@internet-privacy/marmot-ts";

const view = getMarmotGroupView(clientState);

console.log(view?.name); // "Developer Chat"
console.log(view?.description); // "A group for..."
console.log(view?.relays); // ["wss://..."]
console.log(view?.adminPubkeys); // ["admin-hex"]
console.log(view?.avatarUrl); // "https://..." (group.avatar-url.v1)
console.log(view?.name); // "Developer Chat"
console.log(view?.description); // "A group for..."
console.log(view?.relays); // ["wss://..."]
console.log(view?.adminPubkeys); // ["admin-hex"]
console.log(view?.avatarUrl); // "https://..." (group.avatar-url.v1)
console.log(view?.image?.mediaType); // "image/png" (group.blossom.image.v1)
console.log(view?.nostrGroupId); // Uint8Array | undefined (routing component)
console.log(view?.encryptedMedia); // encrypted-media policy, if set
console.log(view?.messageRetention); // message-retention policy, if set
console.log(view?.protocolLifecycle); // e.g. "active"
```

The encrypted group image (`group.blossom.image.v1`, used by White Noise) is one
Blossom blob. Fetch it by `view.image.imageHash` and decrypt it with
`decryptGroupBlossomImage(blob, view.image)`. To set one, encrypt it with
`encryptGroupBlossomImage(bytes, "image/png")`, upload `encryptedBlob` (the
Blossom upload authorization is signed with `image.imageUploadKey`), then commit
`proposeUpdateMetadata({ image })`. When both `avatarUrl` and `image` are set,
the URL avatar wins for rendering.

`getMarmotGroupView` returns `null` when the group has none of the profile, admin-policy and routing components.
See [Protocol Constants & Concepts](./protocol) for the app-component model.

## Related

- [Client State](./state) - Managing and persisting group state
- [Messages](./messages) - Sending messages in groups
- [Members](./members) - Managing group membership
- [Protocol](./protocol) - app-component extension details
