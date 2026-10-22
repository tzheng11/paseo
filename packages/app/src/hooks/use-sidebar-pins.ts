import { useMemo, useRef } from "react";
import { shallow } from "zustand/shallow";
import { useStoreWithEqualityFn } from "zustand/traditional";
import type {
  SidebarProjectEntry,
  SidebarWorkspacePlacement,
} from "@/hooks/use-sidebar-workspaces-list";
import { applyStoredOrdering } from "@/hooks/sidebar-workspaces-view-model";
import { useSessionStore } from "@/stores/session-store";
import { flattenWorkspaceTree } from "@/components/sidebar/workspace-tree/model";
import {
  resolvePinnedWorkspaceTree,
  type PinnedWorkspaceTree,
  type PinnedWorkspaceSection,
} from "@/components/sidebar/workspace-tree/pinned-layout";

export interface PinnedSidebarKeys {
  pinnedWorkspaceKeys: string[];
  // workspaceKey -> pinnedAt ISO string, used to order by recency.
  pinnedAtByKey: Record<string, string>;
  superpinnedAtByKey: Record<string, string>;
}

export interface PinnedSidebarGroups {
  // Membership is explicit; a layout edge never pins or superpins another workspace.
  pinnedChats: SidebarWorkspacePlacement[];
  superpinnedChats: SidebarWorkspacePlacement[];
  // Everything else, with pinned chats removed. Feeds the draggable project list.
  unpinnedProjects: SidebarProjectEntry[];
}

/** Host-owned placements are authoritative, including an explicitly root-level pin. */
export function sharedPinnedWorkspaceTree(
  projects: readonly SidebarProjectEntry[],
): PinnedWorkspaceTree {
  return Object.fromEntries(
    projects.flatMap((project) =>
      project.workspaces.flatMap((workspace) =>
        workspace.pinPlacement ? [[workspace.workspaceKey, workspace.pinPlacement] as const] : [],
      ),
    ),
  );
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
  pinnedWorkspaceTree?: PinnedWorkspaceTree;
}): PinnedSidebarGroups {
  const { projects, keys, pinnedWorkspaceOrder } = input;
  if (keys.pinnedWorkspaceKeys.length === 0)
    return { pinnedChats: [], superpinnedChats: [], unpinnedProjects: projects };
  const workspaces = projects.flatMap((project) => project.workspaces);
  const superpinnedKeys = new Set(Object.keys(keys.superpinnedAtByKey));
  const pinnedKeys = new Set(keys.pinnedWorkspaceKeys);
  const superpinned = workspaces.filter((workspace) => superpinnedKeys.has(workspace.workspaceKey));
  const pinned = workspaces.filter(
    (workspace) =>
      pinnedKeys.has(workspace.workspaceKey) && !superpinnedKeys.has(workspace.workspaceKey),
  );
  superpinned.sort((a, b) => {
    const byTime =
      Date.parse(keys.superpinnedAtByKey[b.workspaceKey]!) -
      Date.parse(keys.superpinnedAtByKey[a.workspaceKey]!);
    return (
      byTime || a.serverId.localeCompare(b.serverId) || a.workspaceId.localeCompare(b.workspaceId)
    );
  });
  pinned.sort(
    (a, b) =>
      (keys.pinnedAtByKey[b.workspaceKey] ?? "").localeCompare(
        keys.pinnedAtByKey[a.workspaceKey] ?? "",
      ) || a.workspaceKey.localeCompare(b.workspaceKey),
  );
  const superRoots = applyStoredOrdering({
    items: superpinned,
    storedOrder: input.superpinnedWorkspaceOrder ?? [],
    getKey: (workspace) => workspace.workspaceKey,
  });
  const orderedRoots = applyStoredOrdering({
    items: pinned,
    storedOrder: pinnedWorkspaceOrder,
    getKey: (workspace) => workspace.workspaceKey,
  });
  const covered = new Set([...superpinned, ...pinned].map((workspace) => workspace.workspaceKey));
  return {
    superpinnedChats: projectPinnedTree({
      workspaces: superRoots,
      section: "superpinned",
      tree: input.pinnedWorkspaceTree,
    }),
    pinnedChats: projectPinnedTree({
      workspaces: orderedRoots,
      section: "pinned",
      tree: input.pinnedWorkspaceTree,
    }),
    unpinnedProjects: projects.map((project) => projectWithoutPinnedWorkspaces(project, covered)),
  };
}
interface PinnedTreeProjectionInput {
  workspaces: SidebarWorkspacePlacement[];
  section: PinnedWorkspaceSection;
  tree?: PinnedWorkspaceTree;
}
function projectPinnedTree({
  workspaces,
  section,
  tree = {},
}: PinnedTreeProjectionInput): SidebarWorkspacePlacement[] {
  const members = workspaces.map((workspace) =>
    Object.assign({}, workspace, { sidebarSection: section }),
  );
  const layout = resolvePinnedWorkspaceTree(members, tree);
  const projected = members.map((workspace) => {
    const placement = layout.get(workspace.workspaceKey)!;
    return Object.assign({}, workspace, {
      sidebarParentWorkspaceKey: placement.parentWorkspaceKey,
      siblingOrder: placement.siblingOrder,
    });
  });
  return flattenWorkspaceTree(projected, new Set()).map((row) => row.workspace);
}
