import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { SidebarWorkspacePlacement } from "@/hooks/use-sidebar-workspaces-list";
import { flattenWorkspaceTree } from "./model";
import type { WorkspaceTreeDrop } from "./drop-target";

export function shouldPinWorkspaceAfterDrop(
  drop: WorkspaceTreeDrop,
  serverId: string,
  pinnedWorkspaceKeys: ReadonlySet<string>,
): boolean {
  const parentCovered =
    drop.parentWorkspaceId !== null &&
    pinnedWorkspaceKeys.has(`${serverId}:${drop.parentWorkspaceId}`);
  return pinnedWorkspaceKeys.has(drop.targetWorkspaceKey) && !parentCovered;
}

export function reorderPinnedWorkspaceSubtree(input: {
  workspaces: readonly SidebarWorkspacePlacement[];
  pinnedWorkspaces: readonly SidebarWorkspacePlacement[];
  drop: WorkspaceTreeDrop;
}): SidebarWorkspacePlacement[] | null {
  const allRows = flattenWorkspaceTree(input.workspaces, new Set());
  const sourceIndex = allRows.findIndex(
    (row) => row.workspace.workspaceKey === input.drop.workspaceKey,
  );
  if (sourceIndex < 0) return null;
  const depth = allRows[sourceIndex]!.depth;
  let end = sourceIndex + 1;
  while (end < allRows.length && allRows[end]!.depth > depth) end += 1;
  const subtree = allRows.slice(sourceIndex, end);
  const movedKeys = new Set(subtree.map((row) => row.workspace.workspaceKey));
  const remainder = flattenWorkspaceTree(input.pinnedWorkspaces, new Set()).filter(
    (row) => !movedKeys.has(row.workspace.workspaceKey),
  );
  let targetIndex = remainder.findIndex(
    (row) => row.workspace.workspaceKey === input.drop.targetWorkspaceKey,
  );
  if (targetIndex < 0) return null;
  if (input.drop.position === "after") {
    const targetDepth = remainder[targetIndex]!.depth;
    targetIndex += 1;
    while (targetIndex < remainder.length && remainder[targetIndex]!.depth > targetDepth)
      targetIndex += 1;
  }
  remainder.splice(targetIndex, 0, ...subtree);
  return remainder.map((row) => row.workspace);
}

export async function applyWorkspaceTreeMove(input: {
  client: Pick<
    DaemonClient,
    "moveWorkspace" | "setWorkspacePinned" | "setWorkspaceSuperpinned"
  > | null;
  workspaceId: string;
  drop: WorkspaceTreeDrop;
  pinned: boolean;
  superpinned: boolean;
  shouldPin: boolean;
  shouldSuperpin: boolean;
}): Promise<void> {
  const { client, workspaceId, drop, shouldPin, shouldSuperpin } = input;
  if (drop.pinnedOrderOnly && input.pinned === shouldPin && input.superpinned === shouldSuperpin)
    return;
  if (!client) throw new Error("Host disconnected. Reconnect and retry");
  let pinned = input.pinned;
  if (!drop.pinnedOrderOnly)
    await client.moveWorkspace(workspaceId, {
      parentWorkspaceId: drop.parentWorkspaceId,
      beforeWorkspaceId: drop.beforeWorkspaceId,
    });
  if (input.superpinned !== shouldSuperpin)
    pinned = (await client.setWorkspaceSuperpinned(workspaceId, shouldSuperpin)).pinnedAt !== null;
  if (pinned !== shouldPin) await client.setWorkspacePinned(workspaceId, shouldPin);
}
