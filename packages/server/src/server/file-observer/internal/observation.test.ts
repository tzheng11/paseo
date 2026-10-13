import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { createFileObserver, type FileChange, type FileObserverCallback } from "../index.js";
import type { ObservationHost } from "./contracts.js";
import { createManagedObservation } from "./observation.js";
import { createObserverPaths } from "./paths.js";
import { observationWork } from "./work-slice.js";

test("large coalesced delivery yields between bounded subscriber batches", async () => {
  const batches: FileChange[][] = [];
  let otherWorkRan = false;
  const { root, host, observation } = await harness((error, events) => {
    expect(error).toBeNull();
    if (batches.length) expect(otherWorkRan).toBe(true);
    batches.push(events);
    setImmediate(() => {
      otherWorkRan = true;
    });
  });
  try {
    await observation.start();
    for (let i = 0; i < 600; i++) {
      const path = join(root, `file-${i}`);
      host.queueEvent("create", path);
      host.queueEvent("update", path);
      host.queueEvent("delete", path);
    }
    await expect.poll(() => batches.flat().length).toBe(600);
    expect(Math.max(...batches.map((batch) => batch.length))).toBeLessThanOrEqual(256);
    expect(new Set(batches.flat().map((event) => event.path)).size).toBe(600);
    expect(batches.flat().every((event) => event.type === "update")).toBe(true);
  } finally {
    await observation.close();
    await rm(root, { recursive: true, force: true });
  }
});

async function harness(callback: FileObserverCallback, onIgnore: () => void = () => {}) {
  const root = await mkdtemp(join(tmpdir(), "observation-delivery-"));
  let host!: ObservationHost;
  const observation = createManagedObservation({
    root,
    options: {},
    paths: createObserverPaths(process.platform),
    metrics: createFileObserver().getDiagnostics(),
    createBackend: (input) => {
      host = input;
      return {
        start: async () => {},
        updateIgnore: async () => {
          onIgnore();
        },
        close: async () => {},
        getDiagnostics: () => ({
          nativeHandleCount: 0,
          nativeTrackedFileCount: 0,
          pendingReconciliationWorkCount: 0,
          pendingClassificationCount: 0,
          reconciliationInFlight: false,
        }),
      };
    },
    callback: (error, events) => callback(error, events),
    onClosed: () => {},
  });
  return { root, host, observation };
}

test("ignore cancels the backend generation before yielding to prune a large delivery queue", async () => {
  let cancelled = false;
  const { root, host, observation } = await harness(
    () => {},
    () => {
      cancelled = true;
    },
  );
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let updating: Promise<void> | undefined;
  try {
    await observation.start();
    for (let i = 0; i < 600; i++) host.queueEvent("create", join(root, "generated", `file-${i}`));
    vi.spyOn(observationWork, "pause").mockReturnValueOnce(gate);
    updating = observation.subscription().updateIgnore([join(root, "generated")]);
    expect(cancelled).toBe(true);
    release();
    await updating;
    expect(observation.getDiagnostics().pendingEventCount).toBe(0);
  } finally {
    release();
    await updating;
    vi.restoreAllMocks();
    await observation.close();
    await rm(root, { recursive: true, force: true });
  }
});

test.each(["close", "ignore"] as const)(
  "%s during sliced delivery suppresses the remaining excluded events",
  async (barrier) => {
    const batches: FileChange[][] = [];
    let finished: Promise<void> | undefined;
    const { root, host, observation } = await harness((error, events) => {
      expect(error).toBeNull();
      batches.push(events);
      if (batches.length === 1) {
        finished =
          barrier === "close"
            ? observation.subscription().unsubscribe()
            : observation.subscription().updateIgnore([join(root, "generated")]);
      }
    });
    try {
      await observation.start();
      for (let i = 0; i < 1_000; i++)
        host.queueEvent("create", join(root, "generated", `file-${i}`));
      await expect.poll(() => Boolean(finished)).toBe(true);
      await finished;
      expect(batches).toHaveLength(1);
      expect(batches[0]).toHaveLength(256);
      expect(observation.getDiagnostics().pendingEventCount).toBe(0);
      host.queueEvent("update", join(root, "generated", "late"));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(batches).toHaveLength(1);
    } finally {
      await observation.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("a callback's microtask event is not stranded when a delivery finishes", async () => {
  const events: FileChange[] = [];
  const { root, host, observation } = await harness((error, batch) => {
    expect(error).toBeNull();
    events.push(...batch);
    if (events.length === 1) queueMicrotask(() => host.queueEvent("create", join(root, "late")));
  });
  try {
    await observation.start();
    host.queueEvent("create", join(root, "first"));
    await expect
      .poll(() => events.map((event) => event.path))
      .toEqual([join(root, "first"), join(root, "late")]);
  } finally {
    await observation.close();
    await rm(root, { recursive: true, force: true });
  }
});
