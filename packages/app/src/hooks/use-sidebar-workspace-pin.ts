import { createElement, useCallback, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { useMutation } from "@tanstack/react-query";
import { DaemonConnectionError } from "@getpaseo/client/internal/daemon-client";
import { Button } from "@/components/ui/button";
import { DirectoryRefreshSupersededError } from "@/runtime/directory-sync";
import { useToast } from "@/contexts/toast-context";
import type { SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";

export type PinnableWorkspace = Pick<
  SidebarWorkspaceEntry,
  "serverId" | "workspaceId" | "workspaceKey" | "pinnedAt" | "superpinnedAt"
>;
export type ToggleSidebarWorkspacePin = (workspace: PinnableWorkspace) => void;

// Shared by menus, command center and shortcut, including separately mounted controllers.
const pendingWorkspaceKeys = new Set<string>();
const activeWorkspaceKeys = new Set<string>();
const unknownWorkspaceKeys = new Set<string>();
const reconcilingWorkspaceKeys = new Set<string>();
const pendingListeners = new Set<() => void>();
function notifyPending() {
  for (const listener of pendingListeners) listener();
}
function subscribePending(listener: () => void) {
  pendingListeners.add(listener);
  return () => {
    pendingListeners.delete(listener);
  };
}
export function useWorkspacePinPending(workspaceKey: string): boolean {
  return useSyncExternalStore(
    subscribePending,
    () => pendingWorkspaceKeys.has(workspaceKey),
    () => false,
  );
}

function waitForHostChange(serverId: string): Promise<void> {
  return new Promise((resolve) => {
    const unsubscribe = getHostRuntimeStore().subscribe(serverId, () => {
      unsubscribe();
      resolve();
    });
  });
}

// A lost reply may have committed a new priority time. Read through the existing directory owner;
// never repeat the mutation. That owner's refresh is a no-op offline, so verify its connection epoch.
export async function reconcileWorkspacePin(serverId: string): Promise<void> {
  const runtime = getHostRuntimeStore();
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = runtime.getSnapshot(serverId);
    const ready =
      before?.connectionStatus === "online" && before.client?.getLastServerInfoMessage();
    if (!ready) {
      await waitForHostChange(serverId);
      attempt--;
      continue;
    }
    try {
      await runtime.refreshWorkspaceDirectory({ serverId });
    } catch (error) {
      if (error instanceof DirectoryRefreshSupersededError) continue;
      throw error;
    }
    const after = runtime.getSnapshot(serverId);
    if (
      after?.connectionStatus === "online" &&
      after.client === before.client &&
      after.connectionEpoch === before.connectionEpoch &&
      after.client?.getLastServerInfoMessage()
    )
      return;
  }
  throw new DirectoryRefreshSupersededError("Workspace state confirmation was superseded");
}

export function markWorkspacePinOutcomeUnknown(workspaceKey: string): void {
  unknownWorkspaceKeys.add(workspaceKey);
  pendingWorkspaceKeys.add(workspaceKey);
  notifyPending();
}

export async function confirmWorkspacePinChange(
  workspace: Pick<PinnableWorkspace, "workspaceKey" | "serverId">,
): Promise<void> {
  if (reconcilingWorkspaceKeys.has(workspace.workspaceKey))
    throw new Error("This workspace's pin state is already being checked");
  reconcilingWorkspaceKeys.add(workspace.workspaceKey);
  try {
    await reconcileWorkspacePin(workspace.serverId);
    unknownWorkspaceKeys.delete(workspace.workspaceKey);
  } finally {
    reconcilingWorkspaceKeys.delete(workspace.workspaceKey);
  }
}

// Reserve a complete subtree before reconciling or mutating any member. Pending unknown
// outcomes remain guarded between attempts; active reservations also prevent another batch
// from entering an unknown member while this batch is checking a different host.
export async function runWorkspacePinChanges<T>(
  workspaces: readonly Pick<PinnableWorkspace, "workspaceKey" | "serverId">[],
  action: () => Promise<T>,
): Promise<T> {
  const unique = new Map<string, (typeof workspaces)[number]>();
  for (const workspace of workspaces) {
    const previous = unique.get(workspace.workspaceKey);
    if (previous && previous.serverId !== workspace.serverId)
      throw new Error("Workspace identity changed. Refresh and try again");
    unique.set(workspace.workspaceKey, workspace);
  }
  // Validate the entire set before acquiring anything, so a rejected overlapping
  // group cannot leave unrelated workspaces locked.
  for (const key of unique.keys()) {
    if (
      activeWorkspaceKeys.has(key) ||
      (pendingWorkspaceKeys.has(key) && !unknownWorkspaceKeys.has(key))
    )
      throw new Error("This workspace's pin change is still pending");
    if (reconcilingWorkspaceKeys.has(key))
      throw new Error("This workspace's pin state is already being checked");
  }
  for (const key of unique.keys()) {
    activeWorkspaceKeys.add(key);
    pendingWorkspaceKeys.add(key);
  }
  notifyPending();
  try {
    for (const workspace of unique.values()) {
      if (unknownWorkspaceKeys.has(workspace.workspaceKey))
        await confirmWorkspacePinChange(workspace);
    }
    return await action();
  } finally {
    for (const key of unique.keys()) {
      activeWorkspaceKeys.delete(key);
      if (!unknownWorkspaceKeys.has(key)) pendingWorkspaceKeys.delete(key);
    }
    notifyPending();
  }
}

// Tree dragging shares the same admission guard as menus and keyboard shortcuts.
// A retry after a lost ACK must finish a read before another mutation is allowed.
export function runWorkspacePinChange<T>(
  workspace: Pick<PinnableWorkspace, "workspaceKey" | "serverId">,
  action: () => Promise<T>,
): Promise<T> {
  return runWorkspacePinChanges([workspace], action);
}

function useWorkspacePinController(kind: "pin" | "superpin"): ToggleSidebarWorkspacePin {
  const { t } = useTranslation();
  const toast = useToast();
  const confirm = useCallback(
    async function confirmState(workspace: PinnableWorkspace) {
      if (
        activeWorkspaceKeys.has(workspace.workspaceKey) ||
        reconcilingWorkspaceKeys.has(workspace.workspaceKey)
      )
        return;
      reconcilingWorkspaceKeys.add(workspace.workspaceKey);
      toast.show(t("sidebar.superpinned.outcomeUnknown"), { durationMs: null });
      try {
        await reconcileWorkspacePin(workspace.serverId);
        unknownWorkspaceKeys.delete(workspace.workspaceKey);
        if (!activeWorkspaceKeys.has(workspace.workspaceKey))
          pendingWorkspaceKeys.delete(workspace.workspaceKey);
        notifyPending();
        toast.show(t("sidebar.superpinned.stateConfirmed"), { variant: "info" });
      } catch {
        // A read failure cannot establish the mutation's outcome. Offer only another read;
        // mutation controls remain guarded even after React Query settles.
        toast.show(
          createElement(
            Button,
            {
              variant: "ghost",
              onPress: () => {
                void confirmState(workspace);
              },
              testID: "workspace-pin-check-state",
            },
            t("sidebar.superpinned.checkState"),
          ),
          { durationMs: null },
        );
      } finally {
        reconcilingWorkspaceKeys.delete(workspace.workspaceKey);
      }
    },
    [t, toast],
  );
  const mutation = useMutation({
    mutationFn: async (workspace: PinnableWorkspace) => {
      const runtime = getHostRuntimeStore();
      const client = runtime.getClient(workspace.serverId);
      const online = runtime.getSnapshot(workspace.serverId)?.connectionStatus === "online";
      if (!client || !online || !client.getLastServerInfoMessage())
        throw new Error(t("sidebar.workspace.toasts.hostDisconnected"));
      // Use confirmed current fields, not a callback captured before a concurrent update.
      const current = useSessionStore
        .getState()
        .sessions[workspace.serverId]?.workspaces.get(workspace.workspaceId);
      const fields = current ?? workspace;
      try {
        if (kind === "superpin")
          await client.setWorkspaceSuperpinned(workspace.workspaceId, fields.superpinnedAt == null);
        else
          await client.setWorkspacePinned(
            workspace.workspaceId,
            fields.pinnedAt == null && fields.superpinnedAt == null,
          );
      } catch (error) {
        if (!(error instanceof DaemonConnectionError)) throw error;
        unknownWorkspaceKeys.add(workspace.workspaceKey);
        await confirm(workspace);
      }
    },
    onError: (error) => {
      toast.error(
        error instanceof Error ? error.message : t("sidebar.workspace.toasts.hostDisconnected"),
      );
    },
    onSettled: (_data, _error, workspace) => {
      if (
        !unknownWorkspaceKeys.has(workspace.workspaceKey) &&
        !activeWorkspaceKeys.has(workspace.workspaceKey)
      ) {
        pendingWorkspaceKeys.delete(workspace.workspaceKey);
        notifyPending();
      }
    },
  });
  const mutate = mutation.mutate;
  return useCallback(
    (workspace: PinnableWorkspace) => {
      if (pendingWorkspaceKeys.has(workspace.workspaceKey)) return;
      pendingWorkspaceKeys.add(workspace.workspaceKey);
      notifyPending();
      mutate(workspace);
    },
    [mutate],
  );
}

export function useSidebarWorkspacePinController(): ToggleSidebarWorkspacePin {
  return useWorkspacePinController("pin");
}
export function useSidebarWorkspaceSuperpinController(): ToggleSidebarWorkspacePin {
  return useWorkspacePinController("superpin");
}
