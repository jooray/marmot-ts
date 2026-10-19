/** Internal completion ownership, deliberately absent from public barrels. */
const owners = new WeakMap<object, () => Promise<void>>();

export function registerSettledRetentionOwner(
  engine: object,
  complete: () => Promise<void>,
): void {
  owners.set(engine, complete);
}

export function unregisterSettledRetentionOwner(engine: object): void {
  owners.delete(engine);
}

export async function completeSettledRetentionOwner(
  engine: object,
): Promise<void> {
  await owners.get(engine)?.();
}
