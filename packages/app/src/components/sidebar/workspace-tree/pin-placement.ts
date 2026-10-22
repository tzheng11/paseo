import { DaemonConnectionError, type DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { WorkspaceTreeDrop } from "./drop-target";

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
  confirmPinState?: () => Promise<{ pinned: boolean; superpinned: boolean }>;
}): Promise<void> {
  const { client, workspaceId, drop, shouldPin, shouldSuperpin } = input;
  if (drop.pinnedOrderOnly && input.pinned === shouldPin && input.superpinned === shouldSuperpin)
    return;
  if (!client) throw new Error("Host disconnected. Reconnect and retry");
  if (!drop.pinnedOrderOnly)
    await client.moveWorkspace(workspaceId, {
      parentWorkspaceId: null,
      beforeWorkspaceId: drop.beforeWorkspaceId,
    });
  try {
    let pinned = input.pinned;
    if (input.superpinned !== shouldSuperpin)
      pinned =
        (await client.setWorkspaceSuperpinned(workspaceId, shouldSuperpin)).pinnedAt !== null;
    if (pinned !== shouldPin) await client.setWorkspacePinned(workspaceId, shouldPin);
  } catch (error) {
    if (!(error instanceof DaemonConnectionError) || !input.confirmPinState) throw error;
    // A lost ACK may already have changed the pin. Read it; never replay the mutation blindly.
    const confirmed = await input.confirmPinState();
    if (confirmed.pinned !== shouldPin || confirmed.superpinned !== shouldSuperpin)
      throw new Error("Pin change was not confirmed. Check its current priority and retry", {
        cause: error,
      });
  }
}
