import type { SessionInboundMessage } from "@getpaseo/protocol/messages";
import type { PersistedWorkspaceRecord, WorkspaceRegistry } from "./workspace-registry.js";

type SetPlacement = Extract<SessionInboundMessage, { type: "workspace.pin.placement.set.request" }>;
export type WorkspaceSidebarPlacement = NonNullable<
  Extract<SessionInboundMessage, { type: "workspace.create.request" }>["sidebarPlacement"]
>;
export type WorkspaceSidebarSection = WorkspaceSidebarPlacement["section"];

export function workspaceSidebarSection(workspace: {
  pinnedAt?: string | null;
  superpinnedAt?: string | null;
}): WorkspaceSidebarSection {
  if (workspace.superpinnedAt) return "superpinned";
  if (workspace.pinnedAt) return "pinned";
  return "unpinned";
}

function sectionFields(
  section: WorkspaceSidebarSection,
  workspace?: Pick<PersistedWorkspaceRecord, "pinnedAt" | "superpinnedAt">,
) {
  const now = new Date().toISOString();
  return {
    pinnedAt: section === "unpinned" ? null : (workspace?.pinnedAt ?? now),
    superpinnedAt: section === "superpinned" ? (workspace?.superpinnedAt ?? now) : null,
  };
}

/** Cross-host keys are opaque at their owner. Callers resolve remote snapshots before mutation. */
export async function initialWorkspaceSidebarFields(
  registry: WorkspaceRegistry,
  serverId: string | undefined,
  context?: {
    sidebarPlacement?: WorkspaceSidebarPlacement;
    callerWorkspaceId?: string;
    parentWorkspaceId?: string | null;
  },
): Promise<
  | Pick<PersistedWorkspaceRecord, "pinPlacement" | "pinnedAt" | "superpinnedAt">
  | Record<string, never>
> {
  let placement = context?.sidebarPlacement;
  if (!placement && context?.callerWorkspaceId && context.parentWorkspaceId === undefined) {
    if (!serverId) throw new Error("This host cannot resolve its workspace navigation identity.");
    const caller = await registry.get(context.callerWorkspaceId);
    if (!caller || caller.archivedAt) throw new Error("Caller workspace is not active.");
    placement = {
      parentWorkspaceKey: `${serverId}:${caller.workspaceId}`,
      section: workspaceSidebarSection(caller),
    };
  }
  if (!placement) return {};
  await validateLocalSidebarParent(registry, serverId, placement.parentWorkspaceKey);
  if (serverId && placement.parentWorkspaceKey?.startsWith(`${serverId}:`)) {
    const parent = await registry.get(placement.parentWorkspaceKey.slice(serverId.length + 1));
    if (parent && workspaceSidebarSection(parent) !== placement.section)
      throw new Error("A child must use its parent workspace's section.");
  }
  const rows = await registry.list();
  const byId = new Map(rows.map((row) => [row.workspaceId, row]));
  const siblings = rows.filter((row) => {
    if (row.archivedAt || workspaceSidebarSection(row) !== placement.section) return false;
    let parentKey = row.pinPlacement?.parentWorkspaceKey ?? null;
    if (!row.pinPlacement && row.parentWorkspaceId && serverId) {
      const parent = byId.get(row.parentWorkspaceId);
      if (
        parent &&
        !parent.archivedAt &&
        parent.projectId === row.projectId &&
        workspaceSidebarSection(parent) === placement.section
      )
        parentKey = `${serverId}:${parent.workspaceId}`;
    }
    return parentKey === placement.parentWorkspaceKey;
  });
  const siblingOrder =
    placement.siblingOrder ??
    Math.max(
      0,
      ...siblings.map(
        (row) =>
          row.pinPlacement?.siblingOrder ??
          (placement.parentWorkspaceKey === null ? 0 : (row.siblingOrder ?? 0)),
      ),
    ) + 1024;
  if (!Number.isFinite(siblingOrder)) throw new Error("Workspace order is out of range.");
  return {
    pinPlacement: { parentWorkspaceKey: placement.parentWorkspaceKey, siblingOrder, revision: 1 },
    ...sectionFields(placement.section),
  };
}

async function validateLocalSidebarParent(
  registry: WorkspaceRegistry,
  serverId: string | undefined,
  parentKey: string | null,
  workspaceId?: string,
) {
  const visited = new Set(workspaceId && serverId ? [`${serverId}:${workspaceId}`] : []);
  let key = parentKey;
  while (key !== null) {
    if (visited.has(key)) throw new Error("A workspace cannot be its own parent or ancestor.");
    visited.add(key);
    if (!serverId || !key.startsWith(`${serverId}:`)) return;
    const parent = await registry.get(key.slice(serverId.length + 1));
    if (!parent || parent.archivedAt) throw new Error("Parent workspace is not active.");
    key = parent.pinPlacement?.parentWorkspaceKey ?? null;
  }
}

const placementWrites = new WeakMap<WorkspaceRegistry, Promise<void>>();

/** Navigation metadata and section membership commit together; backing directories and agents stay put. */
export function setWorkspacePinPlacement(
  registry: WorkspaceRegistry,
  input: Pick<
    SetPlacement,
    "workspaceId" | "placement" | "expectedRevision" | "section" | "sectionState"
  >,
  serverId: string | undefined,
) {
  // Parent validation and the write share one owner queue, so simultaneous A→B and B→A cannot both pass.
  const previous = placementWrites.get(registry) ?? Promise.resolve();
  const result = previous.then(() => commitWorkspacePinPlacement(registry, input, serverId));
  placementWrites.set(
    registry,
    result.then(
      () => undefined,
      () => undefined,
    ),
  );
  return result;
}

async function commitWorkspacePinPlacement(
  registry: WorkspaceRegistry,
  input: Pick<
    SetPlacement,
    "workspaceId" | "placement" | "expectedRevision" | "section" | "sectionState"
  >,
  serverId: string | undefined,
) {
  if (
    input.sectionState &&
    (input.section === undefined || workspaceSidebarSection(input.sectionState) !== input.section)
  )
    throw new Error("Saved section timestamps must match the requested section.");
  await validateLocalSidebarParent(
    registry,
    serverId,
    input.placement.parentWorkspaceKey,
    input.workspaceId,
  );
  const updated = await registry.update(input.workspaceId, (workspace) => {
    if (workspace.archivedAt) throw new Error("Workspace is archived.");
    const current = workspace.pinPlacement;
    // A lost acknowledgement is safe to retry without allocating another revision.
    if (
      current?.parentWorkspaceKey === input.placement.parentWorkspaceKey &&
      current.siblingOrder === input.placement.siblingOrder &&
      (input.section === undefined || workspaceSidebarSection(workspace) === input.section) &&
      (!input.sectionState ||
        (workspace.pinnedAt === input.sectionState.pinnedAt &&
          workspace.superpinnedAt === input.sectionState.superpinnedAt))
    )
      return workspace;
    if ((current?.revision ?? 0) !== input.expectedRevision)
      throw new Error("This workspace moved in another client. Refresh and try again.");
    return {
      ...workspace,
      ...(input.section === undefined
        ? {}
        : (input.sectionState ?? sectionFields(input.section, workspace))),
      pinPlacement: { ...input.placement, revision: (current?.revision ?? 0) + 1 },
      updatedAt: new Date().toISOString(),
    };
  });
  if (!updated?.pinPlacement) throw new Error("Workspace not found.");
  return updated.pinPlacement;
}
