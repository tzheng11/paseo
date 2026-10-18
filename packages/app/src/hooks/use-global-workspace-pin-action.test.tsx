// @vitest-environment jsdom
import { createElement, isValidElement, type PropsWithChildren } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import type { ToastApi } from "@/components/toast-host";
import {
  useSidebarWorkspacePinController,
  useSidebarWorkspaceSuperpinController,
  useWorkspacePinPending,
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
