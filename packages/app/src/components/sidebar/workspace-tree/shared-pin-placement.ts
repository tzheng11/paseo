import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { SidebarWorkspacePlacement } from "@/hooks/use-sidebar-workspaces-list";
import { useSessionStore } from "@/stores/session-store";
import type { PinnedWorkspaceTree } from "./pinned-layout";

export function changedPinPlacements(input: {
  previous: PinnedWorkspaceTree;
  next: PinnedWorkspaceTree;
  workspaces: readonly SidebarWorkspacePlacement[];
}) {
  return input.workspaces.flatMap((workspace) => {
    const next = input.next[workspace.workspaceKey];
    const previous = input.previous[workspace.workspaceKey];
    return next &&
      (next.parentWorkspaceKey !== previous?.parentWorkspaceKey ||
        next.siblingOrder !== previous?.siblingOrder)
      ? [{ workspace, placement: next, expectedRevision: workspace.pinPlacement?.revision ?? 0 }]
      : [];
  });
}

export function requireSharedPinClients(
  updates: ReturnType<typeof changedPinPlacements>,
  getClient: (serverId: string) => DaemonClient | null | undefined,
): void {
  for (const { workspace } of updates) {
    const client = getClient(workspace.serverId);
    if (!client) throw new Error("Host disconnected. Reconnect and retry.");
    if (client.getLastServerInfoMessage()?.features?.workspacePinPlacement !== true)
      throw new Error("Update this host to sync pin nesting across clients.");
  }
}

export async function saveSharedPinPlacements(input: {
  updates: ReturnType<typeof changedPinPlacements>;
  sourceWorkspaceKey: string;
  getClient: (serverId: string) => DaemonClient | null | undefined;
  accepted: (
    workspace: SidebarWorkspacePlacement,
    placement: Awaited<ReturnType<DaemonClient["setWorkspacePinPlacement"]>>,
  ) => void;
}) {
  requireSharedPinClients(input.updates, input.getClient);
  // Preserve sibling order while rebalancing; publish the actual move last.
  const updates = [...input.updates].sort(
    (a, b) =>
      Number(a.workspace.workspaceKey === input.sourceWorkspaceKey) -
      Number(b.workspace.workspaceKey === input.sourceWorkspaceKey),
  );
  for (const { workspace, placement, expectedRevision } of updates) {
    const saved = await input.getClient(workspace.serverId)!.setWorkspacePinPlacement({
      workspaceId: workspace.workspaceId,
      placement,
      expectedRevision,
    });
    input.accepted(workspace, saved);
  }
}

export function acceptSharedPinPlacement(
  workspace: SidebarWorkspacePlacement,
  pinPlacement: Awaited<ReturnType<DaemonClient["setWorkspacePinPlacement"]>>,
): void {
  const store = useSessionStore.getState();
  const current = store.sessions[workspace.serverId]?.workspaces.get(workspace.workspaceId);
  if (current) store.mergeWorkspaces(workspace.serverId, [{ ...current, pinPlacement }]);
}
