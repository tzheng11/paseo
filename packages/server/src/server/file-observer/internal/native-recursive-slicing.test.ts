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
