import type { SidebarWorkspacePlacement } from "@/hooks/sidebar-workspaces-view-model";
import { resolvePinnedWorkspaceTree } from "./pinned-layout";

export interface WorkspaceTreeRow {
  workspace: SidebarWorkspacePlacement;
  depth: number;
  hasChildren: boolean;
}

export function compareWorkspaceSiblings(
  left: SidebarWorkspacePlacement,
  right: SidebarWorkspacePlacement,
): number {
  if (left.siblingOrder === undefined || right.siblingOrder === undefined) return 0;
  return (
    left.siblingOrder - right.siblingOrder || left.workspaceKey.localeCompare(right.workspaceKey)
  );
}

function workspaceParents(
  layout: ReturnType<typeof resolvePinnedWorkspaceTree>,
): Map<string, string> {
  const parents = new Map<string, string>();
  for (const [key, placement] of layout) {
    if (placement.parentWorkspaceKey !== null) parents.set(key, placement.parentWorkspaceKey);
  }
  return parents;
}

export function effectiveWorkspaceParentKey(
  workspaces: readonly SidebarWorkspacePlacement[],
  workspace: SidebarWorkspacePlacement,
): string | null {
  return (
    resolvePinnedWorkspaceTree(workspaces).get(workspace.workspaceKey)?.parentWorkspaceKey ?? null
  );
}

export function flattenWorkspaceTree(
  workspaces: readonly SidebarWorkspacePlacement[],
  collapsedKeys: ReadonlySet<string>,
  sortSiblings = true,
): WorkspaceTreeRow[] {
  const layout = resolvePinnedWorkspaceTree(workspaces);
  const parents = workspaceParents(layout);
  const children = new Map<string, SidebarWorkspacePlacement[]>();
  const roots: SidebarWorkspacePlacement[] = [];
  for (const workspace of workspaces) {
    const parent = parents.get(workspace.workspaceKey);
    if (parent === undefined) {
      roots.push(workspace);
      continue;
    }
    const siblings = children.get(parent);
    if (siblings) siblings.push(workspace);
    else children.set(parent, [workspace]);
  }
  if (sortSiblings) {
    const compare = (left: SidebarWorkspacePlacement, right: SidebarWorkspacePlacement) => {
      const leftRank = layout.get(left.workspaceKey)?.siblingOrder ?? 0;
      const rightRank = layout.get(right.workspaceKey)?.siblingOrder ?? 0;
      return leftRank - rightRank || left.workspaceKey.localeCompare(right.workspaceKey);
    };
    const rootSection = roots[0]?.sidebarSection;
    if (rootSection && roots.every((workspace) => workspace.sidebarSection === rootSection))
      roots.sort(compare);
    for (const siblings of children.values()) siblings.sort(compare);
  }

  const rows: WorkspaceTreeRow[] = [];
  const pending = roots.toReversed().map((workspace) => ({ workspace, depth: 0 }));
  while (pending.length > 0) {
    const row = pending.pop()!;
    const descendants = children.get(row.workspace.workspaceKey);
    const hasChildren = descendants !== undefined && descendants.length > 0;
    rows.push({ ...row, hasChildren });
    if (!descendants || collapsedKeys.has(row.workspace.workspaceKey)) continue;
    for (let index = descendants.length - 1; index >= 0; index -= 1) {
      pending.push({ workspace: descendants[index]!, depth: row.depth + 1 });
    }
  }
  return rows;
}

export function getWorkspaceAncestorKeys(
  workspaces: readonly SidebarWorkspacePlacement[],
  workspaceKey: string,
): string[] {
  const parents = workspaceParents(resolvePinnedWorkspaceTree(workspaces));
  const ancestors: string[] = [];
  let parent = parents.get(workspaceKey);
  while (parent !== undefined) {
    ancestors.push(parent);
    parent = parents.get(parent);
  }
  return ancestors;
}

export function getWorkspaceDescendantKeys(
  workspaces: readonly SidebarWorkspacePlacement[],
  workspaceKey: string,
): Set<string> {
  const rows = flattenWorkspaceTree(workspaces, new Set());
  const index = rows.findIndex((row) => row.workspace.workspaceKey === workspaceKey);
  const descendants = new Set<string>();
  if (index === -1) return descendants;
  const depth = rows[index]!.depth;
  for (let next = index + 1; next < rows.length; next += 1) {
    const row = rows[next]!;
    if (row.depth <= depth) break;
    descendants.add(row.workspace.workspaceKey);
  }
  return descendants;
}
