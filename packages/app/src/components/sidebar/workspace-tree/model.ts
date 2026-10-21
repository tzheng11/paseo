import type { SidebarWorkspacePlacement } from "@/hooks/sidebar-workspaces-view-model";

export interface WorkspaceTreeRow {
  workspace: SidebarWorkspacePlacement;
  depth: number;
  hasChildren: boolean;
}

function parentKey(workspace: SidebarWorkspacePlacement): string | null {
  return workspace.parentWorkspaceId
    ? `${workspace.serverId}:${workspace.parentWorkspaceId}`
    : null;
}

export function compareWorkspaceSiblings(
  left: SidebarWorkspacePlacement,
  right: SidebarWorkspacePlacement,
): number {
  if (left.siblingOrder === undefined || right.siblingOrder === undefined) return 0;
  return (
    left.siblingOrder - right.siblingOrder || left.workspaceId.localeCompare(right.workspaceId)
  );
}

function workspaceParents(workspaces: readonly SidebarWorkspacePlacement[]): Map<string, string> {
  const byKey = new Map(workspaces.map((workspace) => [workspace.workspaceKey, workspace]));
  const parents = new Map<string, string>();
  for (const workspace of workspaces) {
    const candidateKey = parentKey(workspace);
    const parent = candidateKey === null ? undefined : byKey.get(candidateKey);
    const sameProject = parent?.projectViewKey === workspace.projectViewKey;
    if (parent && sameProject && parent.workspaceKey !== workspace.workspaceKey) {
      parents.set(workspace.workspaceKey, parent.workspaceKey);
    }
  }
  // Directory snapshots can arrive incrementally. A corrupt or partially loaded
  // ancestor chain must never hide a workspace from navigation.
  for (const workspace of workspaces) {
    const seen = new Set<string>();
    let key: string | undefined = workspace.workspaceKey;
    while (key !== undefined && !seen.has(key)) {
      seen.add(key);
      key = parents.get(key);
    }
    if (key !== undefined) parents.delete(key);
  }
  return parents;
}

export function flattenWorkspaceTree(
  workspaces: readonly SidebarWorkspacePlacement[],
  collapsedKeys: ReadonlySet<string>,
  sortSiblings = true,
): WorkspaceTreeRow[] {
  const parents = workspaceParents(workspaces);
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
    for (const siblings of children.values()) siblings.sort(compareWorkspaceSiblings);
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
  const parents = workspaceParents(workspaces);
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
