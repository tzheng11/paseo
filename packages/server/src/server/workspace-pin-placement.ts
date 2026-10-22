import type { SessionInboundMessage } from "@getpaseo/protocol/messages";
import type { WorkspaceRegistry } from "./workspace-registry.js";

type SetPlacement = Extract<SessionInboundMessage, { type: "workspace.pin.placement.set.request" }>;

/** Pin navigation is workspace metadata; it never moves backing directories or agents. */
export async function setWorkspacePinPlacement(
  registry: WorkspaceRegistry,
  input: Pick<SetPlacement, "workspaceId" | "placement" | "expectedRevision">,
  serverId: string | undefined,
) {
  if (input.placement.parentWorkspaceKey === `${serverId}:${input.workspaceId}`)
    throw new Error("A pin cannot be its own parent.");
  const updated = await registry.update(input.workspaceId, (workspace) => {
    if (workspace.archivedAt) throw new Error("Workspace is archived.");
    const current = workspace.pinPlacement;
    // A lost acknowledgement is safe to retry without allocating another revision.
    if (
      current?.parentWorkspaceKey === input.placement.parentWorkspaceKey &&
      current.siblingOrder === input.placement.siblingOrder
    )
      return workspace;
    if ((current?.revision ?? 0) !== input.expectedRevision)
      throw new Error("This pin moved in another client. Refresh and try again.");
    return {
      ...workspace,
      pinPlacement: { ...input.placement, revision: (current?.revision ?? 0) + 1 },
      updatedAt: new Date().toISOString(),
    };
  });
  if (!updated?.pinPlacement) throw new Error("Workspace not found.");
  return updated.pinPlacement;
}
