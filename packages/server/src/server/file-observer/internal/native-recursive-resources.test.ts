import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { createFileObserver, type FileChange } from "../index.js";
import { createManagedObservation } from "./observation.js";
import { createNativeRecursiveBackend } from "./native-recursive.js";
import { NativeRecursiveResources } from "./native-recursive-resources.js";
import { createObserverPaths } from "./paths.js";

// Individual roots fit comfortably. Only their aggregate exceeds the daemon's
// resource envelope, which a per-root inventory cap cannot prevent.
test("aggregate inventory exhaustion preserves existing roots and close releases capacity", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-shared-budget-"));
  const resources = new NativeRecursiveResources({ maxTrackedEntries: 6, maxConcurrentAudits: 2 });
  const paths = createObserverPaths(process.platform);
  const roots = await Promise.all(
    ["first", "second", "third"].map(async (name) => {
      const directory = join(root, name);
      await mkdir(directory);
      await writeFile(join(directory, "one"), "one");
      await writeFile(join(directory, "two"), "two");
      return directory;
    }),
  );
  const backends = roots.map((directory) =>
    createNativeRecursiveBackend(
      {
        root: directory,
        metrics: createFileObserver().getDiagnostics(),
        isActive: () => true,
        isIgnored: () => false,
        isPathInside: paths.isInside,
        queueEvent: () => {},
        fail: (error) => {
          throw error;
        },
      },
      paths,
      () => ({ close: () => {}, on: () => {} }),
      resources,
    ),
  );
  try {
    await backends[0]!.start();
    await backends[1]!.start();
    await expect(backends[2]!.start()).rejects.toThrow("shared inventory limit of 6 entries");
    expect(backends[0]!.getDiagnostics().nativeTrackedFileCount).toBe(2);
    expect(backends[1]!.getDiagnostics().nativeTrackedFileCount).toBe(2);
    await backends[1]!.updateIgnore();
    expect(backends[1]!.getDiagnostics().nativeTrackedFileCount).toBe(2);
    await backends[0]!.close();
    await backends[2]!.start();
    expect(backends[2]!.getDiagnostics().nativeTrackedFileCount).toBe(2);
  } finally {
    await Promise.all(backends.map((backend) => backend.close()));
    await rm(root, { recursive: true, force: true });
  }
});

function createBackend(
  root: string,
  resources: NativeRecursiveResources,
  options: {
    isIgnored?: (path: string) => boolean;
    ignoredRoots?: string[];
    progress?: () => void;
    admission?: (state: "queued" | "admitted") => void;
    queueEvent?: (type: "create" | "update" | "delete", path: string) => void;
    observe?: Parameters<typeof createNativeRecursiveBackend>[2];
  } = {},
) {
  const paths = createObserverPaths(process.platform);
  return createNativeRecursiveBackend(
    {
      root,
      metrics: createFileObserver().getDiagnostics(),
      isActive: () => true,
      isIgnored: options.isIgnored ?? (() => false),
      ignoredRoots: options.ignoredRoots,
      isPathInside: paths.isInside,
      onInventoryProgress: options.progress,
      onInventoryAdmission: options.admission,
      queueEvent: options.queueEvent ?? (() => {}),
      fail: (error) => {
        throw error;
      },
    },
    paths,
    options.observe ?? (() => ({ close: () => {}, on: () => {} })),
    resources,
  );
}

test("failed and cancelled startup inventories leave capacity for another root", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-budget-start-failure-"));
  const large = join(root, "large");
  const small = join(root, "small");
  await mkdir(large);
  await mkdir(small);
  await writeFile(join(large, "one"), "one");
  await writeFile(join(large, "two"), "two");
  await writeFile(join(small, "one"), "one");
  const resources = new NativeRecursiveResources({ maxTrackedEntries: 2, maxConcurrentAudits: 2 });
  const failed = createBackend(large, resources);
  const healthy = createBackend(small, resources);
  try {
    await expect(failed.start()).rejects.toThrow("shared inventory limit of 2 entries");
    await healthy.start();
    expect(healthy.getDiagnostics().nativeTrackedFileCount).toBe(1);
    await healthy.close();
    const cancelledResources = new NativeRecursiveResources({
      maxTrackedEntries: 100,
      maxConcurrentAudits: 2,
    });
    await Promise.all(
      Array.from({ length: 32 }, async (_, i) => {
        const directory = join(large, `directory-${i}`);
        await mkdir(directory);
        await writeFile(join(directory, "nested"), "nested");
      }),
    );
    let progress = 0;
    let closing: Promise<void> | undefined;
    const cancelled = createBackend(large, cancelledResources, {
      progress: () => {
        progress += 1;
        if (progress === 2) closing = cancelled.close();
      },
    });
    await cancelled.start();
    expect(progress).toBe(2);
    await closing;
    const replacement = createBackend(large, cancelledResources);
    try {
      await replacement.start();
      expect(replacement.getDiagnostics().nativeTrackedFileCount).toBe(34);
    } finally {
      await replacement.close();
    }
  } finally {
    await failed.close();
    await healthy.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("an ignored subtree releases retained capacity for another observation", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-budget-ignore-"));
  const first = join(root, "first");
  const generated = join(first, "generated");
  const second = join(root, "second");
  await mkdir(generated, { recursive: true });
  await mkdir(second);
  await writeFile(join(generated, "output"), "generated");
  await writeFile(join(first, "kept"), "kept");
  await writeFile(join(second, "file"), "file");
  const resources = new NativeRecursiveResources({ maxTrackedEntries: 4, maxConcurrentAudits: 2 });
  const paths = createObserverPaths(process.platform);
  let ignored = false;
  const firstBackend = createBackend(first, resources, {
    isIgnored: (path) => ignored && paths.isInside(generated, path),
  });
  const secondBackend = createBackend(second, resources);
  try {
    await firstBackend.start();
    await expect(secondBackend.start()).rejects.toThrow("shared inventory limit of 4 entries");
    ignored = true;
    await firstBackend.updateIgnore();
    expect(firstBackend.getDiagnostics().nativeTrackedFileCount).toBe(1);
    await secondBackend.start();
    expect(secondBackend.getDiagnostics().nativeTrackedFileCount).toBe(1);
  } finally {
    await Promise.all([firstBackend.close(), secondBackend.close()]);
    await rm(root, { recursive: true, force: true });
  }
});

test("admission callback cancellation never runs its audit or strands the next waiter", async () => {
  const resources = new NativeRecursiveResources({ maxTrackedEntries: 20, maxConcurrentAudits: 1 });
  const controller = new AbortController();
  const audit = vi.fn(async () => {});
  const reason = new Error("closed during admission callback");
  const canceled = resources.runAudit(audit, controller.signal, () => controller.abort(reason));
  const following = vi.fn(async () => {});
  const next = resources.runAudit(following, new AbortController().signal);
  await expect(canceled).rejects.toBe(reason);
  await next;
  expect(audit).not.toHaveBeenCalled();
  expect(following).toHaveBeenCalledOnce();
});

test("audits share two slots and closing a queued root does not wait for busy roots", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-shared-audits-"));
  const resources = new NativeRecursiveResources({ maxTrackedEntries: 20, maxConcurrentAudits: 2 });
  const roots = await Promise.all(
    ["one", "two", "three", "four"].map(async (name) => {
      const directory = join(root, name);
      await mkdir(directory);
      return directory;
    }),
  );
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const admissions: string[][] = roots.map(() => []);
  let started = 0;
  let active = 0;
  let peak = 0;
  const backends = roots.map((directory, index) =>
    createBackend(directory, resources, {
      admission: (state) => admissions[index]!.push(state),
      observe: async () => {
        started += 1;
        active += 1;
        peak = Math.max(peak, active);
        await gate;
        active -= 1;
        return { close: () => {}, on: () => {} };
      },
    }),
  );
  const starting = backends.slice(0, 3).map((backend) => backend.start());
  try {
    await expect.poll(() => started).toBe(2);
    expect(admissions.slice(0, 3)).toEqual([["admitted"], ["admitted"], ["queued"]]);
    expect(backends.map((backend) => backend.getDiagnostics().nativeAuditQueuedCount)).toEqual([
      0, 0, 1, 0,
    ]);
    expect(backends.map((backend) => backend.getDiagnostics().nativeAuditAdmittedCount)).toEqual([
      1, 1, 0, 0,
    ]);
    await backends[2]!.close();
    await starting[2];
    expect(started).toBe(2);
    const fourth = backends[3]!.start();
    expect(started).toBe(2);
    release();
    await Promise.all([...starting, fourth]);
    expect(started).toBe(3);
    expect(admissions[2]).toEqual(["queued"]);
    expect(admissions[3]).toEqual(["queued", "admitted"]);
    expect(peak).toBe(2);
    expect(backends[2]!.getDiagnostics()).toMatchObject({
      nativeHandleCount: 0,
      nativeAuditQueuedCount: 0,
      nativeAuditAdmittedCount: 0,
      pendingReconciliationWorkCount: 0,
      reconciliationInFlight: false,
    });
  } finally {
    release();
    await Promise.all(starting);
    await Promise.all(backends.map((backend) => backend.close()));
    await rm(root, { recursive: true, force: true });
  }
});

test("native event growth fails into cleanup and preserves unrelated edit delivery", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-budget-event-growth-"));
  const roots = await Promise.all(
    ["first", "second", "replacement"].map(async (name) => {
      const directory = join(root, name);
      await mkdir(directory);
      await writeFile(join(directory, "tracked"), "tracked");
      return directory;
    }),
  );
  const resources = new NativeRecursiveResources({ maxTrackedEntries: 4, maxConcurrentAudits: 2 });
  const paths = createObserverPaths(process.platform);
  const notifications = new Map<string, (event: string, filename: string | null) => void>();
  const errors: Error[][] = roots.map(() => []);
  const events: FileChange[][] = roots.map(() => []);
  const observations = roots.map((directory, index) =>
    createManagedObservation({
      root: directory,
      paths,
      options: {},
      metrics: createFileObserver().getDiagnostics(),
      callback: (error, batch) => {
        if (error) errors[index]!.push(error);
        else events[index]!.push(...batch);
      },
      onClosed: () => {},
      createBackend: (host) =>
        createNativeRecursiveBackend(
          host,
          paths,
          (_root, listener) => {
            notifications.set(directory, listener);
            return {
              close: () => {
                notifications.delete(directory);
              },
              on: () => {},
            };
          },
          resources,
        ),
    }),
  );
  try {
    await observations[0]!.start();
    await observations[1]!.start();
    const added = join(roots[0]!, "new-file");
    await writeFile(added, "new");
    notifications.get(roots[0]!)!("rename", "new-file");
    await expect.poll(() => errors[0]!.length).toBe(1);
    await observations[0]!.close();
    expect(errors[0]![0]!.message).toContain("shared inventory limit of 4 entries");
    expect(observations[0]!.getDiagnostics().nativeTrackedFileCount).toBe(0);
    await observations[2]!.start();
    expect(observations[2]!.getDiagnostics().nativeTrackedFileCount).toBe(1);
    const edited = join(roots[1]!, "tracked");
    await writeFile(edited, "changed");
    notifications.get(roots[1]!)!("change", "tracked");
    await expect.poll(() => events[1]).toEqual([{ path: edited, type: "update" }]);
    expect(errors[1]).toEqual([]);
    expect(errors[0]).toHaveLength(1);
  } finally {
    await Promise.all(observations.map((observation) => observation.close()));
    await rm(root, { recursive: true, force: true });
  }
});

test("native cleanup errors still release retained inventory capacity", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-budget-close-error-"));
  const first = join(root, "first");
  const second = join(root, "second");
  await mkdir(first);
  await mkdir(second);
  await writeFile(join(first, "file"), "file");
  await writeFile(join(second, "file"), "file");
  const resources = new NativeRecursiveResources({ maxTrackedEntries: 2, maxConcurrentAudits: 2 });
  const failed = createBackend(first, resources, {
    observe: () => ({
      close: () => {
        throw new Error("native close failed");
      },
      on: () => {},
    }),
  });
  const replacement = createBackend(second, resources);
  try {
    await failed.start();
    await expect(failed.close()).rejects.toThrow("native close failed");
    expect(failed.getDiagnostics().nativeTrackedFileCount).toBe(0);
    await replacement.start();
    expect(replacement.getDiagnostics().nativeTrackedFileCount).toBe(1);
  } finally {
    await failed.close().catch(() => {}); // The expected rejection was asserted above.
    await replacement.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed native close still waits for and closes every sibling handle", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-budget-close-barrier-"));
  const first = join(root, "first");
  const second = join(root, "second");
  const delayed = join(first, "delayed");
  await mkdir(delayed, { recursive: true });
  await mkdir(join(first, "other"));
  await mkdir(second);
  const resources = new NativeRecursiveResources({ maxTrackedEntries: 3, maxConcurrentAudits: 2 });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const closed: string[] = [];
  const backend = createBackend(first, resources, {
    ignoredRoots: [join(first, "ignored")],
    observe: (directory) => ({
      close: () => {
        closed.push(directory);
        if (directory === first) throw new Error("first close failed");
        if (directory === delayed) return gate;
      },
      on: () => {},
    }),
  });
  const replacement = createBackend(second, resources);
  let settled = false;
  try {
    await backend.start();
    const closing = backend.close().then(
      () => {
        settled = true;
        return undefined;
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    await expect.poll(() => closed.length).toBe(3);
    expect(settled).toBe(false);
    await expect(replacement.start()).rejects.toThrow("shared inventory limit of 3 entries");
    release();
    expect(await closing).toMatchObject({ message: "first close failed" });
    expect(settled).toBe(true);
    await replacement.start();
  } finally {
    release();
    await backend.close().catch(() => {}); // The expected rejection was asserted above.
    await replacement.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("inventory capacity errors report the failed footprint instead of a generic watcher failure", () => {
  const resources = new NativeRecursiveResources({ maxTrackedEntries: 6, maxConcurrentAudits: 2 });
  const existing = resources.createInventoryReservation("existing");
  existing.setEntryCount(4);
  const waiting = resources.createInventoryReservation("waiting");
  expect(() => waiting.assertCanFit(3)).toThrow(
    expect.objectContaining({
      name: "FileObservationCapacityError",
      scope: "shared",
      requiredEntries: 3,
      limit: 6,
    }),
  );
  existing.release();
});

test("capacity admission waits for the entire failed root and serializes fitting waiters fairly", async () => {
  const resources = new NativeRecursiveResources({ maxTrackedEntries: 10, maxConcurrentAudits: 2 });
  const existing = resources.createInventoryReservation("existing");
  existing.setEntryCount(9);
  const order: string[] = [];
  const controller = new AbortController();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const admission = (root: string, requiredEntries: number, run: () => Promise<void>) =>
    resources
      .capacityError({ root, scope: "shared", requiredEntries, limit: 10 })
      .retryWhenAvailable({ signal: controller.signal, recheckAfterMs: 300_000, run });
  const large = admission("large", 7, async () => {
    order.push("large");
  });
  const first = admission("first", 3, async () => {
    order.push("first");
    await gate;
    resources.createInventoryReservation("first").setEntryCount(3);
  });
  const second = admission("second", 3, async () => {
    order.push("second");
  });
  expect(order).toEqual([]);
  existing.setEntryCount(7);
  await Promise.resolve();
  expect(order).toEqual(["first"]);
  existing.setEntryCount(5);
  await Promise.resolve();
  expect(order).toEqual(["first"]);
  release();
  await first;
  await Promise.resolve();
  expect(order).toEqual(["first"]);
  existing.release();
  await second;
  expect(order).toEqual(["first", "large", "second"]);
  await large;
});

test("capacity rechecks are bounded without releases and queued cancellation releases no inventory", async () => {
  vi.useFakeTimers();
  try {
    const resources = new NativeRecursiveResources({
      maxTrackedEntries: 10,
      maxConcurrentAudits: 2,
    });
    const existing = resources.createInventoryReservation("existing");
    existing.setEntryCount(10);
    const controller = new AbortController();
    const run = vi.fn(async () => {});
    const waiting = resources
      .capacityError({ root: "waiting", scope: "shared", requiredEntries: 4, limit: 10 })
      .retryWhenAvailable({ signal: controller.signal, recheckAfterMs: 300_000, run });
    await vi.advanceTimersByTimeAsync(299_999);
    expect(run).toHaveBeenCalledTimes(0);
    await vi.advanceTimersByTimeAsync(1);
    await waiting;
    expect(run).toHaveBeenCalledExactlyOnceWith("recheck");
    const cancelled = new AbortController();
    const cancelledRun = vi.fn(async () => {});
    const stopped = resources
      .capacityError({ root: "cancelled", scope: "shared", requiredEntries: 4, limit: 10 })
      .retryWhenAvailable({ signal: cancelled.signal, recheckAfterMs: 300_000, run: cancelledRun });
    const rejected = expect(stopped).rejects.toThrow("owner closed");
    cancelled.abort(new Error("owner closed"));
    await rejected;
    existing.release();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(cancelledRun).toHaveBeenCalledTimes(0);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

test("per-root capacity waits for a bounded shrink recheck instead of unrelated shared releases", async () => {
  vi.useFakeTimers();
  try {
    const resources = new NativeRecursiveResources({
      maxTrackedEntries: 10,
      maxConcurrentAudits: 2,
    });
    const existing = resources.createInventoryReservation("existing");
    existing.setEntryCount(8);
    const run = vi.fn(async () => {});
    const waiting = resources
      .capacityError({ root: "oversized", scope: "root", requiredEntries: 7, limit: 6 })
      .retryWhenAvailable({ signal: new AbortController().signal, recheckAfterMs: 300_000, run });
    existing.release();
    await vi.advanceTimersByTimeAsync(299_999);
    expect(run).toHaveBeenCalledTimes(0);
    await vi.advanceTimersByTimeAsync(1);
    await waiting;
    expect(run).toHaveBeenCalledExactlyOnceWith("recheck");
  } finally {
    vi.useRealTimers();
  }
});

test("a partially fitting startup counts its complete bounded footprint before shared rejection", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-capacity-footprint-"));
  const existingRoot = join(root, "existing");
  const waitingRoot = join(root, "waiting");
  await mkdir(existingRoot);
  await mkdir(waitingRoot);
  await Promise.all(
    Array.from({ length: 6 }, (_, i) => writeFile(join(waitingRoot, `file-${i}`), "data")),
  );
  const resources = new NativeRecursiveResources({ maxTrackedEntries: 8, maxConcurrentAudits: 2 });
  const existing = resources.createInventoryReservation(existingRoot);
  existing.setEntryCount(6);
  const waiting = createBackend(waitingRoot, resources);
  try {
    await expect(waiting.start()).rejects.toMatchObject({
      name: "FileObservationCapacityError",
      requiredEntries: 7,
      scope: "shared",
    });
    expect(waiting.getDiagnostics().nativeTrackedFileCount).toBe(0);
    existing.release();
    await waiting.start();
    expect(waiting.getDiagnostics().nativeTrackedFileCount).toBe(6);
  } finally {
    existing.release();
    await waiting.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("cancelling ready capacity admission prevents its callback and does not strand later waiters", async () => {
  const resources = new NativeRecursiveResources({ maxTrackedEntries: 10, maxConcurrentAudits: 2 });
  const controller = new AbortController();
  const run = vi.fn(async () => {});
  const ready = resources
    .capacityError({ root: "ready", scope: "shared", requiredEntries: 4, limit: 10 })
    .retryWhenAvailable({ signal: controller.signal, recheckAfterMs: 300_000, run });
  const rejected = expect(ready).rejects.toThrow("closed before admission callback");
  controller.abort(new Error("closed before admission callback"));
  const nextRun = vi.fn(async () => {});
  const next = resources
    .capacityError({ root: "next", scope: "shared", requiredEntries: 4, limit: 10 })
    .retryWhenAvailable({
      signal: new AbortController().signal,
      recheckAfterMs: 300_000,
      run: nextRun,
    });
  await rejected;
  await next;
  expect(run).toHaveBeenCalledTimes(0);
  expect(nextRun).toHaveBeenCalledExactlyOnceWith("capacity-released");
});

test("full inventory admission reserves growth before yielding diff publication to another audit", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-capacity-diff-reservation-"));
  const firstRoot = join(root, "first"),
    secondRoot = join(root, "second");
  await mkdir(firstRoot);
  await mkdir(secondRoot);
  await writeFile(join(firstRoot, "original"), "original");
  const resources = new NativeRecursiveResources({ maxTrackedEntries: 3, maxConcurrentAudits: 2 });
  const second = createBackend(secondRoot, resources);
  let competing: Promise<unknown> | null = null;
  const events: string[] = [];
  const first = createBackend(firstRoot, resources, {
    queueEvent: (type, path) => {
      if (type === "create") {
        events.push(path);
        competing = second.start().then(
          () => null,
          (error: unknown) => error,
        );
      }
    },
  });
  try {
    await first.start();
    const added = join(firstRoot, "added");
    await writeFile(added, "added");
    await first.updateIgnore();
    expect(await competing).toMatchObject({
      name: "FileObservationCapacityError",
      scope: "shared",
    });
    expect(events).toEqual([added]);
    expect(first.getDiagnostics().nativeTrackedFileCount).toBe(2);
    expect(second.getDiagnostics().nativeTrackedFileCount).toBe(0);
  } finally {
    await Promise.all([first.close(), second.close()]);
    await rm(root, { recursive: true, force: true });
  }
});

test("closing during a reserved full diff rolls back growth before releasing the inventory", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-capacity-diff-close-"));
  const firstRoot = join(root, "first"),
    secondRoot = join(root, "second");
  await mkdir(firstRoot);
  await mkdir(secondRoot);
  await writeFile(join(firstRoot, "original"), "original");
  const resources = new NativeRecursiveResources({ maxTrackedEntries: 3, maxConcurrentAudits: 2 });
  const second = createBackend(secondRoot, resources);
  let closing: Promise<void> | null = null;
  const first = createBackend(firstRoot, resources, {
    queueEvent: () => {
      closing = first.close();
    },
  });
  try {
    await first.start();
    await writeFile(join(firstRoot, "added"), "added");
    await first.updateIgnore();
    await closing;
    expect(first.getDiagnostics()).toMatchObject({
      nativeTrackedFileCount: 0,
      nativeHandleCount: 0,
      pendingReconciliationWorkCount: 0,
    });
    await second.start();
    expect(second.getDiagnostics().nativeHandleCount).toBe(1);
    resources.createInventoryReservation("remaining-capacity").setEntryCount(2);
  } finally {
    await Promise.all([first.close(), second.close()]);
    await rm(root, { recursive: true, force: true });
  }
});
