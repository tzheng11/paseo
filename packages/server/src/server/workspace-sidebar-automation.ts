import type {
  WorkspaceSidebarPlacement,
  WorkspaceSidebarSection,
} from "./workspace-pin-placement.js";

export interface SidebarAutomationWorkspace {
  workspaceKey: string;
  workspaceId: string;
  projectId?: string;
  parentWorkspaceId?: string | null;
  siblingOrder?: number;
  section: WorkspaceSidebarSection;
  pinnedAt?: string | null;
  superpinnedAt?: string | null;
  pinPlacement?: { parentWorkspaceKey: string | null; siblingOrder: number; revision: number };
}

/** Legacy hierarchy is project-scoped. Only real same-section children supply shared append ranks. */
export function resolveSidebarAutomationCatalog(
  workspaces: readonly SidebarAutomationWorkspace[],
): SidebarAutomationWorkspace[] {
  const byKey = new Map(workspaces.map((row) => [row.workspaceKey, row]));
  return workspaces.map((row) => {
    if (row.pinPlacement || !row.parentWorkspaceId) return row;
    const serverId = row.workspaceKey.slice(0, row.workspaceKey.indexOf(":"));
    const parentKey = `${serverId}:${row.parentWorkspaceId}`;
    const parent = byKey.get(parentKey);
    if (!parent || parent.projectId !== row.projectId || parent.section !== row.section) return row;
    return Object.assign({}, row, {
      pinPlacement: {
        parentWorkspaceKey: parentKey,
        siblingOrder: row.siblingOrder ?? 0,
        revision: 0,
      },
    });
  });
}

function validateSidebarAncestry(
  rows: ReadonlyMap<string, SidebarAutomationWorkspace>,
  parentKey: string | null,
  movingKey?: string,
) {
  const visited = new Set(movingKey ? [movingKey] : []);
  let ancestor = parentKey;
  while (ancestor !== null) {
    if (visited.has(ancestor)) throw new Error("A workspace cannot be its own parent or ancestor.");
    visited.add(ancestor);
    ancestor = rows.get(ancestor)?.pinPlacement?.parentWorkspaceKey ?? null;
  }
}

function resolveSiblingRank(
  siblings: readonly SidebarAutomationWorkspace[],
  order?: number,
  beforeKey?: string | null,
): number {
  if (beforeKey) {
    if (order !== undefined)
      throw new Error("Choose siblingOrder or beforeWorkspaceKey, not both.");
    const index = siblings.findIndex((row) => row.workspaceKey === beforeKey);
    if (index < 0)
      throw new Error("beforeWorkspaceKey must be a sibling in the destination section.");
    const next = siblings[index]!.pinPlacement?.siblingOrder ?? 0;
    const previous = index ? (siblings[index - 1]!.pinPlacement?.siblingOrder ?? 0) : next - 2048;
    order = previous + (next - previous) / 2;
    if (order === previous || order === next)
      throw new Error(
        "Sibling ranks are too close. Reorder these workspaces in Paseo before retrying.",
      );
  }
  order ??= Math.max(0, ...siblings.map((row) => row.pinPlacement?.siblingOrder ?? 0)) + 1024;
  if (!Number.isFinite(order)) throw new Error("Workspace order is out of range.");
  return order;
}

export function resolveSidebarAutomationPlacement(input: {
  workspaces: readonly SidebarAutomationWorkspace[];
  parentWorkspaceKey: string | null;
  section?: WorkspaceSidebarSection;
  siblingOrder?: number;
  beforeWorkspaceKey?: string | null;
  movingWorkspaceKey?: string;
}): WorkspaceSidebarPlacement & { siblingOrder: number } {
  const workspaces = resolveSidebarAutomationCatalog(input.workspaces);
  const rows = new Map(workspaces.map((row) => [row.workspaceKey, row]));
  const parent = input.parentWorkspaceKey === null ? undefined : rows.get(input.parentWorkspaceKey);
  if (
    input.parentWorkspaceKey !== null &&
    !parent &&
    (input.section === undefined || input.siblingOrder === undefined)
  )
    throw new Error(
      "Parent host is unavailable. Supply its saved section and siblingOrder, or connect that host before creating a child.",
    );
  const section = input.section ?? parent?.section ?? "unpinned";
  if (parent && input.section !== undefined && parent.section !== input.section)
    throw new Error("A child must use its parent workspace's section.");
  validateSidebarAncestry(rows, input.parentWorkspaceKey, input.movingWorkspaceKey);
  const siblings = workspaces
    .filter(
      (row) =>
        row.workspaceKey !== input.movingWorkspaceKey &&
        row.section === section &&
        (row.pinPlacement?.parentWorkspaceKey ?? null) === input.parentWorkspaceKey,
    )
    .sort(
      (a, b) =>
        (a.pinPlacement?.siblingOrder ?? 0) - (b.pinPlacement?.siblingOrder ?? 0) ||
        a.workspaceKey.localeCompare(b.workspaceKey),
    );
  return {
    parentWorkspaceKey: input.parentWorkspaceKey,
    siblingOrder: resolveSiblingRank(siblings, input.siblingOrder, input.beforeWorkspaceKey),
    section,
  };
}

export function sidebarAutomationSubtree(
  workspaces: readonly SidebarAutomationWorkspace[],
  rootKey: string,
): SidebarAutomationWorkspace[] {
  workspaces = resolveSidebarAutomationCatalog(workspaces);
  const keys = new Set([rootKey]);
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const row of workspaces) {
      if (
        !keys.has(row.workspaceKey) &&
        row.pinPlacement?.parentWorkspaceKey &&
        keys.has(row.pinPlacement.parentWorkspaceKey)
      ) {
        keys.add(row.workspaceKey);
        expanded = true;
      }
    }
  }
  return workspaces.filter((row) => keys.has(row.workspaceKey));
}
