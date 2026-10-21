import { useMemo, useRef } from "react";
import { shallow } from "zustand/shallow";
import { useStoreWithEqualityFn } from "zustand/traditional";
import type {
  SidebarProjectEntry,
  SidebarWorkspacePlacement,
} from "@/hooks/use-sidebar-workspaces-list";
import { applyStoredOrdering } from "@/hooks/sidebar-workspaces-view-model";
import { useSessionStore } from "@/stores/session-store";
import {
  compareWorkspaceSiblings,
  flattenWorkspaceTree,
} from "@/components/sidebar/workspace-tree/model";

export interface PinnedSidebarKeys {
  pinnedWorkspaceKeys: string[];
  // workspaceKey -> pinnedAt ISO string, used to order by recency.
  pinnedAtByKey: Record<string, string>;
  superpinnedAtByKey: Record<string, string>;
}

export interface PinnedSidebarGroups {
  // A pinned workspace carries its descendants into the same section.
  pinnedChats: SidebarWorkspacePlacement[];
  superpinnedChats: SidebarWorkspacePlacement[];
  // Everything else, with pinned chats removed. Feeds the draggable project list.
  unpinnedProjects: SidebarProjectEntry[];
}

function projectWithoutPinnedWorkspaces(
  project: SidebarProjectEntry,
  pinnedWorkspaceKeys: ReadonlySet<string>,
): SidebarProjectEntry {
  const workspaces = project.workspaces.filter(
    (workspace) => !pinnedWorkspaceKeys.has(workspace.workspaceKey),
  );
  // Keep the project even when every chat moved to Pinned. The project row owns
  // its settings and new-workspace actions; chats are not its ownership boundary.
  return workspaces.length === project.workspaces.length ? project : { ...project, workspaces };
}

export function buildPinnedSidebarKeys(
  projects: SidebarProjectEntry[],
  workspaceMaps: ReadonlyMap<
    string,
    ReadonlyMap<string, { pinnedAt?: string | null; superpinnedAt?: string | null }>
  >,
): PinnedSidebarKeys {
  const pinnedWorkspaceKeys: string[] = [];
  const pinnedAtByKey: Record<string, string> = {};
  const superpinnedAtByKey: Record<string, string> = {};

  for (const project of projects) {
    for (const placement of project.workspaces) {
      const workspace = workspaceMaps.get(placement.serverId)?.get(placement.workspaceId);
      if (workspace?.superpinnedAt) {
        superpinnedAtByKey[placement.workspaceKey] = workspace.superpinnedAt;
      }
      if (workspace?.pinnedAt || workspace?.superpinnedAt) {
        pinnedWorkspaceKeys.push(placement.workspaceKey);
        pinnedAtByKey[placement.workspaceKey] = workspace.pinnedAt ?? workspace.superpinnedAt!;
      }
    }
  }
  return { pinnedWorkspaceKeys, pinnedAtByKey, superpinnedAtByKey };
}

export function arePinnedSidebarKeysEqual(
  left: PinnedSidebarKeys,
  right: PinnedSidebarKeys,
): boolean {
  if (left.pinnedWorkspaceKeys.length !== right.pinnedWorkspaceKeys.length) {
    return false;
  }
  for (let index = 0; index < left.pinnedWorkspaceKeys.length; index += 1) {
    const workspaceKey = left.pinnedWorkspaceKeys[index];
    if (
      workspaceKey !== right.pinnedWorkspaceKeys[index] ||
      (workspaceKey &&
        (left.pinnedAtByKey[workspaceKey] !== right.pinnedAtByKey[workspaceKey] ||
          left.superpinnedAtByKey[workspaceKey] !== right.superpinnedAtByKey[workspaceKey]))
    ) {
      return false;
    }
  }
  return true;
}

export function usePinnedSidebarKeys(projects: SidebarProjectEntry[]): PinnedSidebarKeys {
  const previousKeysRef = useRef<PinnedSidebarKeys>({
    pinnedWorkspaceKeys: [],
    pinnedAtByKey: {},
    superpinnedAtByKey: {},
  });
  const serverIds = useMemo(
    () =>
      Array.from(
        new Set(
          projects.flatMap((project) => project.workspaces.map((workspace) => workspace.serverId)),
        ),
      ),
    [projects],
  );
  const workspaceMaps = useStoreWithEqualityFn(
    useSessionStore,
    (state) => serverIds.map((serverId) => state.sessions[serverId]?.workspaces ?? null),
    shallow,
  );
  return useMemo(() => {
    const workspaceMapByServerId = new Map<
      string,
      ReadonlyMap<string, { pinnedAt?: string | null; superpinnedAt?: string | null }>
    >();
    for (let index = 0; index < serverIds.length; index += 1) {
      const serverId = serverIds[index];
      const workspaceMap = workspaceMaps[index];
      if (serverId && workspaceMap) {
        workspaceMapByServerId.set(serverId, workspaceMap);
      }
    }
    const nextKeys = buildPinnedSidebarKeys(projects, workspaceMapByServerId);
    if (arePinnedSidebarKeysEqual(previousKeysRef.current, nextKeys)) {
      return previousKeysRef.current;
    }
    previousKeysRef.current = nextKeys;
    return nextKeys;
  }, [projects, serverIds, workspaceMaps]);
}

export function splitPinnedSidebarGroups(input: {
  projects: SidebarProjectEntry[];
  keys: PinnedSidebarKeys;
  pinnedWorkspaceOrder: string[];
  superpinnedWorkspaceOrder?: string[];
}): PinnedSidebarGroups {
  const { projects, keys, pinnedWorkspaceOrder } = input;
  if (keys.pinnedWorkspaceKeys.length === 0)
    return { pinnedChats: [], superpinnedChats: [], unpinnedProjects: projects };
  const workspaces = projects.flatMap((project) => project.workspaces);
  const superpinned = collectPinnedSubtrees(
    workspaces,
    new Set(Object.keys(keys.superpinnedAtByKey)),
  );
  const pinned = collectPinnedSubtrees(
    workspaces.filter((workspace) => !superpinned.covered.has(workspace.workspaceKey)),
    new Set(keys.pinnedWorkspaceKeys),
  );
  superpinned.roots.sort((a, b) => {
    const byTime =
      Date.parse(keys.superpinnedAtByKey[b.workspaceKey]!) -
      Date.parse(keys.superpinnedAtByKey[a.workspaceKey]!);
    return (
      byTime || a.serverId.localeCompare(b.serverId) || a.workspaceId.localeCompare(b.workspaceId)
    );
  });
  pinned.roots.sort((a, b) =>
    (keys.pinnedAtByKey[b.workspaceKey] ?? "").localeCompare(
      keys.pinnedAtByKey[a.workspaceKey] ?? "",
    ),
  );
  const superRoots = applyStoredOrdering({
    items: superpinned.roots,
    storedOrder: input.superpinnedWorkspaceOrder ?? [],
    getKey: (workspace) => workspace.workspaceKey,
  });
  const orderedRoots = applyStoredOrdering({
    items: pinned.roots,
    storedOrder: pinnedWorkspaceOrder,
    getKey: (workspace) => workspace.workspaceKey,
  });
  const covered = new Set([...superpinned.covered, ...pinned.covered]);
  return {
    superpinnedChats: superRoots.flatMap(
      (workspace) => superpinned.subtrees.get(workspace.workspaceKey)!,
    ),
    pinnedChats: rankPinnedSiblingRoots(orderedRoots).flatMap(
      (workspace) => pinned.subtrees.get(workspace.workspaceKey)!,
    ),
    unpinnedProjects: projects.map((project) => projectWithoutPinnedWorkspaces(project, covered)),
  };
}
function collectPinnedSubtrees(workspaces: SidebarWorkspacePlacement[], keys: ReadonlySet<string>) {
  const roots: SidebarWorkspacePlacement[] = [];
  const subtrees = new Map<string, SidebarWorkspacePlacement[]>();
  const covered = new Set<string>();
  let current: SidebarWorkspacePlacement | null = null;
  let depth = -1;
  for (const row of flattenWorkspaceTree(workspaces, new Set())) {
    if (row.depth <= depth) current = null;
    if (!current && keys.has(row.workspace.workspaceKey)) {
      current = row.workspace;
      depth = row.depth;
      roots.push(current);
      subtrees.set(current.workspaceKey, []);
    }
    if (!current) continue;
    subtrees.get(current.workspaceKey)!.push(row.workspace);
    covered.add(row.workspace.workspaceKey);
  }
  return { roots, subtrees, covered };
}
function rankPinnedSiblingRoots(roots: SidebarWorkspacePlacement[]): SidebarWorkspacePlacement[] {
  const groupKey = (workspace: SidebarWorkspacePlacement) =>
    JSON.stringify([
      workspace.serverId,
      workspace.projectViewKey,
      workspace.parentWorkspaceId ?? null,
    ]);
  const groups = new Map<string, SidebarWorkspacePlacement[]>();
  for (const root of roots) {
    const key = groupKey(root);
    const siblings = groups.get(key);
    if (siblings) siblings.push(root);
    else groups.set(key, [root]);
  }
  for (const siblings of groups.values()) siblings.sort(compareWorkspaceSiblings);
  const offsets = new Map<string, number>();
  return roots.map((root) => {
    const key = groupKey(root);
    const index = offsets.get(key) ?? 0;
    offsets.set(key, index + 1);
    return groups.get(key)![index]!;
  });
}
