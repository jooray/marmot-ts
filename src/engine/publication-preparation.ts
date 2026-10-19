/** Internal ownership for preparation rejected before its result is returned. */
const owners = new WeakMap<object, (ids: readonly string[]) => void>();

export function registerPublicationPreparationOwner(
  engine: object,
  rejected: (ids: readonly string[]) => void,
): void {
  owners.set(engine, rejected);
}

export function unregisterPublicationPreparationOwner(engine: object): void {
  owners.delete(engine);
}

export function rejectPublicationPreparation(
  engine: object,
  ids: readonly string[],
): void {
  owners.get(engine)?.(ids);
}
