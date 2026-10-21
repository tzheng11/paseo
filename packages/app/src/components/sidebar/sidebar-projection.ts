import type { TFunction } from "i18next";
import { buildStatusGroups } from "@/hooks/sidebar-status-view-model";
import {
  splitPinnedSidebarGroups,
  type PinnedSidebarGroups,
  type PinnedSidebarKeys,
} from "@/hooks/use-sidebar-pins";
import type {
  SidebarProjectEntry,
  SidebarWorkspaceEntry,
} from "@/hooks/use-sidebar-workspaces-list";
import type { SidebarGroupMode } from "@/stores/sidebar-view-store";
import type { PinnedWorkspaceSortMode } from "@/stores/sidebar-order-store";
import type { WorkspaceTitleSource } from "@/hooks/use-settings";
import { sortSidebarWorkspaces, type SidebarWorkspaceSortMode } from "./workspace-sort";
import {
  resolveSidebarProjectIconTargets,
  type SidebarProjectIconTarget,
} from "@/utils/sidebar-project-row-model";
import {
  buildSidebarShortcutSections,
  type SidebarShortcutModel,
  type SidebarShortcutSection,
} from "@/utils/sidebar-shortcuts";
import { statusWorkspaceGroups, type SidebarWorkspaceGroup } from "./sidebar-labels";
import { flattenWorkspaceTree } from "./workspace-tree/model";

export interface SidebarProjection {
  pinnedGroups: PinnedSidebarGroups;
  workspaceGroups: SidebarWorkspaceGroup[];
  /**
   * The project icons this projection needs fetched, keyed by `projectViewKey` — one per project,
   * whatever the mode groups by. It sits here rather than beside `useProjectIcons` in the list
   * because it is the same `projects` the rows above are projected from: a mode that renders a
   * row can only ever ask for an icon this list already covers. It used to be derived in the
   * list, under a `groupMode === "status"` gate written when status was the only mode that put
   * icons on rows.
   */
  projectIconTargets: SidebarProjectIconTarget[];
  shortcutModel: SidebarShortcutModel;
}

export interface SidebarProjectionInput {
  projects: SidebarProjectEntry[];
  pinnedKeys: PinnedSidebarKeys;
  pinnedWorkspaceOrder: string[];
  superpinnedWorkspaceOrder?: string[];
  pinnedWorkspaceSortMode?: PinnedWorkspaceSortMode;
  workspaceTitleSource?: WorkspaceTitleSource;
  workspaceSortModeByProject?: Readonly<Record<string, SidebarWorkspaceSortMode>>;
  workspaceEntriesByKey: ReadonlyMap<string, SidebarWorkspaceEntry>;
  projectNamesByViewKey: Map<string, string>;
  groupMode: SidebarGroupMode;
  pinnedCollapsed: boolean;
  collapsedProjectKeys: ReadonlySet<string>;
  collapsedWorkspaceGroupKeys: ReadonlySet<string>;
  collapsedWorkspaceKeys?: ReadonlySet<string>;
  t: TFunction;
}

export function buildSidebarProjection(input: SidebarProjectionInput): SidebarProjection {
  const pinnedGroups = splitPinnedSidebarGroups({
    projects: input.projects,
    keys: input.pinnedKeys,
    pinnedWorkspaceOrder: input.pinnedWorkspaceOrder,
    superpinnedWorkspaceOrder: input.superpinnedWorkspaceOrder,
  });
  pinnedGroups.pinnedChats = sortSidebarWorkspaces({
    workspaces: pinnedGroups.pinnedChats,
    mode: input.pinnedWorkspaceSortMode ?? "manual",
    workspaceTitleSource: input.workspaceTitleSource ?? "title",
    workspaceEntriesByKey: input.workspaceEntriesByKey,
  });
  pinnedGroups.unpinnedProjects = pinnedGroups.unpinnedProjects.map((project) => {
    const mode = input.workspaceSortModeByProject?.[project.viewKey] ?? "manual";
    if (mode === "manual") return project;
    return {
      ...project,
      workspaces: sortSidebarWorkspaces({
        workspaces: project.workspaces,
        mode,
        workspaceTitleSource: input.workspaceTitleSource ?? "title",
        workspaceEntriesByKey: input.workspaceEntriesByKey,
      }),
    };
  });
  const pinnedWorkspaceKeys = new Set(
    [...pinnedGroups.superpinnedChats, ...pinnedGroups.pinnedChats].map(
      (workspace) => workspace.workspaceKey,
    ),
  );
  const unpinnedWorkspaces = Array.from(input.workspaceEntriesByKey.values()).filter(
    (workspace) => !pinnedWorkspaceKeys.has(workspace.workspaceKey),
  );
  // One switch decides both what the list groups by and what the keyboard shortcuts walk, so the
  // two cannot disagree and a new grouping mode is a compile error here rather than a silent
  // fall-through to the project rows.
  const workspaceGroups = buildWorkspaceGroups(input, unpinnedWorkspaces);

  const sections: SidebarShortcutSection[] = [];
  const collapsedWorkspaces = input.collapsedWorkspaceKeys ?? new Set<string>();
  if (!input.collapsedWorkspaceGroupKeys.has("section:superpinned"))
    sections.push({
      workspaces: flattenWorkspaceTree(pinnedGroups.superpinnedChats, collapsedWorkspaces).map(
        (row) => row.workspace,
      ),
    });
  if (!input.pinnedCollapsed) {
    const workspaces = flattenWorkspaceTree(
      pinnedGroups.pinnedChats,
      collapsedWorkspaces,
      (input.pinnedWorkspaceSortMode ?? "manual") === "manual",
    ).map((row) => row.workspace);
    sections.push({ workspaces });
  }
  if (input.groupMode === "project") {
    sections.push(
      ...pinnedGroups.unpinnedProjects.map((project) => ({
        workspaces: flattenWorkspaceTree(
          project.workspaces,
          collapsedWorkspaces,
          (input.workspaceSortModeByProject?.[project.viewKey] ?? "manual") === "manual",
        ).map((row) => row.workspace),
        collapsed: input.collapsedProjectKeys.has(project.viewKey),
      })),
    );
  } else {
    sections.push(
      ...workspaceGroups.map((group) => ({
        workspaces: group.rows,
        collapsed: input.collapsedWorkspaceGroupKeys.has(group.key),
      })),
    );
  }

  return {
    pinnedGroups,
    workspaceGroups,
    projectIconTargets: resolveSidebarProjectIconTargets(input.projects),
    shortcutModel: buildSidebarShortcutSections({ sections }),
  };
}

/** Project mode keeps its project headers and groups nothing; status mode groups the rows. */
function buildWorkspaceGroups(
  input: SidebarProjectionInput,
  unpinnedWorkspaces: SidebarWorkspaceEntry[],
): SidebarWorkspaceGroup[] {
  switch (input.groupMode) {
    case "project":
      return [];
    case "status":
      return statusWorkspaceGroups(
        buildStatusGroups(unpinnedWorkspaces, input.projectNamesByViewKey, input.t),
      );
  }
}
