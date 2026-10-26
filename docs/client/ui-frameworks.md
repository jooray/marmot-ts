# UI Frameworks

`MarmotGroup.snapshot` and `client.groups.snapshot` provide synchronous, reference-stable UI state with `changed` events. Async watchers are also available. The default `client.groups.watch()` observes group-set changes; opt into `includeStateChanges` to also observe metadata, membership, lifecycle, convergence and Welcome outcomes.

This guide shows how to consume these async iterators in different frameworks and patterns for managing the client instance lifecycle.

## Understanding Async Generators

The client provides two primary reactive APIs that return [async generators](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Statements/async_function*):

```typescript
// Emits whenever groups are created, joined, loaded, or destroyed
for await (const groups of client.groups.watch()) {
  console.log(`You have ${groups.length} groups`);
}

// Emits whenever key packages change
for await (const packages of client.keyPackages.watchKeyPackages()) {
  console.log(`You have ${packages.length} key packages`);
}
```

**What are async generators?** They're functions that can yield multiple values over time, with each value wrapped in a Promise. Think of them as streams of data that you can consume at your own pace.

### Using `for await...of` (Recommended)

The `for await...of` loop is the most convenient way to consume async generators. It automatically:

- Waits for each Promise to resolve
- Handles the iteration protocol
- Breaks cleanly when the generator completes

### Using Manual `.next()` API

For more control, you can manually iterate using the `.next()` method:

```typescript
const iterator = client.groups.watch()[Symbol.asyncIterator]();

// Get first value
const { value: groups1, done } = await iterator.next();
if (!done) {
  console.log(`Current groups:`, groups1);
}

// Get next value when ready
const { value: groups2 } = await iterator.next();
console.log(`Updated groups:`, groups2);

// Clean up when done
await iterator.return?.();
```

**When to use manual `.next()`:**

- Building custom observables or reactive wrappers
- Implementing backpressure (controlling the rate of updates)
- Creating specialized iteration patterns
- Debugging or inspecting individual updates

**Your framework integration needs to:**

1. Start iterating when the component/view mounts
2. Update UI state with each emitted value
3. Cancel the iterator when the component/view unmounts

## React Integration

### Synchronous snapshots with `useSyncExternalStore`

Use the per-group snapshot for a group header or settings page. It updates only
when that group's visible state changes:

```typescript
import { useCallback, useSyncExternalStore } from "react";
import type { MarmotClient, MarmotGroup } from "@internet-privacy/marmot-ts";

function useGroupSnapshot(group: MarmotGroup) {
  const subscribe = useCallback((notify: () => void) => {
    group.on("changed", notify);
    return () => { group.off("changed", notify); };
  }, [group]);
  const getSnapshot = useCallback(() => group.snapshot, [group]);
  return useSyncExternalStore(subscribe, getSnapshot);
}

function useGroups(client: MarmotClient) {
  const subscribe = useCallback((notify: () => void) => {
    client.groups.on("changed", notify);
    return () => { client.groups.off("changed", notify); };
  }, [client]);
  const getSnapshot = useCallback(() => client.groups.snapshot, [client]);
  return useSyncExternalStore(subscribe, getSnapshot);
}

function GroupList({ client }: { client: MarmotClient }) {
  const groups = useGroups(client);
  return (
    <ul>
      {groups.map(group => (
        <li key={group.id}>{group.groupData?.name ?? "(disbanded)"}</li>
      ))}
    </ul>
  );
}
```

The manager snapshot contains read-only snapshots of currently loaded groups.
Hydrate persisted groups with `await client.groups.loadAll()` during application
startup. The getter itself never reads storage, and unaffected groups keep their
snapshot identity when another group changes. Server-rendered applications must
also supply an appropriate `getServerSnapshot` to React.

### Async group watching

For frameworks that prefer streams, create a fresh watcher for each mount and
abort it during cleanup:

```typescript
const controller = new AbortController();
const watcher = client.groups.watch({
  includeStateChanges: true,
  signal: controller.signal,
});

(async () => {
  for await (const groups of watcher) updateUI(groups);
})();

// On unmount: detaches immediately and wakes a pending next().
controller.abort();
```

This mode yields loaded group instances immediately without a storage read.
Read `group.snapshot` for reference-stable per-group values. It may coalesce
updates while the consumer is busy. A per-group `group.watch({ signal })` yields
snapshots directly and ends on disposal or destruction. Both watcher modes also
support immediate cleanup through `return()`.

**Reusable for key packages:**

```typescript
import type { ListedKeyPackage } from "@internet-privacy/marmot-ts";

function useWatchKeyPackages(client: MarmotClient | null) {
  const [packages, setPackages] = useState<ListedKeyPackage[]>([]);

  useEffect(() => {
    if (!client) {
      setPackages([]);
      return;
    }

    const gen = client.keyPackages.watchKeyPackages();
    let cancelled = false;

    (async () => {
      for await (const pkgs of gen) {
        if (cancelled) break;
        setPackages(pkgs);
      }
    })();

    return () => {
      cancelled = true;
      void gen.return(undefined);
    };
  }, [client]);

  return packages;
}
```

## Svelte 5 Integration

### Reusable Function Pattern

Svelte 5 uses runes (`$state`, `$effect`) which work in `.svelte.js` files for reusable reactive logic:

```typescript
// useWatchGroups.svelte.js
export function useWatchGroups(client) {
  let groups = $state([]);
  const gen = client.groups.watch();
  let cancelled = false;

  $effect(() => {
    (async () => {
      for await (const value of gen) {
        if (cancelled) break;
        groups = value;
      }
    })();

    return () => {
      cancelled = true;
      gen.return?.();
    };
  });

  return {
    get value() {
      return groups;
    },
  };
}
```

```svelte
<!-- GroupList.svelte -->
<script>
  import { useWatchGroups } from "./useWatchGroups.svelte.js";

  let { client } = $props();

  const stream = useWatchGroups(client);
</script>

<ul>
  {#each stream.value as group}
    <li>{group.groupData?.name ?? "(disbanded)"}</li>
  {/each}
</ul>
```

**Why this works:**

- Svelte 5 component scripts run once (not on every re-render like React)
- Generator is created outside `$effect`, so it's stable
- `gen.return()` properly closes the generator on cleanup

## SolidJS Integration

SolidJS components run once, making this the cleanest integration:

```typescript
import { createSignal, onCleanup } from "solid-js";
import type { MarmotClient } from "@internet-privacy/marmot-ts";

function useWatchGroups(client: MarmotClient) {
  const [groups, setGroups] = createSignal([]);
  const gen = client.groups.watch();
  let cancelled = false;

  (async () => {
    for await (const value of gen) {
      if (cancelled) break;
      setGroups(value);
    }
  })();

  onCleanup(() => {
    cancelled = true;
    gen.return?.();
  });

  return groups;
}

// Usage
function GroupList(props) {
  const groups = useWatchGroups(props.client);

  return (
    <ul>
      <For each={groups()}>{(group) => <li>{group.groupData?.name ?? "(disbanded)"}</li>}</For>
    </ul>
  );
}
```

**Why SolidJS is ideal:**

- Component body runs **once**, no re-render issues
- No effect re-runs or memoization tricks
- Natural fit for async generator pattern

## Vue 3 Integration

Vue's Composition API with `<script setup>` also runs once per mount:

```typescript
// useWatchGroups.js
import { ref, onUnmounted } from "vue";

export function useWatchGroups(client) {
  const groups = ref([]);
  const gen = client.groups.watch();
  let cancelled = false;

  (async () => {
    for await (const value of gen) {
      if (cancelled) break;
      groups.value = value;
    }
  })();

  onUnmounted(() => {
    cancelled = true;
    gen.return?.();
  });

  return groups;
}
```

```vue
<!-- GroupList.vue -->
<script setup>
import { useWatchGroups } from "./useWatchGroups";

const props = defineProps(["client"]);
const groups = useWatchGroups(props.client);
</script>

<template>
  <ul>
    <li v-for="group in groups" :key="group.idStr">
      {{ group.groupData?.name ?? "(disbanded)" }}
    </li>
  </ul>
</template>
```

## Vanilla JavaScript

### Direct Async Generator Usage

```typescript
const client = new MarmotClient({/* ... */});
const gen = client.groups.watch();
let cancelled = false;

(async () => {
  for await (const groups of gen) {
    if (cancelled) break;

    // Update DOM
    const container = document.getElementById("groups");
    container.innerHTML = "";

    groups.forEach((group) => {
      const li = document.createElement("li");
      li.textContent = group.groupData?.name ?? "(disbanded)";
      container.appendChild(li);
    });
  }
})();

// Cleanup when navigating away
window.addEventListener("beforeunload", () => {
  cancelled = true;
  gen.return?.();
});
```

### Event Listener Pattern

For simpler use cases, subscribe to client events instead:

```typescript
client.groups.on("updated", (groups) => {
  updateGroupListUI(groups);
});

client.groups.on("created", (group) => {
  showNotification(`New group: ${group.groupData?.name ?? "(unnamed)"}`);
});
```

## Framework Comparison

| Framework    | Setup Complexity | Generator Stability | Cleanup                            |
| ------------ | ---------------- | ------------------- | ---------------------------------- |
| **React**    | Medium           | New one per effect  | `gen.return()` in cleanup          |
| **Svelte 5** | Low              | Natural (runs once) | `gen.return()` in `$effect` return |
| **SolidJS**  | Low              | Natural (runs once) | `gen.return()` in `onCleanup`      |
| **Vue 3**    | Low              | Natural (runs once) | `gen.return()` in `onUnmounted`    |
| **Vanilla**  | Lowest           | Manual management   | Manual cleanup                     |

**The core pattern is always the same:**

1. Create the async generator once
2. Loop with `for await...of`
3. Update your framework's reactive state
4. Set a `cancelled` flag on cleanup
5. Call `gen.return()` to properly close the generator

## Multi-Account Considerations

### Per-Account Storage Isolation

**Critical:** each user account must have its own isolated storage so key material never mixes. Isolate **every** store the client uses, not only the group and key package stores:

```typescript
import localforage from "localforage"; // any GenericKeyValueStore works

function storesForAccount(pubkey: string) {
  // LocalForage instances satisfy GenericKeyValueStore (see Storage)
  const store = (storeName: string) =>
    localforage.createInstance({ name: `marmot-${pubkey}`, storeName });

  return {
    groupStateStore: store("groups"),
    keyPackageStore: store("keyPackages"),
    inviteStore: store("invites"),
    ingestStateStore: store("ingest"),
    rewindStore: store("rewind"),
    removedMarkerStore: store("removed"),
  };
}
```

**Why this matters:**

- Each user has different private keys for MLS
- Mixing storage would leak keys between accounts
- Security requires complete isolation per account

See [Storage](/client/storage) for the store contract and other backends.

### Account Switching Pattern

When a user switches accounts, tear down the old client's relay subscriptions and groups first. Otherwise they keep ingesting into the old account's stores. Then create a new client:

```typescript
import type { Unsubscribable } from "@internet-privacy/marmot-ts/client";

let currentClient: MarmotClient | null = null;
let groupSync: Unsubscribable | undefined;
let inviteSync: Unsubscribable | undefined;

async function switchToAccount(account: Account) {
  // Stop the old account's relay subscriptions and release its groups
  groupSync?.unsubscribe();
  inviteSync?.unsubscribe();
  for (const group of currentClient?.groups.loaded ?? []) group.dispose();
  currentClient = null;

  // Create new client with account-specific storage
  currentClient = new MarmotClient({
    signer: account.signer, // must support nip44
    network: sharedNetworkInterface, // can be shared
    clientId: account.keyPackageSlotId, // persisted random 32-byte hex, per account
    ...storesForAccount(account.pubkey),
  });

  groupSync = currentClient.groups.connectAll();
  inviteSync = await currentClient.invites.listen(account.inboxRelays);

  return currentClient;
}
```

**Framework-specific handling:**

- **React:** Update state with new client, `useEffect` will handle cleanup
- **Svelte:** Reassign the client variable, reactive statements will re-run
- **Vanilla:** Cancel old iterators and start new ones

## Background Synchronization

::: warning
`MarmotClient` doesn't open relay subscriptions by itself. Start them once at app startup, not once per page:

- `const groupSync = client.groups.connectAll()` fetches past kind 445 events and processes new ones for every loaded group. It verifies signatures and `h` tags, and it also connects groups that are created or joined later.
- `const inviteSync = await client.invites.listen(inboxRelays)` receives gift-wrapped Welcomes on your kind 10050 inbox relays.

Call `.unsubscribe()` on both when the account signs out. Without them, groups fall out of sync and fail to decrypt new messages.
:::

See the [`MarmotGroup` documentation](/client/marmot-group) for details on receiving messages.

## Next Steps

- **[MarmotClient](/client/marmot-client)** - Understand the client's role and lifecycle
- **[MarmotGroup](/client/marmot-group)** - Learn about group-level operations
- **[Storage](/client/storage)** - Implement persistent storage backends
- **[Network Interface](/client/network)** - Connect to Nostr relays
- **[Best Practices](/client/best-practices)** - Production deployment patterns
