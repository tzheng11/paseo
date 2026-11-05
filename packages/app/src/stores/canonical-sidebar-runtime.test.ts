import { createHash } from "node:crypto";
import { beforeEach, expect, test, vi } from "vitest";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import {
  canonicalLayoutJson,
  emptyWorkspaceNavigationPreferences,
  type WorkspaceLayoutCommit,
  type WorkspaceLayoutSnapshot,
} from "@getpaseo/protocol/workspace-layout";

vi.mock("expo-crypto", () => ({
  CryptoDigestAlgorithm: { SHA256: "SHA256" },
  digestStringAsync: async (_algorithm: string, bytes: string) =>
    createHash("sha256").update(bytes).digest("hex"),
}));
beforeEach(() => vi.resetModules());

test("actual sidebar setters forward edits, project observations, and preserve both original legacy keys", async () => {
  const { default: storage } = await import("@react-native-async-storage/async-storage");
  const oldOrders = JSON.stringify({
    version: 3,
    state: { projectOrder: ["legacy"], workspaceOrderByProject: {} },
  });
  const oldView = JSON.stringify({
    version: 8,
    state: { workspaceSort: "created", hostFilters: ["host-a"], groupMode: "project" },
  });
  await storage.setItem("sidebar-project-workspace-order", oldOrders);
  await storage.setItem("sidebar-view", oldView);
  const runtime = await import("./canonical-sidebar-runtime");
  await runtime.canonicalSidebar.ready;
  const { useSidebarOrderStore: orders } = await import("./sidebar-order-store");
  const { useSidebarViewStore: view } = await import("./sidebar-view-store");
  const { useSessionStore: sessions, toDaemonServerInfo } = await import("./session-store");
  await orders.persist.rehydrate();
  await view.persist.rehydrate();
  const config = {
    role: "replica" as const,
    authorityServerId: "hub",
    authorityKeySha256: "a".repeat(64),
    authorityId: "00000000-0000-4000-8000-000000000001",
    epoch: "00000000-0000-4000-8000-000000000002",
  };
  let snapshot: WorkspaceLayoutSnapshot = {
    stamp: {
      authorityServerId: config.authorityServerId,
      authorityId: config.authorityId,
      epoch: config.epoch,
      revision: 5,
      phase: "active",
    },
    imports: [],
    clientImports: [],
    entries: [],
    navigation: {
      revision: 1,
      preferences: {
        ...emptyWorkspaceNavigationPreferences(),
        projectOrder: ["shared"],
        workspaceSort: "manual",
      },
      clientSources: [],
      resolutionSha256: "b".repeat(64),
    },
  };
  const commit = vi.fn(async (input: WorkspaceLayoutCommit) => {
    const mutation = input.mutations[0];
    if (mutation.kind !== "put-navigation") throw new Error("Unexpected mutation");
    snapshot = {
      ...snapshot,
      stamp: { ...snapshot.stamp, revision: snapshot.stamp.revision + 1 },
      navigation: {
        ...snapshot.navigation!,
        revision: snapshot.navigation!.revision + 1,
        preferences: mutation.preferences,
      },
    };
    return {
      requestId: input.requestId,
      receipt: {
        requestId: input.requestId,
        requestSha256: createHash("sha256").update(canonicalLayoutJson(input)).digest("hex"),
        stamp: snapshot.stamp,
      },
    };
  });
  const client = {
    getWorkspaceLayout: async () => snapshot,
    commitWorkspaceLayout: commit,
    getWorkspaceLayoutReceipt: async () => null,
    observeWorkspaceLayout: () => ({
      subscriptionId: "layout",
      ready: Promise.resolve({ ...snapshot, subscriptionId: "layout" }),
      subscribe: () => () => {},
      release: async () => {},
    }),
  };
  // The connection and SessionProvider both consume this stored handshake;
  // bypassing it with the raw config hid a dropped-field activation defect.
  sessions.getState().initializeSession("host-a", null as unknown as DaemonClient);
  sessions.getState().updateSessionServerInfo(
    "host-a",
    toDaemonServerInfo({
      status: "server_info",
      serverId: "host-a",
      hostname: null,
      version: "0.15.0-impower",
      workspaceLayout: { ...config, stamp: snapshot.stamp, synchronized: true },
    }),
  );
  const advertised = sessions.getState().sessions["host-a"].serverInfo?.workspaceLayout;
  expect(advertised).toBeDefined();
  const detach = await runtime.canonicalSidebar.attach("host-a", client, advertised!);
  await vi.waitFor(() => expect(runtime.canonicalSidebar.state().writable).toBe(true));
  expect(orders.getState().projectOrder).toEqual(["shared"]);
  expect(view.getState().workspaceSort).toBe("manual");
  orders.getState().setProjectOrder(["shared", "new-view"]);
  await vi.waitFor(() =>
    expect(snapshot.navigation!.preferences.projectOrder).toEqual(["shared", "new-view"]),
  );
  await vi.waitFor(() => expect(runtime.canonicalSidebar.state().writable).toBe(true));
  view.getState().setWorkspaceSort("lastPrompt");
  await vi.waitFor(() => expect(snapshot.navigation!.preferences.workspaceSort).toBe("lastPrompt"));
  await vi.waitFor(() => expect(view.getState().workspaceSort).toBe("lastPrompt"));
  for (const [setOrder, expected] of [
    [
      () => orders.getState().setPinnedWorkspaceSortMode("alphabetical"),
      () => snapshot.navigation!.preferences.pinnedWorkspaceSortMode === "alphabetical",
    ],
    [
      () => orders.getState().setWorkspaceSortMode("shared", "activity"),
      () => snapshot.navigation!.preferences.workspaceSortModeByProject.shared === "activity",
    ],
    [
      () => orders.getState().setWorkspaceOrder("shared", ["host-a:workspace"]),
      () =>
        snapshot.navigation!.preferences.workspaceOrderByProject.shared?.[0] === "host-a:workspace",
    ],
    [
      () => orders.getState().setPinnedWorkspaceOrder(["host-a:workspace"]),
      () => snapshot.navigation!.preferences.pinnedWorkspaceOrder[0] === "host-a:workspace",
    ],
    [
      () => orders.getState().setSuperpinnedWorkspaceOrder(["host-a:workspace"]),
      () => snapshot.navigation!.preferences.superpinnedWorkspaceOrder[0] === "host-a:workspace",
    ],
  ] as const) {
    await vi.waitFor(() => expect(runtime.canonicalSidebar.state().writable).toBe(true));
    setOrder();
    await vi.waitFor(() => expect(expected()).toBe(true));
  }
  expect(await storage.getItem("sidebar-project-workspace-order")).toBe(oldOrders);
  expect(await storage.getItem("sidebar-view")).toBe(oldView);
  view.getState().toggleHostFilter("host-b");
  await vi.waitFor(async () =>
    expect(await storage.getItem("sidebar-view-local-replica-v1:sidebar-view")).not.toBeNull(),
  );
  expect(await storage.getItem("sidebar-view")).toBe(oldView);
  detach();
  const count = commit.mock.calls.length;
  orders.getState().setProjectOrder(["must-not-be-local"]);
  await vi.waitFor(() => expect(runtime.canonicalSidebarState.getState().actionError).toBeTruthy());
  expect(commit).toHaveBeenCalledTimes(count);
  expect(orders.getState().projectOrder).toEqual(["shared", "new-view"]);
  await orders.persist.rehydrate();
  await view.persist.rehydrate();
  expect(orders.getState().projectOrder).toEqual(["shared", "new-view"]);
  expect(view.getState().workspaceSort).toBe("lastPrompt");
  expect(await storage.getItem("sidebar-project-workspace-order")).toBe(oldOrders);
  expect(await storage.getItem("sidebar-view")).toBe(oldView);
  sessions.getState().clearSession("host-a");
});
