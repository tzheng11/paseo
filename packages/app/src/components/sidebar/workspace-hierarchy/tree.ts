import type { SidebarWorkspacePlacement } from "@/hooks/sidebar-workspaces-view-model";

export const WORKSPACE_TREE_INDENT = 18;

export interface WorkspaceTreeItem extends SidebarWorkspacePlacement {
  parentWorkspaceId?: string | null;
  siblingOrder?: number;
}

export interface WorkspaceTreeRow {
  workspace: WorkspaceTreeItem;
  parentKey: string | null;
  depth: number;
  hasChildren: boolean;
}

export interface WorkspaceTreeMove {
  workspaceId: string;
  serverId: string;
  parentWorkspaceId: string | null;
  beforeWorkspaceId: string | null;
}

export interface WorkspaceTreeDrop {
  targetKey: string;
  position: "before" | "inside" | "after";
  depth: number;
  move: WorkspaceTreeMove;
}

/** Missing parents are display roots: filters and archived rows must never hide live children. */
export function buildWorkspaceTree(
  workspaces: readonly WorkspaceTreeItem[],
  preserveInputSiblingOrder = false,
): WorkspaceTreeRow[] {
  const byKey = new Map(workspaces.map((workspace) => [workspace.workspaceKey, workspace]));
  const parents = new Map<string, string | null>();
  const indexByKey = new Map(workspaces.map((workspace, index) => [workspace.workspaceKey, index]));
  const serverOrder = new Map<string, number>();
  for (const workspace of workspaces) {
    if (!serverOrder.has(workspace.serverId)) serverOrder.set(workspace.serverId, serverOrder.size);
  }
  for (const workspace of workspaces) {
    const parentKey = workspace.parentWorkspaceId
      ? `${workspace.serverId}:${workspace.parentWorkspaceId}`
      : null;
    parents.set(workspace.workspaceKey, parentKey && byKey.has(parentKey) ? parentKey : null);
  }
  // A corrupt cache must not make a workspace disappear or trap the renderer in a cycle.
  for (const workspace of workspaces) {
    const visited = new Set([workspace.workspaceKey]);
    let parent = parents.get(workspace.workspaceKey) ?? null;
    while (parent) {
      if (visited.has(parent)) {
        parents.set(workspace.workspaceKey, null);
        break;
      }
      visited.add(parent);
      parent = parents.get(parent) ?? null;
    }
  }
  const children = new Map<string | null, WorkspaceTreeItem[]>();
  for (const workspace of workspaces) {
    const parent = parents.get(workspace.workspaceKey) ?? null;
    const siblings = children.get(parent) ?? [];
    siblings.push(workspace);
    children.set(parent, siblings);
  }
  for (const siblings of children.values()) {
    siblings.sort((left, right) => {
      const hostOrder =
        (serverOrder.get(left.serverId) ?? 0) - (serverOrder.get(right.serverId) ?? 0);
      if (hostOrder) return hostOrder;
      const order = preserveInputSiblingOrder
        ? 0
        : (left.siblingOrder ?? 0) - (right.siblingOrder ?? 0);
      return (
        order ||
        (indexByKey.get(left.workspaceKey) ?? 0) - (indexByKey.get(right.workspaceKey) ?? 0)
      );
    });
  }
  const rows: WorkspaceTreeRow[] = [];
  function visit(parentKey: string | null, depth: number) {
    for (const workspace of children.get(parentKey) ?? []) {
      const hasChildren = children.has(workspace.workspaceKey);
      rows.push({ workspace, parentKey, depth, hasChildren });
      visit(workspace.workspaceKey, depth + 1);
    }
  }
  visit(null, 0);
  return rows;
}

export function workspaceTreeDescendants(
  rows: readonly WorkspaceTreeRow[],
  workspaceKey: string,
): Set<string> {
  const descendants = new Set<string>();
  let parentDepth: number | null = null;
  for (const row of rows) {
    if (row.workspace.workspaceKey === workspaceKey) {
      parentDepth = row.depth;
      continue;
    }
    if (parentDepth === null) continue;
    if (row.depth <= parentDepth) break;
    descendants.add(row.workspace.workspaceKey);
  }
  return descendants;
}

export function visibleWorkspaceTreeRows(input: {
  rows: readonly WorkspaceTreeRow[];
  collapsedKeys: ReadonlySet<string>;
  draggingKey?: string | null;
}): WorkspaceTreeRow[] {
  let hiddenBelow: number | null = null;
  return input.rows.filter((row) => {
    if (hiddenBelow !== null && row.depth > hiddenBelow) return false;
    hiddenBelow = null;
    const key = row.workspace.workspaceKey;
    if (input.collapsedKeys.has(key) || input.draggingKey === key) hiddenBelow = row.depth;
    return true;
  });
}

/** Limit whole root forests so children never outlive or get cut off from a visible parent. */
export function workspaceTreeRowsForRoots(input: {
  rows: readonly WorkspaceTreeRow[];
  rootKeys: ReadonlySet<string>;
  activeKey: string | null;
}): WorkspaceTreeRow[] {
  let currentRoot: string | null = null;
  let activeRoot: string | null = null;
  for (const row of input.rows) {
    if (row.depth === 0) currentRoot = row.workspace.workspaceKey;
    if (row.workspace.workspaceKey === input.activeKey) {
      activeRoot = currentRoot;
      break;
    }
  }
  let include = false;
  return input.rows.filter((row) => {
    if (row.depth === 0) {
      const key = row.workspace.workspaceKey;
      include = input.rootKeys.has(key) || key === activeRoot;
    }
    return include;
  });
}

export function projectWorkspaceTreeDrop(input: {
  rows: readonly WorkspaceTreeRow[];
  activeKey: string;
  targetKey: string;
  position: WorkspaceTreeDrop["position"];
  horizontalOffset?: number;
}): WorkspaceTreeDrop | null {
  const active = input.rows.find((row) => row.workspace.workspaceKey === input.activeKey);
  const target = input.rows.find((row) => row.workspace.workspaceKey === input.targetKey);
  if (!active || !target || active.workspace.serverId !== target.workspace.serverId) return null;
  const descendants = workspaceTreeDescendants(input.rows, input.activeKey);
  if (input.activeKey === input.targetKey || descendants.has(input.targetKey)) return null;
  const byKey = new Map(input.rows.map((row) => [row.workspace.workspaceKey, row]));
  let anchor = target;
  let parentKey = target.parentKey;
  let depth = target.depth;
  if (input.position === "inside") {
    parentKey = target.workspace.workspaceKey;
    depth = target.depth + 1;
  } else {
    const naturalOffset = (target.depth - active.depth) * WORKSPACE_TREE_INDENT;
    const adjustedOffset = (input.horizontalOffset ?? naturalOffset) - naturalOffset;
    const outdent = Math.max(0, Math.round(-adjustedOffset / WORKSPACE_TREE_INDENT));
    for (let step = 0; step < outdent && anchor.parentKey; step++) {
      const parent = byKey.get(anchor.parentKey);
      if (!parent) break;
      anchor = parent;
    }
    parentKey = anchor.parentKey;
    depth = anchor.depth;
  }
  const parent = parentKey ? byKey.get(parentKey) : null;
  const parentWorkspaceId =
    parent?.workspace.workspaceId ?? anchor.workspace.parentWorkspaceId ?? null;
  const siblings = input.rows.filter(
    (row) =>
      (row.workspace.parentWorkspaceId ?? null) === parentWorkspaceId &&
      row.workspace.serverId === active.workspace.serverId &&
      row.workspace.workspaceKey !== input.activeKey,
  );
  let beforeWorkspaceId: string | null = null;
  if (input.position === "before") beforeWorkspaceId = anchor.workspace.workspaceId;
  if (input.position === "after") {
    const index = siblings.findIndex(
      (row) => row.workspace.workspaceKey === anchor.workspace.workspaceKey,
    );
    beforeWorkspaceId = siblings[index + 1]?.workspace.workspaceId ?? null;
  }
  return {
    targetKey: input.targetKey,
    position: input.position,
    depth,
    move: {
      serverId: active.workspace.serverId,
      workspaceId: active.workspace.workspaceId,
      parentWorkspaceId,
      beforeWorkspaceId,
    },
  };
}

export function workspaceTreeDropPosition(relativeY: number): WorkspaceTreeDrop["position"] {
  if (relativeY < 0.25) return "before";
  if (relativeY > 0.75) return "after";
  return "inside";
}
