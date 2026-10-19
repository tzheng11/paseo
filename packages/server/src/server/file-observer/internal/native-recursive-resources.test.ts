import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
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
      queueEvent: () => {},
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
  let started = 0;
  let active = 0;
  let peak = 0;
  const backends = roots.map((directory) =>
    createBackend(directory, resources, {
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
    await backends[2]!.close();
    await starting[2];
    expect(started).toBe(2);
    const fourth = backends[3]!.start();
    expect(started).toBe(2);
    release();
    await Promise.all([...starting, fourth]);
    expect(started).toBe(3);
    expect(peak).toBe(2);
    expect(backends[2]!.getDiagnostics()).toMatchObject({
      nativeHandleCount: 0,
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
