// @vitest-environment jsdom
import { createElement, isValidElement, type PropsWithChildren } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { applyWorkspaceTreeMove } from "@/components/sidebar/workspace-tree/pin-placement";
import type { ToastApi } from "@/components/toast-host";
import {
  useSidebarWorkspacePinController,
  useSidebarWorkspaceSuperpinController,
  useWorkspacePinPending,
  runWorkspacePinChange,
  runWorkspacePinChanges,
  markWorkspacePinOutcomeUnknown,
  confirmWorkspacePinChange,
} from "./use-sidebar-workspace-pin";
import { DaemonClient, DaemonConnectionError } from "@getpaseo/client/internal/daemon-client";
import type { useKeyboardActionHandler } from "./use-keyboard-action-handler";
import { useSessionStore, normalizeWorkspaceDescriptor } from "@/stores/session-store";
import { useGlobalWorkspacePinAction } from "./use-global-workspace-pin-action";

const mocks = vi.hoisted(() => {
  const pin = vi.fn<(id: string, pinned: boolean) => Promise<void>>();
  const superpin = vi.fn<(id: string, value: boolean) => Promise<void>>();
  const client = {
    setWorkspacePinned: pin,
    setWorkspaceSuperpinned: superpin,
    getLastServerInfoMessage: () => ({ features: { workspaceSuperpinning: true } }),
  };
  return {
    register: vi.fn<(input: Parameters<typeof useKeyboardActionHandler>[0]) => void>(),
    pin,
    superpin,
    client,
    error: vi.fn(),
    show: vi.fn<ToastApi["show"]>(),
    refresh: vi.fn<() => Promise<void>>(),
  };
});
vi.mock("@/components/ui/button", () => ({ Button: "button" }));
vi.mock("@/runtime/directory-sync", () => ({
  DirectoryRefreshSupersededError: class DirectoryRefreshSupersededError extends Error {},
}));
vi.mock("./use-keyboard-action-handler", () => ({ useKeyboardActionHandler: mocks.register }));
vi.mock("@/stores/navigation-active-workspace-store", () => ({
  useActiveWorkspaceSelection: () => ({ serverId: "pin-unit", workspaceId: "w1" }),
}));
vi.mock("@/runtime/host-features", () => ({ useHostFeature: () => true }));
vi.mock("@/contexts/toast-context", () => ({
  useToast: () => ({ error: mocks.error, show: mocks.show }),
}));
vi.mock("@/runtime/host-runtime", () => ({
  getHostRuntimeStore: () => ({
    getClient: () => mocks.client,
    getSnapshot: () => ({ connectionStatus: "online", client: mocks.client, connectionEpoch: 1 }),
    refreshWorkspaceDirectory: mocks.refresh,
  }),
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

afterEach(() => {
  useSessionStore.getState().clearSession("pin-unit");
  vi.clearAllMocks();
});

it("3fdb71dd-7bc7-816a-bca8-cefc13498226@2467ee223467#global-pin-shortcut unpins both confirmed states with no Superpin action", async () => {
  const client = new DaemonClient({
    url: "ws://unit.invalid",
    clientId: "pin-unit",
    reconnect: { enabled: false },
  });
  useSessionStore.getState().initializeSession("pin-unit", client);
  const workspace = normalizeWorkspaceDescriptor({
    id: "w1",
    projectId: "p1",
    projectDisplayName: "Project",
    projectRootPath: "/repo",
    workspaceDirectory: "/repo",
    projectKind: "git",
    workspaceKind: "checkout",
    name: "Workspace",
    status: "done",
    statusEnteredAt: null,
    activityAt: null,
    archivingAt: null,
    diffStat: null,
    scripts: [],
    pinnedAt: "2026-10-18T21:00:00Z",
    superpinnedAt: "2026-10-18T22:00:00Z",
  });
  useSessionStore.getState().setWorkspaces("pin-unit", new Map([[workspace.id, workspace]]));
  mocks.pin.mockImplementation(async (id, pinned) => {
    expect(pinned).toBe(false);
    useSessionStore
      .getState()
      .setWorkspaces(
        "pin-unit",
        new Map([[id, { ...workspace, pinnedAt: null, superpinnedAt: null }]]),
      );
  });
  const queryClient = new QueryClient();
  function wrapper({ children }: PropsWithChildren) {
    return createElement(QueryClientProvider, { client: queryClient }, children);
  }
  renderHook(() => useGlobalWorkspacePinAction(), { wrapper });
  const registration = mocks.register.mock.calls.at(-1)![0];
  expect(registration.actions).toEqual(["workspace.pin"]);
  act(() => {
    registration.handle({ id: "workspace.pin", scope: "sidebar" });
  });
  await waitFor(() => expect(mocks.pin).toHaveBeenCalledExactlyOnceWith("w1", false));
  expect(mocks.superpin).not.toHaveBeenCalled();
  expect(useSessionStore.getState().sessions["pin-unit"]?.workspaces.get("w1")).toMatchObject({
    pinnedAt: null,
    superpinnedAt: null,
  });
  expect(mocks.error).not.toHaveBeenCalled();
  await client.close();
});

it("3fdb71dd-7bc7-8140-810e-e7cd4f4539b5@999c2120aca7#timeout keeps the shared mutation guard after a failed read and checks state without resending", async () => {
  const queryClient = new QueryClient();
  function wrapper({ children }: PropsWithChildren) {
    return createElement(QueryClientProvider, { client: queryClient }, children);
  }
  const workspace = {
    serverId: "pin-unit",
    workspaceId: "unknown-w",
    workspaceKey: "pin-unit:unknown-w",
    pinnedAt: null,
    superpinnedAt: null,
  };
  mocks.superpin.mockRejectedValueOnce(
    new DaemonConnectionError("lost reply", "DAEMON_REQUEST_TIMEOUT"),
  );
  mocks.refresh.mockRejectedValueOnce(new Error("read refused"));
  const hook = renderHook(
    () => ({
      superpin: useSidebarWorkspaceSuperpinController(),
      pin: useSidebarWorkspacePinController(),
      pending: useWorkspacePinPending(workspace.workspaceKey),
    }),
    { wrapper },
  );
  act(() => hook.result.current.superpin(workspace));
  await waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(mocks.show.mock.calls.at(-1)?.[0]).not.toBeTypeOf("string"));
  expect(hook.result.current.pending).toBe(true);
  act(() => {
    hook.result.current.pin(workspace);
    hook.result.current.superpin(workspace);
  });
  expect(mocks.superpin).toHaveBeenCalledTimes(1);
  expect(mocks.pin).not.toHaveBeenCalled();
  expect(mocks.error).not.toHaveBeenCalled();
  const content = mocks.show.mock.calls.at(-1)![0];
  if (!isValidElement<{ onPress(): void }>(content))
    throw new Error("Expected a rendered read-only recovery action");
  mocks.refresh.mockResolvedValueOnce(undefined);
  await act(async () => {
    content.props.onPress();
  });
  await waitFor(() => expect(hook.result.current.pending).toBe(false));
  expect(mocks.refresh).toHaveBeenCalledTimes(2);
  expect(mocks.superpin).toHaveBeenCalledTimes(1);
  expect(useSessionStore.getState().sessions["pin-unit"]).toBeUndefined();
});

it("tree retries only read after an unknown pin ACK and failed confirmation", async () => {
  const workspace = {
    serverId: "pin-unit",
    workspaceId: "tree-unknown",
    workspaceKey: "pin-unit:tree-unknown",
  };
  mocks.pin.mockReset().mockRejectedValueOnce(new DaemonConnectionError("lost ACK"));
  mocks.refresh
    .mockReset()
    .mockRejectedValueOnce(new Error("read failed"))
    .mockRejectedValueOnce(new Error("read failed again"));
  let confirmedPinned = false;
  const attempt = () =>
    runWorkspacePinChange(workspace, async () =>
      applyWorkspaceTreeMove({
        client: {
          moveWorkspace: vi.fn(),
          setWorkspacePinned: vi.fn().mockImplementation(mocks.pin),
          setWorkspaceSuperpinned: vi.fn(),
        },
        workspaceId: workspace.workspaceId,
        drop: {
          workspaceKey: workspace.workspaceKey,
          targetWorkspaceKey: "other:parent",
          position: "inside",
          parentWorkspaceId: null,
          beforeWorkspaceId: null,
          pinnedOrderOnly: true,
          pinSection: "pinned",
        },
        pinned: confirmedPinned,
        superpinned: false,
        shouldPin: true,
        shouldSuperpin: false,
        confirmPinState: async () => {
          markWorkspacePinOutcomeUnknown(workspace.workspaceKey);
          await confirmWorkspacePinChange(workspace);
          return { pinned: confirmedPinned, superpinned: false };
        },
      }),
    );
  await expect(attempt()).rejects.toThrow("read failed");
  await expect(attempt()).rejects.toThrow("read failed again");
  expect(mocks.pin).toHaveBeenCalledTimes(1);
  mocks.refresh.mockImplementationOnce(async () => {
    confirmedPinned = true;
  });
  await attempt();
  expect(mocks.refresh).toHaveBeenCalledTimes(3);
  expect(mocks.pin).toHaveBeenCalledTimes(1);
});

it("tree admission blocks menu and shortcut pin mutations until it settles", async () => {
  const queryClient = new QueryClient();
  function wrapper({ children }: PropsWithChildren) {
    return createElement(QueryClientProvider, { client: queryClient }, children);
  }
  const workspace = {
    serverId: "pin-unit",
    workspaceId: "tree-pending",
    workspaceKey: "pin-unit:tree-pending",
    pinnedAt: "now",
    superpinnedAt: null,
  };
  const hook = renderHook(
    () => ({
      pin: useSidebarWorkspacePinController(),
      superpin: useSidebarWorkspaceSuperpinController(),
      pending: useWorkspacePinPending(workspace.workspaceKey),
    }),
    { wrapper },
  );
  let finish!: () => void;
  const held = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let running!: Promise<void>;
  act(() => {
    running = runWorkspacePinChange(workspace, () => held);
  });
  await waitFor(() => expect(hook.result.current.pending).toBe(true));
  act(() => {
    hook.result.current.pin(workspace);
    hook.result.current.superpin(workspace);
  });
  expect(mocks.pin).not.toHaveBeenCalled();
  expect(mocks.superpin).not.toHaveBeenCalled();
  await act(async () => {
    finish();
    await running;
  });
  await waitFor(() => expect(hook.result.current.pending).toBe(false));
});

it("batch admission rejects an overlap without reserving earlier unrelated members", async () => {
  const parent = { serverId: "batch-host", workspaceKey: "batch-host:parent-overlap" };
  const child = { serverId: "batch-host", workspaceKey: "batch-host:child-overlap" };
  let finish!: () => void;
  const held = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const running = runWorkspacePinChange(child, () => held);
  const rejectedAction = vi.fn(async () => undefined);
  await expect(runWorkspacePinChanges([parent, child], rejectedAction)).rejects.toThrow(
    "still pending",
  );
  expect(rejectedAction).not.toHaveBeenCalled();
  const unrelatedAction = vi.fn(async () => "accepted");
  await expect(runWorkspacePinChange(parent, unrelatedAction)).resolves.toBe("accepted");
  expect(unrelatedAction).toHaveBeenCalledTimes(1);
  finish();
  await running;
});

it("batch admission blocks pin menus for every descendant until the whole group settles", async () => {
  mocks.pin.mockReset();
  mocks.superpin.mockReset();
  const queryClient = new QueryClient();
  function wrapper({ children }: PropsWithChildren) {
    return createElement(QueryClientProvider, { client: queryClient }, children);
  }
  const parent = {
    serverId: "batch-one",
    workspaceId: "parent",
    workspaceKey: "batch-one:parent",
    pinnedAt: "now",
    superpinnedAt: null,
  };
  const child = {
    ...parent,
    serverId: "batch-two",
    workspaceId: "child",
    workspaceKey: "batch-two:child",
  };
  const hook = renderHook(
    () => ({
      pin: useSidebarWorkspacePinController(),
      superpin: useSidebarWorkspaceSuperpinController(),
      parentPending: useWorkspacePinPending(parent.workspaceKey),
      childPending: useWorkspacePinPending(child.workspaceKey),
    }),
    { wrapper },
  );
  let finish!: () => void;
  const held = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let running!: Promise<void>;
  act(() => {
    running = runWorkspacePinChanges([parent, child], () => held);
  });
  expect(hook.result.current.parentPending).toBe(true);
  expect(hook.result.current.childPending).toBe(true);
  act(() => {
    hook.result.current.pin(parent);
    hook.result.current.pin(child);
    hook.result.current.superpin(child);
  });
  expect(mocks.pin).not.toHaveBeenCalled();
  expect(mocks.superpin).not.toHaveBeenCalled();
  await expect(runWorkspacePinChange(child, async () => undefined)).rejects.toThrow(
    "still pending",
  );
  await act(async () => {
    finish();
    await running;
  });
  expect(hook.result.current.parentPending).toBe(false);
  expect(hook.result.current.childPending).toBe(false);
});

it("reserves every unknown group member before the first read and deduplicates identities", async () => {
  const first = { serverId: "unknown-one", workspaceKey: "unknown-one:reserved" };
  const second = { serverId: "unknown-two", workspaceKey: "unknown-two:reserved" };
  markWorkspacePinOutcomeUnknown(first.workspaceKey);
  markWorkspacePinOutcomeUnknown(second.workspaceKey);
  let finishRead!: () => void;
  const read = new Promise<void>((resolve) => {
    finishRead = resolve;
  });
  mocks.refresh.mockReset().mockReturnValueOnce(read).mockResolvedValueOnce(undefined);
  const action = vi.fn(async () => "confirmed");
  const running = runWorkspacePinChanges([first, first, second], action);
  expect(mocks.refresh).toHaveBeenCalledTimes(1);
  await expect(runWorkspacePinChange(second, async () => undefined)).rejects.toThrow(
    "still pending",
  );
  expect(action).not.toHaveBeenCalled();
  finishRead();
  await expect(running).resolves.toBe("confirmed");
  expect(mocks.refresh).toHaveBeenCalledTimes(2);
  expect(action).toHaveBeenCalledTimes(1);
  await expect(runWorkspacePinChanges([first, second], async () => "released")).resolves.toBe(
    "released",
  );
});

it("failed group confirmation releases known members and keeps only unknown outcomes guarded", async () => {
  const known = { serverId: "known-host", workspaceKey: "known-host:read-failure" };
  const unknown = { serverId: "unknown-host", workspaceKey: "unknown-host:read-failure" };
  const hook = renderHook(() => ({
    knownPending: useWorkspacePinPending(known.workspaceKey),
    unknownPending: useWorkspacePinPending(unknown.workspaceKey),
  }));
  act(() => markWorkspacePinOutcomeUnknown(unknown.workspaceKey));
  mocks.refresh.mockReset().mockRejectedValueOnce(new Error("group confirmation failed"));
  const action = vi.fn(async () => undefined);
  await act(async () => {
    await expect(runWorkspacePinChanges([known, unknown], action)).rejects.toThrow(
      "group confirmation failed",
    );
  });
  expect(action).not.toHaveBeenCalled();
  expect(hook.result.current.knownPending).toBe(false);
  expect(hook.result.current.unknownPending).toBe(true);
  await expect(runWorkspacePinChange(known, async () => "available")).resolves.toBe("available");
  mocks.refresh.mockResolvedValueOnce(undefined);
  await act(async () => {
    await runWorkspacePinChange(unknown, async () => undefined);
  });
  expect(hook.result.current.unknownPending).toBe(false);
  expect(mocks.refresh).toHaveBeenCalledTimes(2);
});

it("releases every group reservation when the mutation action rejects", async () => {
  const workspaces = [
    { serverId: "release-one", workspaceKey: "release-one:action-failure" },
    { serverId: "release-two", workspaceKey: "release-two:action-failure" },
  ];
  await expect(
    runWorkspacePinChanges(workspaces, async () => {
      throw new Error("membership rejected");
    }),
  ).rejects.toThrow("membership rejected");
  const action = vi.fn(async () => undefined);
  await runWorkspacePinChanges(workspaces, action);
  expect(action).toHaveBeenCalledTimes(1);
});
