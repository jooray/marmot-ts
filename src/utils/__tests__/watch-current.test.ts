import { describe, expect, it, vi } from "vitest";
import { watchCurrent } from "../watch-current.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function source(
  read: () => number | Promise<number>,
  signal?: AbortSignal,
  discardStale = false,
) {
  const listeners = new Set<() => void>();
  const watcher = watchCurrent({
    read,
    signal,
    discardStale,
    subscribe: (changed) => {
      listeners.add(changed);
      return () => {
        listeners.delete(changed);
      };
    },
  });
  return {
    watcher,
    listeners,
    changed: () => {
      for (const listener of listeners) listener();
    },
  };
}

describe("watchCurrent cancellation", () => {
  for (const end of ["return", "abort", "dispose", "throw"] as const) {
    for (const stage of ["idle", "reading"] as const) {
      it(`${end} interrupts ${stage} without another change`, async () => {
        const controller = new AbortController();
        const read = deferred<number>();
        const { watcher, listeners } = source(
          stage === "idle" ? () => 1 : () => read.promise,
          controller.signal,
        );
        if (stage === "idle") await watcher.next();
        const pending = watcher.next();
        expect(listeners.size).toBe(1);
        const error = new Error("closed");
        let closing: PromiseLike<unknown> | undefined;
        if (end === "return") closing = watcher.return(undefined);
        if (end === "abort") controller.abort();
        if (end === "dispose") closing = watcher[Symbol.asyncDispose]();
        if (end === "throw")
          closing = expect(watcher.throw(error)).rejects.toBe(error);
        expect(listeners.size).toBe(0);
        await expect(pending).resolves.toMatchObject({ done: true });
        await closing;
        if (stage === "reading") read.reject(new Error("late read failure"));
        else read.resolve(1);
        await expect(watcher.next()).resolves.toMatchObject({ done: true });
        await watcher.return(undefined);
      });
    }
  }

  it("pre-abort and closing before first pull perform no work", async () => {
    const controller = new AbortController();
    controller.abort();
    const read = vi.fn(() => 1);
    const first = source(read, controller.signal);
    expect((await first.watcher.next()).done).toBe(true);
    const second = source(read);
    await second.watcher.return(undefined);
    expect((await second.watcher.next()).done).toBe(true);
    expect(read).not.toHaveBeenCalled();
    expect(first.listeners.size + second.listeners.size).toBe(0);
  });

  it("latches hydration and paused-consumer changes", async () => {
    const initial = deferred<number>();
    let value = 1;
    const read = vi
      .fn()
      .mockImplementationOnce(() => initial.promise)
      .mockImplementation(() => value);
    const { watcher, changed } = source(read);
    const pending = watcher.next();
    value = 2;
    changed();
    initial.resolve(1);
    expect((await pending).value).toBe(1);
    expect((await watcher.next()).value).toBe(2);
    value = 3;
    changed();
    changed();
    expect((await watcher.next()).value).toBe(3);
    await watcher.return(undefined);
  });

  it("discards overtaken storage results", async () => {
    const initial = deferred<number>();
    const read = vi
      .fn()
      .mockImplementationOnce(() => initial.promise)
      .mockResolvedValue(2);
    const { watcher, changed } = source(read, undefined, true);
    const pending = watcher.next();
    changed();
    initial.resolve(1);
    expect((await pending).value).toBe(2);
    await watcher.return(undefined);
  });

  it("yields an overtaken read after repeated discards", async () => {
    let value = 0;
    const { watcher, changed } = source(
      async () => {
        const result = ++value;
        changed();
        return result;
      },
      undefined,
      true,
    );
    expect((await watcher.next()).value).toBe(3);
    expect((await watcher.next()).value).toBe(6);
    await watcher.return(undefined);
  });

  it("propagates live failures and cleans up", async () => {
    const error = new Error("storage failed");
    const { watcher, listeners } = source(() => Promise.reject(error));
    await expect(watcher.next()).rejects.toBe(error);
    expect(listeners.size).toBe(0);
  });

  it("handles abort triggered by the reader itself", async () => {
    const controller = new AbortController();
    const { watcher } = source(() => {
      controller.abort();
      return new Promise<number>(() => {});
    }, controller.signal);
    expect((await watcher.next()).done).toBe(true);
  });
});
