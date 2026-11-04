import { createHash, randomUUID } from "node:crypto";
import { expect, test, vi } from "vitest";
import { CanonicalSidebarLayout } from "./canonical-sidebar-layout";
import {
  emptyWorkspaceNavigationPreferences,
  canonicalLayoutJson,
  type WorkspaceLayoutConfig,
  type WorkspaceLayoutSnapshot,
  type WorkspaceLayoutCommit,
} from "@getpaseo/protocol/workspace-layout";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";

const config: WorkspaceLayoutConfig = {
  role: "replica",
  authorityServerId: "hub",
  authorityId: "00000000-0000-4000-8000-000000000001",
  epoch: "00000000-0000-4000-8000-000000000002",
  authorityKeySha256: "a".repeat(64),
};
const hash = async (bytes: string) => createHash("sha256").update(bytes).digest("hex");
function baseline(): WorkspaceLayoutSnapshot {
  const { role: _role, authorityKeySha256: _key, ...identity } = config;
  return {
    stamp: { ...identity, revision: 2, phase: "active" },
    imports: [],
    clientImports: [],
    entries: [],
    navigation: {
      revision: 1,
      clientSources: [],
      resolutionSha256: "a".repeat(64),
      preferences: emptyWorkspaceNavigationPreferences(),
    },
  };
}
function fixture(initialBytes: string | null = null) {
  let bytes = initialBytes;
  const changes = vi.fn();
  const write = vi.fn(async (next: string) => {
    bytes = next;
  });
  const controller = new CanonicalSidebarLayout({
    read: async () => bytes,
    write,
    hash,
    requestId: randomUUID,
    changed: changes,
  });
  return { controller, changes, write, bytes: () => bytes };
}
function peer() {
  let snapshot = baseline();
  const receipts = new Map<
    string,
    Awaited<ReturnType<DaemonClient["getWorkspaceLayoutReceipt"]>>
  >();
  const commit = vi.fn(async (input: WorkspaceLayoutCommit) => {
    if (input.expected.revision !== snapshot.stamp.revision)
      throw Object.assign(new Error("stale"), { code: "stale_revision" });
    const mutation = input.mutations[0];
    if (mutation.kind !== "put-navigation") throw new Error("unexpected mutation");
    snapshot = {
      ...snapshot,
      stamp: { ...snapshot.stamp, revision: snapshot.stamp.revision + 1 },
      navigation: {
        ...snapshot.navigation!,
        revision: snapshot.navigation!.revision + 1,
        preferences: mutation.preferences,
      },
    };
    const receipt = {
      requestId: input.requestId,
      requestSha256: await hash(canonicalLayoutJson(input)),
      stamp: snapshot.stamp,
    };
    receipts.set(input.requestId, receipt);
    return { requestId: input.requestId, receipt };
  });
  const lookup = vi.fn(async (id: string) => receipts.get(id) ?? null);
  const read = vi.fn(async () => structuredClone(snapshot));
  const release = vi.fn(async () => {});
  const client = {
    getWorkspaceLayout: read,
    commitWorkspaceLayout: commit,
    getWorkspaceLayoutReceipt: lookup,
    observeWorkspaceLayout: (): ReturnType<DaemonClient["observeWorkspaceLayout"]> => ({
      ready: Promise.resolve({ ...snapshot, subscriptionId: "subscription" }),
      subscriptionId: "subscription",
      subscribe: () => () => {},
      release,
    }),
  };
  return { client, commit, lookup, read, release, snapshot: () => snapshot };
}

test("a fresh client reads shared order, journals its exact CAS before dispatch, and keeps replica data separate", async () => {
  const f = fixture();
  const p = peer();
  await f.controller.attach("replica", p.client, config);
  await vi.waitFor(() => expect(f.controller.state().writable).toBe(true));
  p.commit.mockImplementationOnce(async (input) => {
    expect(JSON.parse(f.bytes()!).pending.input).toEqual(input);
    expect(input.expected).toEqual(baseline().stamp);
    return {
      requestId: input.requestId,
      receipt: {
        requestId: input.requestId,
        requestSha256: await hash(canonicalLayoutJson(input)),
        stamp: { ...input.expected, revision: 3 },
      },
    };
  });
  await f.controller.update((current) => ({ ...current, projectOrder: ["view-b", "view-a"] }));
  expect(p.commit).toHaveBeenCalledTimes(1);
  expect(JSON.parse(f.bytes()!).pending).toBeNull();
});

test("offline replicas survive reload but cannot become independent writers", async () => {
  const f = fixture();
  const p = peer();
  const detach = await f.controller.attach("replica", p.client, config);
  await vi.waitFor(() => expect(f.controller.state().writable).toBe(true));
  detach();
  const second = fixture(f.bytes());
  await second.controller.ready;
  expect(second.controller.state()).toMatchObject({
    enabled: true,
    writable: false,
    snapshot: baseline(),
  });
  await expect(
    second.controller.update((current) => ({ ...current, projectOrder: ["offline"] })),
  ).rejects.toThrow("read-only");
  expect(p.commit).not.toHaveBeenCalled();
});

test("a lost ACK is checked by the original receipt after reload and never replayed", async () => {
  const f = fixture();
  const p = peer();
  await f.controller.attach("replica", p.client, config);
  await vi.waitFor(() => expect(f.controller.state().writable).toBe(true));
  const apply = p.commit.getMockImplementation()!;
  p.commit.mockImplementationOnce(async (input) => {
    await apply(input);
    throw new Error("lost ACK");
  });
  await expect(
    f.controller.update((current) => ({ ...current, projectOrder: ["shared"] })),
  ).rejects.toThrow("lost ACK");
  const pending = JSON.parse(f.bytes()!).pending;
  expect(f.controller.state()).toMatchObject({ pending: true, writable: false });
  const next = fixture(f.bytes());
  await next.controller.attach("other-replica", p.client, config);
  await next.controller.reconcile();
  expect(p.lookup).toHaveBeenCalledWith(pending.input.requestId);
  expect(p.commit).toHaveBeenCalledTimes(1);
  expect(next.controller.state()).toMatchObject({ pending: false, writable: true });
  expect(next.controller.state().snapshot?.navigation?.preferences.projectOrder).toEqual([
    "shared",
  ]);
});

test("no receipt, wrong receipt or mismatched authority cannot clear an uncertain intent", async () => {
  const f = fixture();
  const p = peer();
  await f.controller.attach("replica", p.client, config);
  await vi.waitFor(() => expect(f.controller.state().writable).toBe(true));
  p.commit.mockRejectedValueOnce(new Error("unknown dispatch"));
  await expect(
    f.controller.update((current) => ({ ...current, projectOrder: ["unknown"] })),
  ).rejects.toThrow();
  await expect(f.controller.reconcile()).rejects.toThrow("No durable receipt");
  p.lookup.mockResolvedValueOnce({
    requestId: "other",
    requestSha256: "f".repeat(64),
    stamp: { ...baseline().stamp, revision: 3 },
  });
  await expect(f.controller.reconcile()).rejects.toThrow("does not match");
  expect(f.controller.state().pending).toBe(true);
  await f.controller.attach("wrong", peer().client, {
    ...config,
    authorityKeySha256: "b".repeat(64),
  });
  expect(f.controller.state()).toMatchObject({ pending: true, writable: false });
  expect(p.commit).toHaveBeenCalledTimes(1);
});

test("storage or corrupt-cache failure never dispatches or silently selects local writes", async () => {
  const corrupt = fixture("{broken");
  await corrupt.controller.ready;
  expect(corrupt.controller.state()).toMatchObject({ enabled: true, writable: false });
  await expect(corrupt.controller.attach("replica", peer().client, config)).rejects.toThrow(
    "Recovery",
  );
  expect(corrupt.bytes()).toBe("{broken");
  const f = fixture();
  const p = peer();
  await f.controller.attach("replica", p.client, config);
  await vi.waitFor(() => expect(f.controller.state().writable).toBe(true));
  f.write.mockRejectedValueOnce(new Error("disk full"));
  await expect(
    f.controller.update((current) => ({ ...current, projectOrder: ["no-send"] })),
  ).rejects.toThrow("disk full");
  expect(p.commit).not.toHaveBeenCalled();
  expect(f.controller.state().writable).toBe(false);
});

test("a failed retirement of a definitely refused intent keeps edits closed", async () => {
  const f = fixture();
  const p = peer();
  await f.controller.attach("replica", p.client, config);
  await vi.waitFor(() => expect(f.controller.state().writable).toBe(true));
  p.commit.mockImplementationOnce(async () => {
    f.write.mockRejectedValueOnce(new Error("cannot retire"));
    throw Object.assign(new Error("stale"), { code: "stale_revision" });
  });
  await expect(
    f.controller.update((current) => ({ ...current, projectOrder: ["held"] })),
  ).rejects.toThrow("cannot retire");
  expect(f.controller.state()).toMatchObject({ pending: true, writable: false });
  await expect(f.controller.update((current) => current)).rejects.toThrow("Recovery");
  expect(p.commit).toHaveBeenCalledTimes(1);
});

test("a retired subscription cannot make the replacement connection read-only", async () => {
  const f = fixture();
  const old = peer();
  let failRetired: (error: unknown) => void = () => {
    throw new Error("observer not installed");
  };
  old.client.observeWorkspaceLayout = () => ({
    subscriptionId: "old",
    ready: Promise.resolve({ ...baseline(), subscriptionId: "old" }),
    subscribe: (observer: { error?: (error: unknown) => void }) => {
      failRetired = (error) => observer.error?.(error);
      return () => {};
    },
    release: async () => {},
  });
  const detach = await f.controller.attach("replica", old.client, config);
  await vi.waitFor(() => expect(f.controller.state().writable).toBe(true));
  detach();
  await f.controller.attach("replica", peer().client, config);
  await vi.waitFor(() => expect(f.controller.state().writable).toBe(true));
  failRetired(new Error("late old connection failure"));
  expect(f.controller.state().writable).toBe(true);
});
