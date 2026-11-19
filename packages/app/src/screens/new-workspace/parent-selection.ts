import type { SidebarWorkspaceEntry } from "@/hooks/sidebar-workspaces-view-model";
import { resolvePinnedWorkspaceTree } from "@/components/sidebar/workspace-tree/pinned-layout";

export type WorkspaceParentEntry = Pick<
  SidebarWorkspaceEntry,
  | "workspaceKey"
  | "workspaceId"
  | "projectViewKey"
  | "parentWorkspaceId"
  | "siblingOrder"
  | "name"
  | "projectName"
  | "serverId"
  | "background"
  | "archivingAt"
  | "pinnedAt"
  | "superpinnedAt"
  | "pinPlacement"
>;

export type WorkspaceSidebarSection = "unpinned" | "pinned" | "superpinned";

export function workspaceSidebarSection(workspace: WorkspaceParentEntry): WorkspaceSidebarSection {
  if (workspace.superpinnedAt) return "superpinned";
  if (workspace.pinnedAt) return "pinned";
  return "unpinned";
}

function workspaceParentLayout(workspaces: readonly WorkspaceParentEntry[]) {
  const tree = Object.fromEntries(
    workspaces.flatMap((entry) =>
      entry.pinPlacement ? [[entry.workspaceKey, entry.pinPlacement] as const] : [],
    ),
  );
  return resolvePinnedWorkspaceTree(
    workspaces.map((entry) => ({
      ...entry,
      sidebarSection: workspaceSidebarSection(entry),
    })),
    tree,
  );
}

export interface WorkspaceParentSelection {
  workspaceKey: string | null;
  display: string | null;
}

/** A new draft owns its selection; catalog refreshes only resolve an unopened route seed. */
export function openWorkspaceParentSelection(parentWorkspaceKey?: string) {
  let state: WorkspaceParentSelection = {
    workspaceKey: parentWorkspaceKey?.trim() || null,
    display: null,
  };
  const listeners = new Set<() => void>();
  function publish(next: WorkspaceParentSelection) {
    state = next;
    listeners.forEach((listener) => listener());
  }
  return {
    getState: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    applyCatalog(entries: readonly WorkspaceParentEntry[]) {
      if (!state.workspaceKey || state.display !== null) return;
      const selected = entries.find((entry) => entry.workspaceKey === state.workspaceKey);
      if (selected) publish({ ...state, display: selected.name });
    },
    select(entry: WorkspaceParentEntry | null) {
      publish({ workspaceKey: entry?.workspaceKey ?? null, display: entry?.name ?? null });
    },
    close() {
      listeners.clear();
    },
  };
}

export function buildChildWorkspacePlacement(input: {
  parentWorkspaceKey: string | null;
  workspaces: readonly WorkspaceParentEntry[];
}):
  | {
      parentWorkspaceKey: string;
      siblingOrder: number;
      section: WorkspaceSidebarSection;
    }
  | undefined {
  if (!input.parentWorkspaceKey) return undefined;
  const parent = input.workspaces.find((entry) => entry.workspaceKey === input.parentWorkspaceKey);
  if (!parent || parent.archivingAt || parent.background) {
    throw new Error("Parent workspace is no longer available");
  }
  const section = workspaceSidebarSection(parent);
  const layout = workspaceParentLayout(input.workspaces);
  let lastOrder = 0;
  for (const workspace of input.workspaces) {
    if (workspace.archivingAt || workspaceSidebarSection(workspace) !== section) continue;
    const placement = layout.get(workspace.workspaceKey);
    if (placement?.parentWorkspaceKey === input.parentWorkspaceKey) {
      lastOrder = Math.max(lastOrder, placement.siblingOrder);
    }
  }
  return { parentWorkspaceKey: input.parentWorkspaceKey, siblingOrder: lastOrder + 1024, section };
}

export function workspaceParentRevealKeys(input: {
  parentWorkspaceKey: string;
  section: WorkspaceSidebarSection;
  workspaces: readonly WorkspaceParentEntry[];
}): ReadonlySet<string> {
  const byKey = new Map(input.workspaces.map((entry) => [entry.workspaceKey, entry]));
  const layout = workspaceParentLayout(input.workspaces);
  const keys = new Set<string>();
  let parentKey: string | null = input.parentWorkspaceKey;
  while (parentKey !== null && !keys.has(parentKey)) {
    const parent = byKey.get(parentKey);
    if (!parent || workspaceSidebarSection(parent) !== input.section) break;
    keys.add(parentKey);
    parentKey = layout.get(parentKey)?.parentWorkspaceKey ?? null;
  }
  return keys;
}
