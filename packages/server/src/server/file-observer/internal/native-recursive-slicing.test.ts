import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { createFileObserver, type FileChange } from "../index.js";
import { createNativeRecursiveBackend } from "./native-recursive.js";
import { createObserverPaths } from "./paths.js";
import { observationWork } from "./work-slice.js";

test("close in a diff slice drains the audit without later events or indexed files", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-diff-cancel-"));
  const paths = createObserverPaths(process.platform);
  const events: FileChange[] = [];
  let closing: Promise<void> | undefined;
  let armed = false;
  const backend = createNativeRecursiveBackend(
    {
      root,
      metrics: createFileObserver().getDiagnostics(),
      isActive: () => true,
      isIgnored: () => false,
      isPathInside: paths.isInside,
      queueEvent: (type, path) => {
        events.push({ type, path });
        if (!armed) return;
        armed = false;
        vi.spyOn(observationWork, "pause").mockImplementationOnce(
          () =>
            new Promise<void>((resolve) => {
              setImmediate(() => {
                closing = backend.close();
                resolve();
              });
            }),
        );
      },
      fail: (error) => {
        throw error;
      },
    },
    paths,
    () => ({ close: () => {}, on: () => {} }),
  );
  try {
    await backend.start();
    await Promise.all(
      Array.from({ length: 700 }, (_, i) => writeFile(join(root, `new-${i}`), "new")),
    );
    armed = true;
    await backend.updateIgnore();
    expect(closing).toBeInstanceOf(Promise);
    await closing;
    expect(events).toHaveLength(1);
    expect(backend.getDiagnostics()).toMatchObject({
      nativeHandleCount: 0,
      nativeTrackedFileCount: 0,
      reconciliationInFlight: false,
    });
  } finally {
    vi.restoreAllMocks();
    await backend.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("an ignore generation supersedes a scan at its yield and leaves a complete replacement inventory", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-scan-ignore-"));
  const generated = join(root, "generated");
  await mkdir(generated);
  await Promise.all(
    Array.from({ length: 700 }, (_, i) => writeFile(join(generated, `file-${i}`), "old")),
  );
  await writeFile(join(root, "kept"), "keep");
  const paths = createObserverPaths(process.platform);
  let ignored = false;
  let replacement: Promise<void> | undefined;
  let armed = false;
  const events: FileChange[] = [];
  const metrics = createFileObserver().getDiagnostics();
  const backend = createNativeRecursiveBackend(
    {
      root,
      metrics,
      isActive: () => true,
      isIgnored: (path) => ignored && paths.isInside(generated, path),
      isPathInside: paths.isInside,
      onInventoryProgress: () => {
        if (!armed) return;
        armed = false;
        vi.spyOn(observationWork, "pause").mockImplementationOnce(
          () =>
            new Promise<void>((resolve) => {
              setImmediate(() => {
                ignored = true;
                replacement = backend.updateIgnore();
                resolve();
              });
            }),
        );
      },
      queueEvent: (type, path) => events.push({ type, path }),
      fail: (error) => {
        throw error;
      },
    },
    paths,
    () => ({ close: () => {}, on: () => {} }),
  );
  try {
    await backend.start();
    expect(backend.getDiagnostics().nativeTrackedFileCount).toBe(701);
    armed = true;
    await backend.updateIgnore();
    expect(replacement).toBeInstanceOf(Promise);
    await replacement;
    expect(backend.getDiagnostics().nativeTrackedFileCount).toBe(1);
    expect(metrics.reconciliationFailureCount).toBe(0);
    // The superseded scan cannot emit new files after its generation changed.
    expect(events.filter((event) => event.type === "create")).toEqual([]);
  } finally {
    vi.restoreAllMocks();
    await backend.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a directory classified during an audit still acquires split native coverage", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-split-during-audit-"));
  const ignored = join(root, "ignored");
  const created = join(root, "created");
  const paths = createObserverPaths(process.platform);
  const watched = new Set<string>();
  let notifyRoot!: (event: string, filename: string | null) => void;
  let armed = false;
  let paused = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const metrics = createFileObserver().getDiagnostics();
  const backend = createNativeRecursiveBackend(
    {
      root,
      metrics,
      ignoredRoots: [ignored],
      isActive: () => true,
      isIgnored: (path) => paths.isInside(ignored, path),
      isPathInside: paths.isInside,
      onInventoryProgress: () => {
        if (!armed) return;
        armed = false;
        vi.spyOn(observationWork, "pause").mockImplementationOnce(() => {
          paused = true;
          return gate;
        });
      },
      queueEvent: () => {},
      fail: (error) => {
        throw error;
      },
    },
    paths,
    (directory, listener) => {
      watched.add(directory);
      if (directory === root) notifyRoot = listener;
      return {
        close: () => {
          watched.delete(directory);
        },
        on: () => {},
      };
    },
  );
  let audit: Promise<void> | undefined;
  try {
    await backend.start();
    armed = true;
    audit = backend.updateIgnore();
    await expect.poll(() => paused).toBe(true);
    await mkdir(created);
    await writeFile(join(created, "tracked"), "new");
    notifyRoot("rename", "created");
    await expect.poll(() => metrics.nativeClassificationCount).toBe(1);
    await expect.poll(() => backend.getDiagnostics().pendingClassificationCount).toBe(0);
    release();
    await audit;
    await expect.poll(() => watched.has(created), { timeout: 2_000 }).toBe(true);
    expect(backend.getDiagnostics().nativeTrackedFileCount).toBe(1);
  } finally {
    release();
    await audit;
    vi.restoreAllMocks();
    await backend.close();
    await rm(root, { recursive: true, force: true });
  }
});
