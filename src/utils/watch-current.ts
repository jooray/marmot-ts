const stopped = Symbol("cancelled");

/** Consecutive overtaken reads to discard before yielding one anyway. */
const MAX_DISCARDED_READS = 3;

/**
 * Watch a current value, coalescing changes while the consumer is
 * busy. Cancellation also wakes an outstanding next(), unlike a bare generator.
 * @internal
 */
export function watchCurrent<T>(options: {
  read: () => T | PromiseLike<T>;
  /**
   * Discard reads overtaken by changes (for storage-backed timelines). Bounded
   * so a steady change stream cannot starve the consumer; the next pull rereads.
   */
  discardStale?: boolean;
  subscribe: (changed: () => void) => () => void;
  signal?: AbortSignal;
  closed?: AbortSignal;
}): AsyncGenerator<T> {
  let cancelled = false;
  let version = 0;
  let wake: (() => void) | undefined;
  let cancelRead: (() => void) | undefined;
  let unsubscribe: (() => void) | undefined;
  const changed = () => {
    version++;
    wake?.();
    wake = undefined;
  };
  const cancel = () => {
    if (cancelled) return;
    cancelled = true;
    cancelRead?.();
    cancelRead = undefined;
    unsubscribe?.();
    unsubscribe = undefined;
    options.signal?.removeEventListener("abort", cancel);
    options.closed?.removeEventListener("abort", cancel);
    wake?.();
    wake = undefined;
  };
  const iterator = (async function* () {
    if (cancelled || options.signal?.aborted || options.closed?.aborted) return;
    try {
      unsubscribe = options.subscribe(changed);
      options.signal?.addEventListener("abort", cancel, { once: true });
      options.closed?.addEventListener("abort", cancel, { once: true });
      if (options.signal?.aborted || options.closed?.aborted) cancel();
      let yieldedVersion = -1;
      let discarded = 0;
      while (!cancelled) {
        if (yieldedVersion === version)
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        if (cancelled) return;
        const readVersion = version;
        const value = options.read();
        // Only async reads can be pending, so only they race cancellation.
        const result = isThenable(value)
          ? await Promise.race([
              value,
              new Promise<typeof stopped>((resolve) => {
                cancelRead = () => resolve(stopped);
                if (cancelled) cancelRead();
              }),
            ])
          : value;
        cancelRead = undefined;
        if (cancelled || result === stopped) return;
        if (
          options.discardStale &&
          readVersion !== version &&
          ++discarded < MAX_DISCARDED_READS
        )
          continue;
        discarded = 0;
        yieldedVersion = readVersion;
        yield result;
      }
    } finally {
      cancel();
    }
  })();
  return {
    next: (...args) => iterator.next(...args),
    return: (value) => {
      cancel();
      return iterator.return(value);
    },
    throw: (error) => {
      cancel();
      return iterator.throw(error);
    },
    [Symbol.asyncIterator]() {
      return this;
    },
    async [Symbol.asyncDispose]() {
      cancel();
      await iterator.return(undefined);
    },
  };
}

function isThenable<T>(value: T | PromiseLike<T>): value is PromiseLike<T> {
  return typeof (value as PromiseLike<T> | undefined)?.then === "function";
}
