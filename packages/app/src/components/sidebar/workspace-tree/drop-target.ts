import type { SidebarWorkspacePlacement } from "@/hooks/use-sidebar-workspaces-list";

export type WorkspaceDropPosition = "before" | "inside" | "after";
export interface WorkspaceTreeDrop {
  workspaceKey: string;
  targetWorkspaceKey: string;
  position: WorkspaceDropPosition;
  parentWorkspaceId: string | null;
  beforeWorkspaceId: string | null;
  pinnedOrderOnly?: boolean;
}
export interface WorkspaceTreeDropRejection {
  targetWorkspaceKey: string;
  message: string;
}
interface WorkspaceTreeDropInput {
  workspaces: readonly SidebarWorkspacePlacement[];
  workspaceKey: string;
  targetWorkspaceKey: string;
  position: WorkspaceDropPosition;
  pinnedRootKeys?: ReadonlySet<string>;
}
export function resolveWorkspaceTreeDrop(input: WorkspaceTreeDropInput): WorkspaceTreeDrop | null {
  return resolveWorkspaceTreeDropResult(input).drop;
}
export function resolveWorkspaceTreeDropResult(input: WorkspaceTreeDropInput): {
  drop: WorkspaceTreeDrop | null;
  rejection: WorkspaceTreeDropRejection | null;
} {
  const source = input.workspaces.find((item) => item.workspaceKey === input.workspaceKey);
  const target = input.workspaces.find((item) => item.workspaceKey === input.targetWorkspaceKey);
  if (!source || !target || source.workspaceKey === target.workspaceKey)
    return { drop: null, rejection: null };
  if (source.serverId !== target.serverId || source.projectViewKey !== target.projectViewKey) {
    const drop = resolvePinnedRootDrop(input, source, target);
    if (drop) return { drop, rejection: null };
    const scope = source.serverId !== target.serverId ? "host" : "project";
    return {
      drop: null,
      rejection: {
        targetWorkspaceKey: target.workspaceKey,
        message:
          input.position === "inside"
            ? `Use a workspace ${scope === "host" ? "on" : "in"} the same ${scope} to nest`
            : `Reorder workspaces within the same ${scope}`,
      },
    };
  }
  const parentWorkspaceId =
    input.position === "inside" ? target.workspaceId : effectiveParentId(input.workspaces, target);
  const byId = new Map(
    input.workspaces
      .filter((item) => item.serverId === source.serverId)
      .map((item) => [item.workspaceId, item]),
  );
  const seen = new Set<string>();
  let parent = parentWorkspaceId;
  while (parent) {
    if (parent === source.workspaceId || seen.has(parent))
      return {
        drop: null,
        rejection: {
          targetWorkspaceKey: target.workspaceKey,
          message: "A workspace cannot be moved into one of its children",
        },
      };
    seen.add(parent);
    parent = byId.get(parent)?.parentWorkspaceId ?? null;
  }
  let beforeWorkspaceId: string | null = null;
  if (input.position === "before") beforeWorkspaceId = target.workspaceId;
  if (input.position === "after") {
    const siblings = input.workspaces
      .filter(
        (item) =>
          item.serverId === target.serverId &&
          item.projectViewKey === target.projectViewKey &&
          effectiveParentId(input.workspaces, item) === parentWorkspaceId &&
          item.workspaceKey !== source.workspaceKey,
      )
      .sort(
        (left, right) =>
          (left.siblingOrder ?? 0) - (right.siblingOrder ?? 0) ||
          left.workspaceId.localeCompare(right.workspaceId),
      );
    const targetIndex = siblings.findIndex((item) => item.workspaceKey === target.workspaceKey);
    beforeWorkspaceId = siblings[targetIndex + 1]?.workspaceId ?? null;
  }
  return {
    drop: {
      workspaceKey: source.workspaceKey,
      targetWorkspaceKey: target.workspaceKey,
      position: input.position,
      parentWorkspaceId,
      beforeWorkspaceId,
    },
    rejection: null,
  };
}

function resolvePinnedRootDrop(
  input: { position: WorkspaceDropPosition; pinnedRootKeys?: ReadonlySet<string> },
  source: SidebarWorkspacePlacement,
  target: SidebarWorkspacePlacement,
): WorkspaceTreeDrop | null {
  if (
    input.position === "inside" ||
    !input.pinnedRootKeys?.has(source.workspaceKey) ||
    !input.pinnedRootKeys.has(target.workspaceKey)
  )
    return null;
  return {
    workspaceKey: source.workspaceKey,
    targetWorkspaceKey: target.workspaceKey,
    position: input.position,
    parentWorkspaceId: source.parentWorkspaceId ?? null,
    beforeWorkspaceId: null,
    pinnedOrderOnly: true,
  };
}
export function effectiveParentId(
  workspaces: readonly SidebarWorkspacePlacement[],
  workspace: SidebarWorkspacePlacement,
): string | null {
  return workspaces.some(
    (parent) =>
      parent.serverId === workspace.serverId &&
      parent.projectViewKey === workspace.projectViewKey &&
      parent.workspaceId === workspace.parentWorkspaceId,
  )
    ? (workspace.parentWorkspaceId ?? null)
    : null;
}

export function workspaceDropPosition(relativeY: number, height: number): WorkspaceDropPosition {
  if (relativeY < height * 0.25) return "before";
  if (relativeY > height * 0.75) return "after";
  return "inside";
}
