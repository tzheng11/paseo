import type { SidebarWorkspacePlacement } from "@/hooks/use-sidebar-workspaces-list";
import { resolvePinnedWorkspaceTree, type PinnedWorkspaceSection } from "./pinned-layout";

export type WorkspaceDropPosition = "before" | "inside" | "after";
export interface WorkspaceTreeDrop {
  workspaceKey: string;
  targetWorkspaceKey: string;
  position: WorkspaceDropPosition;
  parentWorkspaceId: string | null;
  beforeWorkspaceId: string | null;
  // Pinned layout uses complete identities and never sends these relationships to a host.
  parentWorkspaceKey?: string | null;
  beforeWorkspaceKey?: string | null;
  pinSection?: PinnedWorkspaceSection;
  pinnedOrderOnly?: boolean;
}
export interface WorkspaceTreeDropRejection {
  targetWorkspaceKey: string;
  message: string;
}
interface WorkspaceTreeDropInput {
  workspaces: readonly SidebarWorkspacePlacement[];
  allWorkspaces?: readonly SidebarWorkspacePlacement[];
  workspaceKey: string;
  targetWorkspaceKey: string;
  position: WorkspaceDropPosition;
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
  const reject = (message: string) => ({
    drop: null,
    rejection: { targetWorkspaceKey: target.workspaceKey, message },
  });
  const fullTree = resolvePinnedWorkspaceTree(input.allWorkspaces ?? input.workspaces);
  if (target.sidebarSection)
    return resolvePinnedDrop(input, source, target, fullTree, target.sidebarSection);
  if (input.position === "inside")
    return reject("Pin workspaces to nest them in Pinned or SuperPinned");
  if (source.serverId !== target.serverId || source.projectViewKey !== target.projectViewKey)
    return reject(
      "Reorder within a project, or pin workspaces to arrange them across projects and hosts",
    );
  const siblings = input.workspaces.filter(
    (item) =>
      !item.sidebarSection &&
      item.serverId === target.serverId &&
      item.projectViewKey === target.projectViewKey &&
      item.workspaceKey !== source.workspaceKey,
  );
  const targetIndex = siblings.findIndex((item) => item.workspaceKey === target.workspaceKey);
  return {
    drop: {
      workspaceKey: source.workspaceKey,
      targetWorkspaceKey: target.workspaceKey,
      position: input.position,
      parentWorkspaceId: null,
      beforeWorkspaceId:
        input.position === "before"
          ? target.workspaceId
          : (siblings[targetIndex + 1]?.workspaceId ?? null),
    },
    rejection: null,
  };
}
function resolvePinnedDrop(
  input: WorkspaceTreeDropInput,
  source: SidebarWorkspacePlacement,
  target: SidebarWorkspacePlacement,
  fullTree: ReturnType<typeof resolvePinnedWorkspaceTree>,
  section: PinnedWorkspaceSection,
): { drop: WorkspaceTreeDrop | null; rejection: WorkspaceTreeDropRejection | null } {
  const reject = (message: string) => ({
    drop: null,
    rejection: { targetWorkspaceKey: target.workspaceKey, message },
  });
  // Filtering a parent out of view must not silently delete the saved edge
  // when placing a workspace alongside one of that parent's children.
  const parents = fullTree;
  const parentWorkspaceKey =
    input.position === "inside"
      ? target.workspaceKey
      : (parents.get(target.workspaceKey)?.parentWorkspaceKey ?? null);
  let ancestor: string | null = target.workspaceKey;
  const seen = new Set<string>();
  while (ancestor !== null && !seen.has(ancestor)) {
    if (ancestor === source.workspaceKey)
      return reject("A workspace cannot be moved into one of its children");
    seen.add(ancestor);
    ancestor = fullTree.get(ancestor)?.parentWorkspaceKey ?? null;
  }
  const siblings = input.workspaces.filter(
    (item) =>
      item.sidebarSection === target.sidebarSection &&
      item.workspaceKey !== source.workspaceKey &&
      (parents.get(item.workspaceKey)?.parentWorkspaceKey ?? null) === parentWorkspaceKey,
  );
  // Keep the order actually shown (including A–Z/activity), rather than old manual ranks.
  const targetIndex = siblings.findIndex((item) => item.workspaceKey === target.workspaceKey);
  let beforeWorkspaceKey: string | null = null;
  if (input.position === "before") beforeWorkspaceKey = target.workspaceKey;
  if (input.position === "after")
    beforeWorkspaceKey = siblings[targetIndex + 1]?.workspaceKey ?? null;
  return {
    drop: {
      workspaceKey: source.workspaceKey,
      targetWorkspaceKey: target.workspaceKey,
      position: input.position,
      parentWorkspaceId: null,
      beforeWorkspaceId: null,
      parentWorkspaceKey,
      beforeWorkspaceKey,
      pinSection: section,
      pinnedOrderOnly: true,
    },
    rejection: null,
  };
}

export function workspaceDropPosition(relativeY: number, height: number): WorkspaceDropPosition {
  if (relativeY < height * 0.25) return "before";
  if (relativeY > height * 0.75) return "after";
  return "inside";
}
