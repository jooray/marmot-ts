/** Internal per-owner bridge; no option or public barrel export. */
const sessions = new WeakMap<object, (eventId: string) => void>();
const runtimes = new WeakMap<object, object>();

export function registerPublicationRetention(
  session: object,
  confirmed: (eventId: string) => void,
): void {
  sessions.set(session, confirmed);
}

export function linkPublicationRetention(
  runtime: object,
  session: object,
): void {
  runtimes.set(runtime, session);
}

export function confirmPublicationRetention(
  runtime: object,
  eventId: string,
): void {
  const owner = runtimes.get(runtime);
  if (owner) sessions.get(owner)?.(eventId);
}

export function unregisterPublicationRetention(session: object): void {
  sessions.delete(session);
}
